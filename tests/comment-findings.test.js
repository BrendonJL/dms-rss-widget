// Guards the findings that cost real debugging time and that a future reader
// cannot re-derive from the code alone. Each entry is a fact discovered by
// probing a live server, reading DMS source, or shipping the bug once.
//
// This is deliberately NOT a style check. Comments may be rewritten, moved to
// a different file, or compressed freely -- the test only asserts the FINDING
// still exists somewhere in the source a maintainer will read. It exists
// because a tidy-up pass is exactly when hard-won context gets deleted for
// looking like verbose prose.
//
// If you are removing an entry here, the finding must have become false --
// not merely inconvenient.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCES = ["FeedParser.js", "ReaderState.js", "Backends.js", "GoogleReader.js",
    "ChainRunner.js", "AiProvider.js", "ExportProvider.js",
    "DankRssWidget.qml", "DankRssWidgetSettings.qml"];

const corpus = SOURCES.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

// [what the reader must still learn, a regex that proves it is written down]
const FINDINGS = [
    ["Miniflux's stream/contents returns an empty array with HTTP 200",
        /stream\/contents[\s\S]{0,240}?(\[\]|empty)/i],
    ["Google Reader POSTs need the T= post token or return 401",
        /post[- ]token|\bT=\b/i],
    ["Google Reader exposes two id encodings for the same item",
        /(decimal[\s\S]{0,200}?long form|long form[\s\S]{0,200}?decimal|tag:google\.com)/i],
    ["reading-list never drops read items, so unread needs xt=",
        /\bxt=/],
    ["edit-tag state comes back as user/1/... not user/-/...",
        /user\/1\/state|literal (numeric )?user id/i],
    ["entry_ids must be int64; the widget sent strings and got HTTP 400",
        /int64/],
    ["curl exits 0 on an HTTP 400, so API errors were silently discarded",
        /--fail-with-body/],
    ["Miniflux calls need a 30s Proc timeout, longer than curl's own 25s",
        /MINIFLUX_PROC_TIMEOUT_MS|30000/],
    ["No -L on authenticated requests: curl resends headers across hosts",
        /-L\b[\s\S]{0,200}?redirect|redirect[\s\S]{0,200}?\bkey\b/i],
    [".pragma library breaks require() in the Node suite",
        /pragma library/],
    ["Modules cannot require() each other; deps are injected",
        /(require\(\)[\s\S]{0,300}?QML|dependency injection)/i],
    ["acceptsKeyboardFocus maps to layer-shell OnDemand: focus arrives on click",
        /OnDemand/],
    ["HoverHandler, not MouseArea: children steal containsMouse from a parent",
        /HoverHandler/],
    ["selectedMap is pruned against allItems, so selection outlives a filter",
        /prune[\s\S]{0,200}?allItems/i],
    ["Descriptors are matched to feeds by index, not url: urls can repeat",
        /meta\.index|byIndex/],
    ["fetchGeneration increments above backend work so both paths share one",
        /fetchGeneration/],
    ["The pending counter decrements once per chain, not per request",
        /once per (CHAIN|chain)/],
    ["ChainRunner.step throws after a terminal result to stop a double-decrement",
        /double-?decrement/i],
    ["The chain is capped so a server returning nextRequest forever cannot loop",
        /MAX_CHAIN_LINKS|chain[\s\S]{0,120}?cap/i],
    ["currentlyStarred is read before the local toggle, or a=/r= inverts",
        /BEFORE the local toggle|prior starred/i],
    ["Every backend shares one positional signature; unused params are declared",
        /positional/i],
    ["Filenames clamp to 255 bytes, not characters",
        /255 bytes/i],
    ["Feed content is untrusted input that becomes a filesystem path",
        /(untrusted|attacker)/i],
    ["ollama returns reasoning separately; content needs no <think> stripping",
        /reasoning/i],
    ["Neither /no_think nor enable_thinking works through ollama's OpenAI shim",
        /no_think|enable_thinking/],
];

