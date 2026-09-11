// Export provider interface for the Dank RSS Widget.
//
// See README.md's "Architecture" section for the QML/Node dual-load
// mechanism and the `.pragma library` rule (kept once, in FeedParser.js).
// See docs/plans/2026-09-08-phase4-export-provider-design.md for the full
// design and its numbered security rules, cited below where each applies.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness, and -- unlike the Node test file that exercises it -- no
// `require("path")` / `require("buffer")` either, because this file also
// runs unmodified inside QML's JS engine. Byte-clamping and containment
// checks below are hand-rolled string operations for exactly that reason.
//
// THE SECURITY PROBLEM THIS FILE EXISTS TO SOLVE: feed content is
// untrusted, attacker-controlled input, and buildNote() turns it into a
// filesystem path -- "../../../.bashrc" is a legal RSS <title>.

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

// Clamp the WHOLE filename (base + extension) to 255 BYTES, not characters:
// NAME_MAX is a byte limit, so a CJK or emoji title hits it at roughly 85
// characters. Truncates on a codepoint boundary so the result stays valid
// UTF-8.

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

// Did this note's body come from a full extraction of the article page, or
// from the feed's own summary? `extracted` is whatever HtmlExtract.js's
// extractArticle() returned (or null/undefined -- the toggle is off, the
// item had no link, or the fetch was never attempted). A reader must be
// able to tell a mangled extraction apart from a deliberate summary, so
// this is recorded rather than left implicit.
function wasExtracted(extracted) {
    return !!(extracted && !extracted.usedFallback && extracted.markdown);
}

