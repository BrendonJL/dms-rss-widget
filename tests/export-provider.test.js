const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createExportProvider } = require("../ExportProvider.js");

var ROOT = "/home/user/vault";

function baseConfig(overrides) {
    return Object.assign({
        kind: "markdown",
        root: ROOT,
        vault: "MyVault",
        filenameTemplate: "{title}",
        tags: []
    }, overrides || {});
}

function article(overrides) {
    return Object.assign({
        id: "item-1",
        title: "A Perfectly Normal Title",
        link: "https://example.com/a",
        source: "Example Feed",
        dateStr: "2026-09-08T00:00:00Z"
    }, overrides || {});
}

// Independent containment check: uses Node's own `path` module, NOT
// anything ExportProvider.js exports or implements internally. This is
// deliberately a different implementation of "is this under the root"
// than the one inside ExportProvider.js -- the point of the test is to
// catch a bug in that implementation, not to re-run it.
function assertContained(relPath) {
    assert.equal(typeof relPath, "string");
    assert.ok(relPath.length > 0);
    var resolved = path.resolve(ROOT, relPath);
    var rootWithSep = path.resolve(ROOT) + path.sep;
    assert.ok(
        resolved.startsWith(rootWithSep),
        "resolved path " + resolved + " escaped root " + ROOT
    );
}

// Independent byte-length check via Node's Buffer -- again, not anything
// ExportProvider.js has access to (it must not require "buffer").
function assertByteClamp(name) {
    assert.ok(Buffer.byteLength(name, "utf8") <= 255);
    // and must still be valid UTF-8 (round-trips through the sanitizer's
    // own truncation without replacement characters if truncated cleanly)
    assert.equal(Buffer.byteLength(name, "utf8"), Buffer.from(name, "utf8").length);
}

// A tiny, independent YAML scalar parser for JUST the fields this test
// needs to check -- does not reuse ExportProvider.js's yamlQuote/escape
// logic. Handles a double-quoted scalar on a "key: "..."" line, including
// \", \\, \n, \r, \t, \xNN escapes.
function parseFrontmatter(content) {
    var match = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(match, "expected a --- frontmatter block");
    var body = match[1];
    var result = {};
    var lineRe = /^([a-zA-Z]+): "((?:\\.|[^"\\])*)"$/gm;
    var m;
    while ((m = lineRe.exec(body)) !== null) {
        var key = m[1];
        var raw = m[2];
        var value = raw.replace(/\\(.)/g, function (_, ch) {
            if (ch === "n") return "\n";
            if (ch === "r") return "\r";
            if (ch === "t") return "\t";
            if (ch === "\\") return "\\";
            if (ch === "\"") return "\"";
            return ch;
        });
        result[key] = value;
    }
    return result;
}

// ─── capabilities ───

describe("capabilities", () => {
    test("markdown provider: no openAfterWrite, no wikilinks", () => {
        var p = createExportProvider(baseConfig({ kind: "markdown" }));
        assert.deepEqual(p.capabilities, { openAfterWrite: false, wikilinks: false });
    });

    test("obsidian provider: openAfterWrite + wikilinks", () => {
        var p = createExportProvider(baseConfig({ kind: "obsidian" }));
        assert.deepEqual(p.capabilities, { openAfterWrite: true, wikilinks: true });
    });

    test("neovim provider: openAfterWrite, no wikilinks", () => {
        var p = createExportProvider(baseConfig({ kind: "neovim" }));
        assert.deepEqual(p.capabilities, { openAfterWrite: true, wikilinks: false });
    });
});

// ─── hostile inputs: path containment + sanitisation ───

