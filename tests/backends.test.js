const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const FeedParser = require("../FeedParser.js");
const ReaderState = require("../ReaderState.js");
const {
    createStandardBackend,
    createMinifluxBackend,
    createBackends
} = require("../Backends.js");

var deps = { FeedParser: FeedParser, ReaderState: ReaderState };

// ─── createBackends ───

describe("createBackends", () => {
    test("exposes standard and miniflux backends with matching ids", () => {
        var backends = createBackends(deps);
        assert.equal(backends.standard.id, "standard");
        assert.equal(backends.miniflux.id, "miniflux");
    });
});

// ─── capabilities (snapshot contract) ───

describe("capabilities", () => {
    test("standard backend capabilities snapshot", () => {
        var backend = createStandardBackend(deps);
        assert.deepEqual(backend.capabilities, {
            serverState: false,
            star: true,
            subscribe: true,
            categories: false,
            fullText: false
        });
    });

    test("miniflux backend capabilities snapshot", () => {
        var backend = createMinifluxBackend(deps);
        assert.deepEqual(backend.capabilities, {
            serverState: true,
            star: true,
            subscribe: false,
            categories: false,
            fullText: false
        });
    });
});

// ─── StandardBackend.fetchRequest ───

describe("StandardBackend.fetchRequest", () => {
    var backend = createStandardBackend(deps);

    test("builds the exact argv fetchFeed uses today (DankRssWidget.qml fetchFeed)", () => {
        var req = backend.fetchRequest({ url: "https://example.com/feed.xml", name: "Example" });
        assert.deepEqual(req.argv, [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "10",
            "-L",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0",
            "https://example.com/feed.xml"
        ]);
    });

    test("returns null when config has no url (no-op)", () => {
        assert.equal(backend.fetchRequest({}), null);
        assert.equal(backend.fetchRequest(null), null);
    });

    test("parse delegates to FeedParser.parseFeed with the config's name/url", () => {
        var rss = "<rss><channel><item><title>Hello</title><link>https://x.com/1</link></item></channel></rss>";
        var req = backend.fetchRequest({ url: "https://x.com/feed.xml", name: "Example" });
        var result = req.parse(rss);
        var expected = FeedParser.parseFeed(rss, "Example", "https://x.com/feed.xml");
        assert.deepEqual(result.items, expected);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(result.error, null);
    });

    test("parse never throws on malformed/empty input (FeedParser.parseFeed itself is robust to it)", () => {
        var req = backend.fetchRequest({ url: "https://x.com/feed.xml", name: "Example" });
        var result = req.parse(null);
        assert.deepEqual(result.items, []);
        assert.equal(result.error, null);
    });
});

// ─── StandardBackend: no server-side state ───

describe("StandardBackend server-state no-ops", () => {
    var backend = createStandardBackend(deps);

    test("markReadRequest is always a no-op", () => {
        assert.equal(backend.markReadRequest({}, ["l:https://x.com/1"]), null);
    });

    test("markUnreadRequest is always a no-op", () => {
        assert.equal(backend.markUnreadRequest({}, ["l:https://x.com/1"]), null);
    });

    test("toggleStarRequest is always a no-op", () => {
        assert.equal(backend.toggleStarRequest({}, "l:https://x.com/1"), null);
    });

    test("reconcile is identity: unchanged orders, no *Changed flags", () => {
        var local = { readOrder: ["l:a", "l:b"], bookmarkOrder: ["l:c"], cap: 1000 };
        var result = backend.reconcile(local, [{ id: "l:a", status: "unread", starred: true }]);
        assert.deepEqual(result.readOrder, ["l:a", "l:b"]);
        assert.deepEqual(result.bookmarkOrder, ["l:c"]);
        assert.equal(result.readChanged, false);
        assert.equal(result.bookmarkChanged, false);
    });
});

// ─── MinifluxBackend.fetchRequest ───