function buildFrontmatter(article, config, extracted) {
    var tags = (config && config.tags) || [];
    var tagStrs = [];
    for (var i = 0; i < tags.length; i++) tagStrs.push(yamlQuote(tags[i]));

    var lines = [
        "---",
        "title: " + yamlQuote((article && article.title) || ""),
        "source: " + yamlQuote((article && article.source) || ""),
        "link: " + yamlQuote((article && article.link) || ""),
        "date: " + yamlQuote(articleDate(article)),
        "extracted: " + (wasExtracted(extracted) ? "true" : "false"),
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

// The feed's own summary text -- what the note falls back to when full-text
// extraction is off, unavailable, or rejected the page (see HtmlExtract.js's
// index-page guard). Shared with the caller so it can pass the SAME text to
// extractArticle() as options.summary for its own fallback comparison.
function articleSummaryText(article) {
    return (article && (article.description || article.content)) || "";
}

function buildBody(article, annotations, caps, config, extracted) {
    var parts = [];
    parts.push("# " + ((article && article.title) || ""));

    // Prefer a successful full-text extraction over the feed's summary --
    // but only when extraction actually produced usable article markdown.
    // usedFallback:true means HtmlExtract.js already decided the extraction
    // was worse than (or indistinguishable from junk versus) the summary,
    // so falling through to the summary here is that decision, not a
    // separate one.
    var text = wasExtracted(extracted) ? extracted.markdown : articleSummaryText(article);
    if (text) parts.push(text);

    // A link back to the source, so the note is useful on its own once the
    // item has scrolled out of the feed. The frontmatter carries the url too,
    // but frontmatter is metadata -- this is for a human reading the note.
    if (article && article.link) parts.push("[Read the original](" + article.link + ")");

    var rendered = renderAnnotations(annotations);
    if (rendered) parts.push(rendered);


    // Tags are not repeated in the body. The frontmatter already carries
    // them, and every markdown tool that cares about tags reads it from
    // there -- Obsidian included. Emitting "[[rss]]" under the article as
    // well just leaves a stray line to delete in every note.

    return parts.join("\n\n") + "\n";
}

// ─── open-command presets (stage 4d) ───
//
// Adding an editor used to mean adding a branch to buildOpenRequest for
// each one. The file being opened is identical in every case -- the only
// editor-specific thing is the command that opens it afterward -- so that
// becomes a single command TEMPLATE with `{path}` substituted, and "one more
// editor" becomes "one more row in this table", not a new code path.
//
// GUI editors (VS Code, Zed, Emacs) ship a launcher that takes a bare path.
// Terminal ones (Neovim, Helix, Vim) need a terminal emulator wrapped around
// them, and which terminal is the user's business -- these presets assume
// `kitty` because that is what this machine runs. They are a starting point
// to edit, not a claim about anyone's setup; the settings panel says so.
var EXPORT_OPEN_PRESETS = [
    { id: "none", label: "None", template: "" },
    { id: "obsidian", label: "Obsidian", template: "obsidian://open?vault={vault}&file={file}" },
    { id: "vscode", label: "VS Code", template: "code {path}" },
    { id: "zed", label: "Zed", template: "zed {path}" },
    { id: "emacs", label: "Emacs", template: "emacsclient -n {path}" },
    { id: "nvim-remote", label: "Neovim (running instance)", template: "nvim --server $NVIM --remote {path}" },
    { id: "nvim-terminal", label: "Neovim (terminal)", template: "kitty nvim {path}" },
    { id: "helix", label: "Helix", template: "kitty hx {path}" },
    { id: "vim", label: "Vim", template: "kitty vim {path}" },
    { id: "custom", label: "Custom", template: "" }
];

function presetById(id) {
    for (var i = 0; i < EXPORT_OPEN_PRESETS.length; i++) {
        if (EXPORT_OPEN_PRESETS[i].id === id) return EXPORT_OPEN_PRESETS[i];
    }
    return null;
}

// ─── legacy config migration (stage 4d) ───
//
// Before this stage "exportKind" was one of exactly three values and fully
// determined behaviour by itself. It is now the id of whichever preset is
// active, and the actual open command lives in `exportOpenCommand`. A saved
// config from before this stage has no `exportOpenCommand` key at all --
// that absence is what marks it as legacy, not the value of exportKind
// (which stays a normal, possibly-empty string forever after). A config
// that already HAS the key, even set to "", has already been through this
// (or was created after it existed) and is returned unchanged.
function resolveExportConfig(saved) {
    saved = saved || {};
    if (Object.prototype.hasOwnProperty.call(saved, "exportOpenCommand")) {
        return {
            exportKind: saved.exportKind || "custom",
            exportOpenCommand: saved.exportOpenCommand || ""
        };
    }

    // "obsidian" and "neovim" were the only legacy kinds with any open
    // behaviour at all -- "markdown" (and anything unrecognised) had none,
    // and maps to "no preset selected" rather than to a real one.
    var legacyPresetId = { obsidian: "obsidian", neovim: "nvim-remote" }[saved.exportKind];
    if (!legacyPresetId)
        return { exportKind: "none", exportOpenCommand: "" };

    var preset = presetById(legacyPresetId);
    return { exportKind: preset.id, exportOpenCommand: preset.template };
}

// ─── capabilities table ───
//
// Obsidian's wikilink tags change the note's CONTENT (adding "[[tag]]"
// links), not how the note is opened afterward -- that is what makes them a
// capability flag rather than something baked into the open-command
// template, and why this keys off `kind` (which preset is active) rather
// than off the template text itself.
function capabilitiesFor(config) {
    config = config || {};
    return {
        openAfterWrite: !!(config.exportOpenCommand && String(config.exportOpenCommand).trim()),
        wikilinks: config.kind === "obsidian"
    };
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
        // Clamp the TITLE, then append the hash -- not the other way round.
        // Clamping the assembled "title-hash" truncates from the end, which
        // eats the hash itself: two articles with long titles sharing a
        // prefix then produce the SAME filename and one silently overwrites
        // the other. Reserve the hash and extension first.
        var suffix = "-" + fnv1aHex(String((article && (article.id || article.link || article.title)) || ""));
        var reserved = suffix.length + ext.length;
        base = clampUtf8Bytes(safeBase, 255 - reserved) + suffix;
    }

    return clampFilenameBytes(base, ext, 255);
}

// `extracted` is optional and defaults to absent -- existing callers that
// pass only (article, annotations) keep writing exactly the summary-only
// note they always did, with `extracted: false` in the frontmatter.
function buildNote(config, article, annotations, extracted) {
    if (!config || !config.root)
        return { error: "No export root configured" };
    if (!article)
        return { error: "No article to export" };

    var caps = capabilitiesFor(config);
    var relPath = buildRelPath(config, article);

    // Rule 1: re-check containment on the assembled path. This should be
    // unreachable given sanitizeSegment()'s guarantees -- it exists
    // because sanitising alone is exactly the assumption the design doc
    // says not to make.
    if (!isRelPathContained(relPath))
        return { error: "Generated path escapes the export root" };

    var content = buildFrontmatter(article, config, extracted) + "\n\n" +
        buildBody(article, annotations, caps, config, extracted);

    return { relPath: relPath, content: content };
}

// `{path}` is substituted as its OWN argv element, never concatenated into a
// shell string: the template is trusted local config, but the path is
// derived from feed content, which is not (see the header comment). Argv
// separation -- never a shell -- is what makes a filename containing a
// space, a quote or a semicolon a non-event rather than an injection.
function buildOpenRequest(config, relPath) {
    config = config || {};
    if (!relPath) return null;

    var template = String(config.exportOpenCommand || "").trim();
    if (!template) return null; // "None" / unconfigured -- write the file and stop

    var root = String(config.root || "").replace(/[\/\\]+$/, "");
    var fullPath = root + "/" + relPath;

    // Obsidian is a URL handler, not an executable, so its template is a URI
    // with `{vault}`/`{file}` substituted directly into the string rather
    // than split into argv. The extension is stripped because Obsidian
    // addresses a note by its wikilink name, not its filename.
    if (config.kind === "obsidian") {
        if (!config.vault) return null;
        var noExt = relPath.replace(/\.md$/, "");
        var url = template
            .replace(/\{vault\}/g, encodeURIComponent(config.vault))
            .replace(/\{file\}/g, encodeURIComponent(noExt));
        return { kind: "obsidian", url: url };
    }

    // Split BEFORE substituting fullPath in: joining it into the template
    // string first and splitting afterward would let a path containing a
    // space re-fragment into two argv elements, exactly the injection this
    // split exists to prevent. This also means a template cannot itself
    // contain a quoted argument with a space in it -- an accepted limit on
    // the shape of command this is, and it beats invoking a shell to parse
    // it.
    var parts = template.split(/\s+/).filter(function (s) { return s.length > 0; });
    var argv = [];
    var sawPath = false;
    for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "{path}") {
            sawPath = true;
            argv.push(fullPath);
        } else {
            argv.push(parts[i]);
        }
    }

    // A template with no {path} would run a command that never receives the
    // note at all -- silently opening nothing while looking like success.
    // Refuse it outright rather than run it.
    if (!sawPath) return null;

    // `$NVIM` and any other environment variable is deliberately NOT
    // expanded here. argv is handed straight to the OS with no shell in
    // between, so there is nothing to expand it anyway -- and reimplementing
    // shell variable expansion ourselves, by hand, on a string next to
    // attacker-adjacent input, just to make one preset more convenient, is
    // exactly the kind of thing this file exists to avoid doing (see the
    // header comment). The nvim --server $NVIM preset only resolves where
    // the process that ultimately runs it already has $NVIM in its own
    // environment.
    return { kind: "custom", argv: argv };
}

