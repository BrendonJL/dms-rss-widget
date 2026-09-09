// Export provider interface for the Dank RSS Widget (Phase 4, stage 4a).
//
// Shared, like Backends.js/AiProvider.js, between QML and the Node test
// suite:
//   QML  : import "ExportProvider.js" as ExportProvider
//   Node : require("./ExportProvider.js")
//
// IMPORTANT: no `.pragma library` line here -- it is invalid JavaScript and
// would break `require()` in the tests. See
// docs/plans/2026-09-08-phase4-export-provider-design.md.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness, and -- unlike the Node test file that exercises it -- no
// `require("path")` / `require("buffer")` either, because this file also
// has to run unmodified inside QML's JS engine. Byte-clamping and
// containment checks below are hand-rolled string operations for exactly
// that reason.
//
// THE SECURITY PROBLEM THIS FILE EXISTS TO SOLVE: feed content is
// untrusted, attacker-controlled input, and buildNote() turns it into a
// filesystem path. An article title is chosen by whoever runs the feed --
// "../../../.bashrc" is a legal RSS <title>. See the design doc's security
// section for the full rule list; each rule below is tagged with its
// number from that section.

// ─── byte-safe string helpers (no Buffer available here) ───

// UTF-8 byte length of a single Unicode code point.
function utf8BytesForCodePoint(cp) {
    if (cp <= 0x7F) return 1;
    if (cp <= 0x7FF) return 2;
    if (cp <= 0xFFFF) return 3;
    return 4;
}

// Rule 6: clamp to N BYTES, not characters, truncating on a code-point
// boundary so the result stays valid UTF-8. Walks by codePointAt so
// surrogate pairs (emoji, astral CJK) are never split.
function clampUtf8Bytes(s, maxBytes) {
    if (maxBytes <= 0) return "";
    var out = "";
    var bytes = 0;
    var i = 0;
    while (i < s.length) {
        var cp = s.codePointAt(i);
        var units = cp > 0xFFFF ? 2 : 1;
        var chunkBytes = utf8BytesForCodePoint(cp);
        if (bytes + chunkBytes > maxBytes) break;
        out += s.substr(i, units);
        bytes += chunkBytes;
        i += units;
    }
    return out;
}