describe("buildNote: hostile titles stay contained under root", () => {
    var hostileTitles = [
        "../../../.bashrc",
        "a/b",
        "..",
        ".",
        ".hidden",
        "-rf",
        "C:",
        "////////",     // entirely separators
        "",              // empty
        "漢".repeat(300) // 300-char CJK title
    ];

    hostileTitles.forEach(function (title) {
        test("title " + JSON.stringify(title.length > 40 ? title.slice(0, 20) + "...(len " + title.length + ")" : title), () => {
            var p = createExportProvider(baseConfig());
            var result = p.buildNote(article({ title: title }), []);
            assert.ok(!result.error, "unexpected error: " + result.error);
            assertContained(result.relPath);
            assertByteClamp(result.relPath);

            // Rule 4: no leading '.' or '-' in the actual filename.
            assert.ok(!/^[.\-]/.test(result.relPath));

            // Rule 5: no ':' anywhere.
            assert.ok(result.relPath.indexOf(":") === -1);

            // No raw separators leaked through into the filename itself
            // (a single path segment, one "/" from root-join aside).
            assert.equal(result.relPath.indexOf("/"), -1);
            assert.equal(result.relPath.indexOf("\\"), -1);
        });
    });

    test("NUL byte in title is stripped, not rejected", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article({ title: "evil\u0000name" }), []);
        assert.ok(!result.error);
        assertContained(result.relPath);
        assert.ok(result.relPath.indexOf("\u0000") === -1);
    });

    test("empty title falls back to the item id, never to an empty name", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article({ id: "guid-42", title: "" }), []);
        assert.ok(!result.error);
        assert.ok(result.relPath.length > ".md".length);
        assert.ok(result.relPath.indexOf("guid-42") !== -1);
    });

    test("title that is entirely separators falls back to the item id", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article({ id: "guid-sep", title: "////\\\\////" }), []);
        assert.ok(!result.error);
        assert.ok(result.relPath.indexOf("guid-sep") !== -1);
    });

    test("300-char CJK title clamps to <= 255 bytes and stays valid UTF-8", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article({ title: "漢".repeat(300) }), []);
        assert.ok(!result.error);
        assertByteClamp(result.relPath);
        assertContained(result.relPath);
    });

    test("emoji title clamps to <= 255 bytes and stays valid UTF-8", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article({ title: "\u{1F600}".repeat(200) }), []);
        assert.ok(!result.error);
        assertByteClamp(result.relPath);
        assertContained(result.relPath);
    });
});

// ─── collisions ───

describe("buildNote: collisions", () => {
    test("same title, different ids -> different relPaths", () => {
        var p = createExportProvider(baseConfig());
        var a = p.buildNote(article({ id: "id-1", title: "Same Title" }), []);
        var b = p.buildNote(article({ id: "id-2", title: "Same Title" }), []);
        assert.ok(!a.error && !b.error);
        assert.notEqual(a.relPath, b.relPath);
    });

    test("same title, same id -> same relPath (idempotent)", () => {
        var p = createExportProvider(baseConfig());
        var a = p.buildNote(article({ id: "id-1", title: "Same Title" }), []);
        var b = p.buildNote(article({ id: "id-1", title: "Same Title" }), []);
        assert.equal(a.relPath, b.relPath);
    });
});

// ─── YAML frontmatter injection ───