describe("MinifluxBackend.fetchRequest", () => {
    var backend = createMinifluxBackend(deps);

    function baseConfig(overrides) {
        return Object.assign({
            minifluxUrl: "https://miniflux.example.com",
            minifluxToken: "SECRET_TOKEN_VALUE",
            showStarred: false,
            maxItems: 20
        }, overrides || {});
    }

    test("builds the exact argv minifluxApiCall uses today for GET /v1/entries (unread)", () => {
        var req = backend.fetchRequest(baseConfig());
        assert.deepEqual(req.argv, [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "25",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-X", "GET",
            "-H", "X-Auth-Token: SECRET_TOKEN_VALUE",
            "https://miniflux.example.com/v1/entries?status=unread&limit=20&order=published_at&direction=desc"
        ]);
    });

    test("showStarred switches the endpoint to starred=true", () => {
        var req = backend.fetchRequest(baseConfig({ showStarred: true }));
        var url = req.argv[req.argv.length - 1];
        assert.equal(url, "https://miniflux.example.com/v1/entries?starred=true&limit=20&order=published_at&direction=desc");
    });

    test("returns null when minifluxUrl or minifluxToken is missing/empty (config-not-ready no-op)", () => {
        assert.equal(backend.fetchRequest(baseConfig({ minifluxUrl: "" })), null);
        assert.equal(backend.fetchRequest(baseConfig({ minifluxToken: "" })), null);
        assert.equal(backend.fetchRequest(null), null);
    });

    test("parse: valid entries payload maps through FeedParser.parseMinifluxEntries", () => {
        var req = backend.fetchRequest(baseConfig());
        var json = JSON.stringify({ entries: [{ id: 42, title: "Hello", url: "https://x.com/1" }] });
        var result = req.parse(json);
        var expected = FeedParser.parseMinifluxEntries(JSON.parse(json), "https://miniflux.example.com");
        assert.deepEqual(result.items, expected.items);
        assert.deepEqual(result.serverStatus, expected.serverStatus);
        assert.equal(result.error, null);
    });

    test("parse: invalid JSON reports an error and empty items/serverStatus", () => {
        var req = backend.fetchRequest(baseConfig());
        var result = req.parse("not json");
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(typeof result.error, "string");
    });

    test("parse: a Miniflux error_message payload reports the error and empty items", () => {
        var req = backend.fetchRequest(baseConfig());
        var result = req.parse(JSON.stringify({ error_message: "Invalid credentials" }));
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(result.error, "Miniflux: Invalid credentials");
    });
});

// ─── MinifluxBackend.markReadRequest / markUnreadRequest ───

describe("MinifluxBackend mark read/unread", () => {
    var backend = createMinifluxBackend(deps);
    var config = { minifluxUrl: "https://miniflux.example.com", minifluxToken: "SECRET_TOKEN_VALUE" };

    test("markReadRequest builds the batched PUT /v1/entries argv with status=read", () => {
        var req = backend.markReadRequest(config, ["1", "2", "3"]);
        assert.deepEqual(req.argv, [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "25",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-X", "PUT",
            "-H", "X-Auth-Token: SECRET_TOKEN_VALUE",
            "-H", "Content-Type: application/json",
            "-d", JSON.stringify({ entry_ids: ["1", "2", "3"], status: "read" }),
            "https://miniflux.example.com/v1/entries"
        ]);
    });

    test("markUnreadRequest builds the same shape with status=unread", () => {
        var req = backend.markUnreadRequest(config, ["5"]);
        var body = req.argv[req.argv.indexOf("-d") + 1];
        assert.deepEqual(JSON.parse(body), { entry_ids: ["5"], status: "unread" });
    });

    test("returns null (no-op) for an empty or missing id list", () => {
        assert.equal(backend.markReadRequest(config, []), null);
        assert.equal(backend.markReadRequest(config, null), null);
        assert.equal(backend.markUnreadRequest(config, []), null);
    });

    test("returns null when config is not ready", () => {
        assert.equal(backend.markReadRequest({ minifluxUrl: "", minifluxToken: "" }, ["1"]), null);
    });
});

// ─── MinifluxBackend.toggleStarRequest ───

describe("MinifluxBackend.toggleStarRequest", () => {
    var backend = createMinifluxBackend(deps);
    var config = { minifluxUrl: "https://miniflux.example.com", minifluxToken: "SECRET_TOKEN_VALUE" };

    test("builds the PUT /v1/entries/{id}/bookmark argv with no -d body", () => {
        // Verbatim minifluxApiCall behaviour: any non-GET method gets a
        // Content-Type header regardless of whether there's a body to send
        // (DankRssWidget.qml:781-784) -- only "-d" itself is conditional on
        // a truthy body. minifluxToggleStar calls with body=null, so this
        // header appears here even though bookmark takes no payload.
        var req = backend.toggleStarRequest(config, "42");
        assert.deepEqual(req.argv, [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "25",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-X", "PUT",
            "-H", "X-Auth-Token: SECRET_TOKEN_VALUE",
            "-H", "Content-Type: application/json",
            "https://miniflux.example.com/v1/entries/42/bookmark"
        ]);
        assert.ok(req.argv.indexOf("-d") === -1, "no -d flag when there's no body");
    });

    test("returns null when id is falsy", () => {
        assert.equal(backend.toggleStarRequest(config, ""), null);
        assert.equal(backend.toggleStarRequest(config, null), null);
    });

    test("returns null when config is not ready", () => {
        assert.equal(backend.toggleStarRequest({ minifluxUrl: "", minifluxToken: "" }, "42"), null);
    });
});