describe("hard-won findings survive in the source", () => {
    FINDINGS.forEach(([finding, pattern]) => {
        test(finding, () => {
            assert.ok(pattern.test(corpus),
                "This finding is no longer documented anywhere in the source.\n" +
                "  Finding: " + finding + "\n" +
                "  Looked for: " + pattern + "\n" +
                "  Comments may be rewritten or moved freely, but this fact must " +
                "remain findable by whoever next reads this code.");
        });
    });
});

// QML imports a .js module as a namespace of its TOP-LEVEL functions, which
// is a wider surface than module.exports. DankRssWidgetSettings.qml calls
// three GoogleReader.js functions that are top-level but NOT exported, so the
// Node suite never touches them: rename one, or wrap it in a closure during a
// refactor, and Test Connection breaks at runtime with every test still green.
//
// This asserts the QML-visible surface exists. It reads the source rather than
// require()ing, precisely because require() only sees module.exports and would
// therefore miss the very thing at risk.
describe("functions QML calls but Node never imports", () => {
    var qmlCallers = {
        "DankRssWidgetSettings.qml": {
            module: "GoogleReader.js",
            functions: ["buildClientLoginRequest", "greaderCurlArgv", "splitHttpStatus"]
        }
    };

    Object.keys(qmlCallers).forEach(function (qmlFile) {
        var spec = qmlCallers[qmlFile];
        var src = fs.readFileSync(path.join(ROOT, spec.module), "utf8");
        var qml = fs.readFileSync(path.join(ROOT, qmlFile), "utf8");

        spec.functions.forEach(function (fn) {
            test(spec.module + " declares " + fn + "() for " + qmlFile, () => {
                assert.ok(new RegExp("^function\\s+" + fn + "\\s*\\(", "m").test(src),
                    fn + " must stay a top-level function declaration in " +
                    spec.module + " -- " + qmlFile + " calls it through the QML " +
                    "import namespace, and no Node test would notice it going away.");
            });
        });

        test(qmlFile + " still calls all of them", () => {
            spec.functions.forEach(function (fn) {
                assert.ok(qml.indexOf(fn) !== -1,
                    fn + " is no longer called; drop it from this list rather " +
                    "than leaving a guard for a dependency that ended.");
            });
        });
    });
});

// The widget deliberately has NO Tab stops. Tab moves Qt focus outside
// keyboardScope, after which its Keys.onPressed receives nothing and j/k go
// dead with no way back but a click -- and DankActionButton additionally
// consumes Space/Return/Enter (see DankCommon/Widgets/DankActionButton.qml),
// the very keys that select and open an item.
//
// That makes "someone adds a button without activeFocusOnTab: false" a
// regression that breaks keyboard navigation in a way no other test notices,
// and that only shows up as "the keyboard randomly stops working".
describe("no Tab stops in the widget", () => {
    var src = fs.readFileSync(path.join(ROOT, "DankRssWidget.qml"), "utf8");
    var lines = src.split("\n");

    // Types that are focusable by Tab unless told otherwise.
    var TABBABLE = /^\s*(DankActionButton|DankTextField|DankToggle|DankButton|DankDropdown|DankRefreshButton)\s*\{/;

    lines.forEach(function (line, i) {
        if (!TABBABLE.test(line))
            return;
        var type = line.trim().split(/\s+/)[0];
        test(type + " at line " + (i + 1) + " sets activeFocusOnTab: false", () => {
            // Scan the declaration body, not a fixed window: stop at the first
            // line indented no further than the declaration itself.
            var openIndent = line.search(/\S/);
            var found = false;
            for (var j = i + 1; j < lines.length; j++) {
                var l = lines[j];
                if (l.trim() === "") continue;
                if (l.search(/\S/) <= openIndent) break;
                if (/activeFocusOnTab\s*:\s*false/.test(l)) { found = true; break; }
            }
            assert.ok(found,
                type + " at DankRssWidget.qml:" + (i + 1) + " is a Tab stop.\n" +
                "  Add `activeFocusOnTab: false`. Tab focus escapes keyboardScope, " +
                "which kills j/k with no way back, and DankActionButton eats " +
                "Space/Return/Enter. Reach controls with the mouse, or with " +
                "m/s/Space on the cursor row.");
        });
    });
});