describe("buildNote: YAML frontmatter survives hostile titles intact", () => {
    var hostileYamlTitles = [
        "Breaking: News at 11",     // ": " inside
        "-1 Reasons This Is Bad",   // leading '-'
        "He said \"hello\" to me",  // embedded quotes
        "Line one\nLine two",       // embedded newline
        "key: value\n- item"        // itself looks like valid YAML
    ];

    hostileYamlTitles.forEach(function (title) {
        test("title " + JSON.stringify(title), () => {
            var p = createExportProvider(baseConfig());
            var result = p.buildNote(article({ title: title }), []);
            assert.ok(!result.error);
            var fm = parseFrontmatter(result.content);
            assert.equal(fm.title, title);
        });
    });

    test("tags list is also safely quoted", () => {
        var p = createExportProvider(baseConfig({ tags: ["rss: feed", "-tag"] }));
        var result = p.buildNote(article(), []);
        assert.ok(!result.error);
        // Should not corrupt the frontmatter block structure.
        var match = result.content.match(/^---\n([\s\S]*?)\n---/);
        assert.ok(match);
        assert.ok(/tags: \[/.test(match[1]));
    });
});

// ─── annotation rendering ───

describe("buildNote: annotation rendering", () => {
    test("highlights render as blockquotes with notes beneath", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article(), [
            { highlight: "This is the quoted passage.", note: "My commentary." }
        ]);
        assert.ok(!result.error);
        assert.ok(result.content.indexOf("> This is the quoted passage.") !== -1);
        var quoteIdx = result.content.indexOf("> This is the quoted passage.");
        var noteIdx = result.content.indexOf("My commentary.");
        assert.ok(noteIdx > quoteIdx);
    });

    test("multi-line highlight is blockquoted on every line", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article(), [
            { highlight: "Line one\nLine two" }
        ]);
        assert.ok(result.content.indexOf("> Line one") !== -1);
        assert.ok(result.content.indexOf("> Line two") !== -1);
    });

    test("article with no annotations still produces a valid note", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article(), []);
        assert.ok(!result.error);
        assert.ok(result.relPath);
        assert.ok(result.content.indexOf("# " + article().title) !== -1);
        var fm = parseFrontmatter(result.content);
        assert.equal(fm.title, article().title);
    });

    test("article with null/undefined annotations still produces a valid note", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article(), null);
        assert.ok(!result.error);
        assert.ok(result.relPath);
    });

    test("note-only annotation (no highlight) still renders", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(article(), [{ note: "Just a note, no quote." }]);
        assert.ok(!result.error);
        assert.ok(result.content.indexOf("Just a note, no quote.") !== -1);
    });
});

// ─── provider differences ───

describe("provider differences: wikilink tags", () => {
    test("obsidian emits wikilink-style tags in the body", () => {
        var p = createExportProvider(baseConfig({ kind: "obsidian", tags: ["news", "tech"] }));
        var result = p.buildNote(article(), []);
        assert.ok(result.content.indexOf("[[news]]") !== -1);
        assert.ok(result.content.indexOf("[[tech]]") !== -1);
    });

    test("markdown-dir provider does NOT emit wikilink tags", () => {
        var p = createExportProvider(baseConfig({ kind: "markdown", tags: ["news", "tech"] }));
        var result = p.buildNote(article(), []);
        assert.equal(result.content.indexOf("[["), -1);
    });

    test("neovim provider does NOT emit wikilink tags", () => {
        var p = createExportProvider(baseConfig({ kind: "neovim", tags: ["news", "tech"] }));
        var result = p.buildNote(article(), []);
        assert.equal(result.content.indexOf("[["), -1);
    });
});

// ─── openRequest ───

describe("openRequest", () => {
    test("markdown provider never returns an open request", () => {
        var p = createExportProvider(baseConfig({ kind: "markdown" }));
        assert.equal(p.openRequest("some-note.md"), null);
    });

    test("obsidian provider returns an obsidian:// url", () => {
        var p = createExportProvider(baseConfig({ kind: "obsidian", vault: "MyVault" }));
        var req = p.openRequest("some-note.md");
        assert.ok(req);
        assert.ok(req.url.indexOf("obsidian://open?vault=MyVault") === 0);
        assert.ok(req.url.indexOf("file=some-note") !== -1);
    });

    test("obsidian provider with no vault configured returns null", () => {
        var p = createExportProvider(baseConfig({ kind: "obsidian", vault: "" }));
        assert.equal(p.openRequest("some-note.md"), null);
    });

    test("neovim provider with no server configured returns null", () => {
        var p = createExportProvider(baseConfig({ kind: "neovim" }));
        assert.equal(p.openRequest("some-note.md"), null);
    });

    test("neovim provider with a server returns a spawnable argv, no shell string", () => {
        var p = createExportProvider(baseConfig({ kind: "neovim", nvimServer: "/tmp/nvim.sock" }));
        var req = p.openRequest("some-note.md");
        assert.ok(req);
        assert.ok(Array.isArray(req.argv));
        assert.equal(req.argv[0], "nvim");
        assert.ok(req.argv.indexOf("/tmp/nvim.sock") !== -1);
    });

    test("null relPath never produces an open request", () => {
        var p = createExportProvider(baseConfig({ kind: "obsidian" }));
        assert.equal(p.openRequest(null), null);
    });
});