// Deterministic, pure 32-bit FNV-1a hash (hex string) used ONLY to
// disambiguate filename collisions -- not a security primitive, just a
// stable per-id suffix computed without I/O or randomness.
function fnv1aHex(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

// ─── path segment sanitisation (design doc rules 2, 3, 4, 5, 6) ───
//
// This produces a single flat filename component -- there is no template
// syntax for subdirectories, so "strip separators" always means "delete
// them", never "treat as a directory boundary".
function sanitizeSegment(raw) {
    var s = (raw === null || raw === undefined) ? "" : String(raw);

    // Rule 2: strip NUL and path separators from the templated value.
    // Stripped, not rejected -- a hostile feed should produce a safe note,
    // not a broken one.
    s = s.replace(/\u0000/g, "");
    s = s.replace(/[\/\\]/g, "");

    // Rule 5: strip ':' -- breaks on other filesystems, meaningful on some
    // (drive letters, NTFS alternate data streams).
    s = s.replace(/:/g, "");

    // Rule 3: reject/rewrite '.' and '..' as WHOLE components. Checked
    // after separator-stripping collapses any "../../.." into one string,
    // but before the leading-dot strip below, since "." and ".." are
    // entirely dots and would otherwise be silently emptied by that step
    // anyway -- this branch just makes the intent explicit.
    if (s === "." || s === "..") s = "";

    // Rule 4: no leading '.' (hidden files) or '-' (argument injection if
    // this ever reaches a command line). Strip repeatedly, not reject.
    s = s.replace(/^[.\-]+/, "");

    return s;
}

// Rule 1: verify containment, do not assume sanitising was sufficient.
// Runs on the FINAL assembled relPath as an independent re-check -- pure
// string/array operations, no path module. A relPath that fails this is
// refused outright (buildNote returns {error}) rather than "fixed" again,
// because reaching this point at all means sanitizeSegment has a bug.
function isRelPathContained(relPath) {
    if (!relPath || typeof relPath !== "string") return false;
    if (relPath.charAt(0) === "/" || relPath.charAt(0) === "\\") return false;
    var segments = relPath.split(/[\/\\]/);
    for (var i = 0; i < segments.length; i++) {
        var seg = segments[i];
        if (seg === "" || seg === "." || seg === "..") return false;
    }
    return true;
}

// Rule 6 applied to a base name + fixed extension: clamp the WHOLE
// filename (basename + extension) to maxBytes, since that is what
// NAME_MAX actually limits.
function clampFilenameBytes(base, ext, maxBytes) {
    var extBytes = ext.length; // ext is plain ASCII ("." + letters)
    var available = maxBytes - extBytes;
    var clampedBase = clampUtf8Bytes(base, available);
    return clampedBase + ext;
}

// ─── filename template ───
//
// Only a small, known set of placeholders is substituted. The template
// itself comes from local config (trusted); only the substituted VALUES
// are attacker-controlled, and the whole assembled string is run through
// sanitizeSegment() below regardless.
function interpolateTemplate(template, article) {
    var t = String(template || "{title}");
    t = t.replace(/\{title\}/g, function () { return (article && article.title) || ""; });
    t = t.replace(/\{id\}/g, function () { return (article && article.id) || ""; });
    t = t.replace(/\{source\}/g, function () { return (article && article.source) || ""; });
    return t;
}

// ─── YAML frontmatter (second injection surface) ───
//
// Every templated value is emitted as a double-quoted YAML scalar, never
// concatenated raw. Double-quoted style is immune to the whole class of
// "starts with -/[/{/&/*/!/|/>/#/%" and "contains : " problems the design
// doc calls out, because the quotes make the parser treat the content as
// an opaque string no matter what's inside -- the only characters that
// need escaping inside a double-quoted YAML scalar are backslash, the
// closing quote, and control characters (newlines included, since a raw
// newline would end the flow scalar's line).
function yamlQuote(value) {
    var s = (value === null || value === undefined) ? "" : String(value);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        var code = s.charCodeAt(i);
        if (ch === "\\") out += "\\\\";
        else if (ch === "\"") out += "\\\"";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (code < 0x20) out += "\\x" + ("0" + code.toString(16)).slice(-2);
        else out += ch;
    }
    return "\"" + out + "\"";
}

function buildFrontmatter(article, config) {
    var tags = (config && config.tags) || [];
    var tagStrs = [];
    for (var i = 0; i < tags.length; i++) tagStrs.push(yamlQuote(tags[i]));

    var lines = [
        "---",
        "title: " + yamlQuote((article && article.title) || ""),
        "source: " + yamlQuote((article && article.source) || ""),
        "link: " + yamlQuote((article && article.link) || ""),
        "date: " + yamlQuote(articleDate(article)),
        "tags: [" + tagStrs.join(", ") + "]",
        "---"
    ];
    return lines.join("\n");
}

// ─── body / annotation rendering ───
//
// annotations: array of { highlight, note } -- either field optional.
// Highlights render as blockquotes; a note attached to a highlight renders
// as plain text beneath it. An article with no annotations still produces
// a valid note (just the heading, no annotation section).
function renderAnnotations(annotations) {
    if (!annotations || annotations.length === 0) return "";

    var blocks = [];
    for (var i = 0; i < annotations.length; i++) {
        var a = annotations[i] || {};
        var lines = [];
        if (a.highlight) {
            var quoted = String(a.highlight).replace(/\r\n/g, "\n").split("\n")
                .map(function (line) { return "> " + line; }).join("\n");
            lines.push(quoted);
        }
        if (a.note) lines.push(String(a.note));
        if (lines.length > 0) blocks.push(lines.join("\n"));
    }
    return blocks.join("\n\n");
}

function buildBody(article, annotations, caps, config) {
    var parts = [];
    parts.push("# " + ((article && article.title) || ""));

    var rendered = renderAnnotations(annotations);
    if (rendered) parts.push(rendered);

    var tags = (config && config.tags) || [];
    if (tags.length > 0) {
        if (caps.wikilinks) {
            parts.push(tags.map(function (t) { return "[[" + t + "]]"; }).join(" "));
        } else {
            parts.push(tags.map(function (t) { return "#" + String(t).replace(/\s+/g, "-"); }).join(" "));
        }
    }

    return parts.join("\n\n") + "\n";
}

// ─── capabilities table ───