// ─── MinifluxBackend.reconcile parity with ReaderState.reconcileServerStatus ───

describe("MinifluxBackend.reconcile", () => {
    var backend = createMinifluxBackend(deps);

    test("matches ReaderState.reconcileServerStatus for a server-marks-read case", () => {
        var local = { readOrder: [], bookmarkOrder: [], cap: 1000 };
        var serverEntries = [{ id: "m:1", status: "read", starred: false }];
        var result = backend.reconcile(local, serverEntries);
        var expected = ReaderState.reconcileServerStatus([], [], serverEntries, 1000);
        assert.deepEqual(result, expected);
    });

    test("matches ReaderState.reconcileServerStatus for a mixed batch", () => {
        var local = { readOrder: ["m:1"], bookmarkOrder: [], cap: 1000 };
        var serverEntries = [
            { id: "m:1", status: "unread", starred: false },
            { id: "m:2", status: "read", starred: true }
        ];
        var result = backend.reconcile(local, serverEntries);
        var expected = ReaderState.reconcileServerStatus(["m:1"], [], serverEntries, 1000);
        assert.deepEqual(result, expected);
    });
});

// ─── SECURITY: secret never concatenated into a larger string ───
//
// The Miniflux API token must always occupy its own designated argv slot
// (curl's own "-H" syntax requires "name: value" as one element, so that
// pairing is unavoidable) and must never leak into, or be merged with, any
// other argv element (the URL, the method, another header, the body). This
// is the property DankRssWidget.qml's minifluxApiCall comment calls out
// (v2.4 §2.5) and Backends.js must preserve it verbatim.

describe("SECURITY: token isolation in argv", () => {
    var TOKEN = "tok_9f3a-DO-NOT-LEAK";
    var backend = createMinifluxBackend(deps);
    var config = { minifluxUrl: "https://miniflux.example.com", minifluxToken: TOKEN, showStarred: false, maxItems: 20 };

    function assertTokenIsolated(argv) {
        assert.ok(Array.isArray(argv), "argv must be an array, never a joined command string");

        var withToken = argv.filter(function (el) { return el.indexOf(TOKEN) !== -1; });
        assert.equal(withToken.length, 1, "token must appear in exactly one argv element");
        assert.equal(withToken[0], "X-Auth-Token: " + TOKEN,
            "the token's argv element must be exactly its header value, never merged with the url/method/other data");

        // No other element (url, method, other headers, body) may carry it.
        for (var i = 0; i < argv.length; i++) {
            if (argv[i] === withToken[0]) continue;
            assert.equal(argv[i].indexOf(TOKEN), -1, "token leaked into an unrelated argv element: " + argv[i]);
        }
    }

    test("fetchRequest isolates the token", () => {
        assertTokenIsolated(backend.fetchRequest(config).argv);
    });

    test("markReadRequest isolates the token", () => {
        assertTokenIsolated(backend.markReadRequest(config, ["1"]).argv);
    });

    test("markUnreadRequest isolates the token", () => {
        assertTokenIsolated(backend.markUnreadRequest(config, ["1"]).argv);
    });

    test("toggleStarRequest isolates the token", () => {
        assertTokenIsolated(backend.toggleStarRequest(config, "1").argv);
    });

    test("a token containing shell metacharacters is still a single opaque argv element", () => {
        var nasty = "abc$(rm -rf /);`echo pwned`;\" ' &";
        var nastyConfig = { minifluxUrl: "https://miniflux.example.com", minifluxToken: nasty, showStarred: false, maxItems: 20 };
        var argv = backend.fetchRequest(nastyConfig).argv;
        assert.ok(Array.isArray(argv));
        assert.ok(argv.indexOf("X-Auth-Token: " + nasty) !== -1);
    });
});