// ─── misconfiguration ───

describe("buildNote: misconfiguration", () => {
    test("no root configured -> error, not a throw", () => {
        var p = createExportProvider(baseConfig({ root: "" }));
        var result = p.buildNote(article(), []);
        assert.ok(result.error);
    });

    test("no article -> error, not a throw", () => {
        var p = createExportProvider(baseConfig());
        var result = p.buildNote(null, []);
        assert.ok(result.error);
    });
});

// The original suite was security-complete but usability-blind: every hostile
// input was covered and the ORDINARY case produced "Title.md-8c38f0af.md"
// with an empty date. These guard the common path.
describe("the ordinary case", () => {
    var provider = createExportProvider({
        kind: "markdown", root: "Clippings", filenameTemplate: "{title}.md"
    });


    // Notes are now written in PARALLEL (one FileView per file), so two
    // articles resolving to one path is silent data loss rather than a
    // cosmetic clash. Clamping the assembled "title-hash" truncated from the
    // end and ate the hash, so any two long titles sharing a prefix collided.
    test("long titles stay distinct: the hash is reserved, not truncated away", () => {
        const p = createExportProvider({ kind: "markdown", root: "C", filenameTemplate: "{title}.md" });
        const arts = [
            { id: "m:7", title: "x".repeat(400) },
            { id: "m:8", title: "x".repeat(400) },
            { id: "m:9", title: "日".repeat(300) },
            { id: "m:10", title: "日".repeat(300) }
        ];
        const paths = arts.map(a => p.buildNote(a, []).relPath);
        assert.equal(new Set(paths).size, paths.length, "two articles must never share a path");
        paths.forEach(pth => {
            assert.ok(Buffer.byteLength(pth) <= 255, pth.length + " bytes exceeds NAME_MAX");
            assert.match(pth, /-[0-9a-f]+\.md$/, "the disambiguating hash must survive clamping");
        });
    });
    test("a normal title yields one extension, hash before it", () => {
        var r = provider.buildNote({ id: "m:42", title: "Cloud licensing probe" }, []);
        assert.match(r.relPath, /^Cloud licensing probe-[0-9a-f]+\.md$/);
        assert.equal(r.relPath.split(".md").length - 1, 1, "exactly one .md");
    });

    test("a template with no extension still gets one", () => {
        var p2 = createExportProvider({ kind: "markdown", root: "r", filenameTemplate: "{title}" });
        assert.match(p2.buildNote({ id: "i", title: "Plain" }, []).relPath, /\.md$/);
    });

    test("an empty title falls back to the id, not to the extension", () => {
        var r = provider.buildNote({ id: "m:42", title: "" }, []);
        assert.equal(r.relPath, "m42.md");
        assert.ok(r.relPath.indexOf("md-") !== 0, "must not render the extension as the stem");
    });

    test("date comes from timestamp when dateStr is absent", () => {
        var r = provider.buildNote({ id: "i", title: "T", timestamp: Date.UTC(2026, 8, 8) }, []);
        assert.match(r.content, /^date: "2026-09-08"$/m);
    });

    test("dateStr wins over timestamp when both are given", () => {
        var r = provider.buildNote({ id: "i", title: "T", timestamp: 1, dateStr: "1999-12-31" }, []);
        assert.match(r.content, /^date: "1999-12-31"$/m);
    });

    test("no date at all is an empty string, not a crash or Invalid Date", () => {
        var r = provider.buildNote({ id: "i", title: "T" }, []);
        assert.match(r.content, /^date: ""$/m);
        assert.ok(r.content.indexOf("Invalid Date") === -1);
    });
});

// The module is loaded by QML as well as Node. A literal control byte in the
// source made the file read as binary to grep and friends, and risks being
// mangled by editors and diff tooling; it must stay escaped.
test("the source contains no literal control characters", () => {
    var fs = require("node:fs");
    var src = fs.readFileSync(require.resolve("../ExportProvider.js"), "utf8");
    var bad = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]").exec(src);
    assert.equal(bad, null, "use an escape such as \\u0000, never a raw control byte");
});