// ─── article fetch (stage 4c-b) ───
//
// Full-text export needs the article page itself, not just the feed's
// summary. Same curl discipline as every other outbound request in this
// widget: argv array (never a shell string, so nothing here is ever
// vulnerable to shell injection), explicit connect/max timeouts, and the
// protocol pinned to http/https on both the initial request and any
// redirect.
//
// -L IS wanted here, unlike the authenticated Miniflux/Google-Reader calls
// elsewhere in this widget (see minifluxCurlArgv in Backends.js): those
// never follow a redirect because curl resends the same Authorization
// header to whatever host the redirect names, handing a token to a third
// party. An article fetch carries no credentials at all -- there is
// nothing to leak -- and articles redirect constantly (AMP variants,
// canonical-URL bounces, paywall interstitials), so refusing to follow
// would silently break the common case instead of protecting anything.
//
// On demand only: this is called once per article the user has explicitly
// chosen to export, never from a feed refresh or a scroll handler. Ten
// selected articles is ten requests to ten different sites; that must
// always be something the user asked for.
var ARTICLE_FETCH_CONNECT_TIMEOUT_S = 5;
var ARTICLE_FETCH_MAX_TIME_S = 15;
var ARTICLE_FETCH_MAX_BYTES = 5000000;

function buildArticleFetchRequest(url) {
    return {
        argv: [
            "curl", "-sS",
            "--connect-timeout", String(ARTICLE_FETCH_CONNECT_TIMEOUT_S),
            "--max-time", String(ARTICLE_FETCH_MAX_TIME_S),
            "-L",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", String(ARTICLE_FETCH_MAX_BYTES),
            "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0",
            String(url)
        ],
        timeoutMs: null
    };
}

// ─── factory ───

function createExportProvider(config) {
    config = config || {};
    var caps = capabilitiesFor(config);

    return {
        buildNote: function (article, annotations, extracted) {
            return buildNote(config, article, annotations, extracted);
        },

        capabilities: caps,

        openRequest: function (relPath) {
            return buildOpenRequest(config, relPath);
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createExportProvider: createExportProvider,
        buildArticleFetchRequest: buildArticleFetchRequest,
        articleSummaryText: articleSummaryText,
        EXPORT_OPEN_PRESETS: EXPORT_OPEN_PRESETS,
        resolveExportConfig: resolveExportConfig
    };
}