function capabilitiesFor(kind) {
    if (kind === "obsidian") return { openAfterWrite: true, wikilinks: true };
    if (kind === "neovim") return { openAfterWrite: true, wikilinks: false };
    return { openAfterWrite: false, wikilinks: false }; // "markdown" and any unknown kind
}

// ─── path building ───


// The widget's items carry `timestamp` (epoch ms, set by FeedParser); only a
// caller that has already formatted one supplies `dateStr`. Reading dateStr
// alone silently emitted `date: ""` into every note's frontmatter.
// UTC deliberately: a note's date must not change because the reader
// travelled, and ISO yyyy-mm-dd is what Obsidian's date queries expect.
function articleDate(article) {
    if (article && article.dateStr)
        return String(article.dateStr);
    var ts = article && article.timestamp;
    if (!ts)
        return "";
    var d = new Date(ts);
    if (isNaN(d.getTime()))
        return "";
    return d.toISOString().slice(0, 10);
}
function buildRelPath(config, article) {
    var template = config.filenameTemplate || "{title}";
    var rawName = interpolateTemplate(template, article);

    // Split a trailing extension off the RENDERED name before sanitising.
    // Without this the template's ".md" is treated as part of the title and
    // the disambiguating hash lands after it, producing the nonsense
    // "Title.md-8c38f0af.md" instead of "Title-8c38f0af.md".
    var ext = ".md";
    var stem = rawName;
    var dot = rawName.lastIndexOf(".");
    // dot === 0 matters: an empty title renders the template down to just
    // ".md", and treating that as a stem yields the filename "md". Peeling
    // it as an extension leaves an empty stem, which falls back to the id.
    if (dot >= 0 && rawName.length - dot <= 6) {
        ext = rawName.slice(dot);
        stem = rawName.slice(0, dot);
    }

    var safeBase = sanitizeSegment(stem);

    var idForFallback = sanitizeSegment((article && article.id) || "");

    // Rule 7: empty after sanitising falls back to the item id, never to
    // an empty name. When the title DID survive sanitising, still fold in
    // a short hash of the id so two articles that share a title (a real,
    // common feed scenario) do not collide on the same path -- silently
    // overwriting a previous note is data loss.
    var base;
    if (!safeBase) {
        base = idForFallback || "untitled";
    } else {
        var idSource = (article && (article.id || article.link || article.title)) || "";
        base = safeBase + "-" + fnv1aHex(String(idSource));
    }

    return clampFilenameBytes(base, ext, 255);
}

function buildNote(config, article, annotations) {
    if (!config || !config.root)
        return { error: "No export root configured" };
    if (!article)
        return { error: "No article to export" };

    var caps = capabilitiesFor(config.kind);
    var relPath = buildRelPath(config, article);

    // Rule 1: re-check containment on the assembled path. This should be
    // unreachable given sanitizeSegment()'s guarantees -- it exists
    // because sanitising alone is exactly the assumption the design doc
    // says not to make.
    if (!isRelPathContained(relPath))
        return { error: "Generated path escapes the export root" };

    var content = buildFrontmatter(article, config) + "\n\n" + buildBody(article, annotations, caps, config);

    return { relPath: relPath, content: content };
}

function buildOpenRequest(config, relPath) {
    var caps = capabilitiesFor(config.kind);
    if (!caps.openAfterWrite || !relPath) return null;

    var root = String(config.root || "").replace(/[\/\\]+$/, "");
    var fullPath = root + "/" + relPath;

    if (config.kind === "obsidian") {
        if (!config.vault) return null;
        var noExt = relPath.replace(/\.md$/, "");
        return {
            kind: "obsidian",
            url: "obsidian://open?vault=" + encodeURIComponent(config.vault) + "&file=" + encodeURIComponent(noExt)
        };
    }

    if (config.kind === "neovim") {
        if (!config.nvimServer) return null;
        return {
            kind: "neovim",
            argv: ["nvim", "--server", config.nvimServer, "--remote", fullPath]
        };
    }

    return null;
}

// ─── factory ───

function createExportProvider(config) {
    config = config || {};
    var caps = capabilitiesFor(config.kind);

    return {
        buildNote: function (article, annotations) {
            return buildNote(config, article, annotations);
        },

        capabilities: caps,

        openRequest: function (relPath) {
            return buildOpenRequest(config, relPath);
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createExportProvider: createExportProvider
    };
}
