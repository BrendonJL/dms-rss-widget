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

// ─── StandardBackend.fetchRequests ───

describe("StandardBackend.fetchRequests", () => {
    var backend = createStandardBackend(deps);

    function feed(overrides) {
        return Object.assign({ url: "https://example.com/feed.xml", name: "Example" }, overrides || {});
    }

    test("builds the exact argv fetchFeed uses today (DankRssWidget.qml fetchFeed)", () => {
        var reqs = backend.fetchRequests({ feeds: [feed()] });
        assert.equal(reqs.length, 1);
        assert.deepEqual(reqs[0].argv, [
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

    test("returns [] when config has no feeds / is missing (no-op)", () => {
        assert.deepEqual(backend.fetchRequests({ feeds: [] }), []);
        assert.deepEqual(backend.fetchRequests({}), []);
        assert.deepEqual(backend.fetchRequests(null), []);
    });

    test("one descriptor per ELIGIBLE feed, in iteration order; disabled and urlless feeds produce none", () => {
        var feeds = [
            feed({ url: "https://a.com/f.xml", name: "A" }),
            feed({ url: "https://b.com/f.xml", name: "B", enabled: false }),
            feed({ url: "", name: "NoUrl" }),
            feed({ url: "https://c.com/f.xml", name: "C" })
        ];
        var reqs = backend.fetchRequests({ feeds: feeds });
        assert.equal(reqs.length, 2);
        assert.deepEqual(reqs.map(function (r) { return r.meta; }), [
            { url: "https://a.com/f.xml", name: "A", index: 0 },
            { url: "https://c.com/f.xml", name: "C", index: 3 }
        ]);
    });

    // REGRESSION: descriptors were matched to status rows by url, so two
    // enabled feeds sharing a url under different names collapsed onto one
    // descriptor and one rendered its items under the other feed's name.
    // Nothing enforces url uniqueness in settings, so this config is reachable.
    test("meta.index distinguishes two enabled feeds sharing one url", () => {
        var feeds = [
            feed({ url: "https://dup.com/f.xml", name: "First" }),
            feed({ url: "https://other.com/f.xml", name: "Middle", enabled: false }),
            feed({ url: "https://dup.com/f.xml", name: "Second" })
        ];
        var reqs = backend.fetchRequests({ feeds: feeds });
        assert.equal(reqs.length, 2);
        assert.deepEqual(reqs.map(function (r) { return r.meta.index; }), [0, 2]);
        assert.deepEqual(reqs.map(function (r) { return r.meta.name; }), ["First", "Second"]);
    });

    test("meta.name falls back to the url when name is absent", () => {
        var reqs = backend.fetchRequests({ feeds: [feed({ url: "https://x.com/f.xml", name: undefined })] });
        assert.deepEqual(reqs[0].meta, { url: "https://x.com/f.xml", name: "https://x.com/f.xml", index: 0 });
    });

    test("timeoutMs is null (Proc's default), matching fetchFeed today", () => {
        var reqs = backend.fetchRequests({ feeds: [feed()] });
        assert.equal(reqs[0].timeoutMs, null);
    });

    test("parse delegates to FeedParser.parseFeed with the feed's name/url", () => {
        var rss = "<rss><channel><item><title>Hello</title><link>https://x.com/1</link></item></channel></rss>";
        var reqs = backend.fetchRequests({ feeds: [feed({ url: "https://x.com/feed.xml", name: "Example" })] });
        var result = reqs[0].parse(rss);
        var expected = FeedParser.parseFeed(rss, "Example", "https://x.com/feed.xml");
        assert.deepEqual(result.items, expected);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(result.error, null);
    });

    test("parse never throws on malformed/empty input (FeedParser.parseFeed itself is robust to it)", () => {
        var reqs = backend.fetchRequests({ feeds: [feed({ url: "https://x.com/feed.xml", name: "Example" })] });
        var result = reqs[0].parse(null);
        assert.deepEqual(result.items, []);
        assert.equal(result.error, null);
    });
});

// ─── StandardBackend.configState ───

describe("StandardBackend.configState", () => {
    var backend = createStandardBackend(deps);

    test("no feeds configured -> unconfigured", () => {
        assert.deepEqual(backend.configState({ feeds: [] }), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState({}), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState(null), { ok: false, reason: "unconfigured" });
    });

    test("feeds configured but none enabled -> empty", () => {
        var feeds = [
            { url: "https://a.com/f.xml", name: "A", enabled: false },
            { url: "https://b.com/f.xml", name: "B", enabled: false }
        ];
        assert.deepEqual(backend.configState({ feeds: feeds }), { ok: false, reason: "empty" });
    });

    test("at least one enabled feed with a url -> ok", () => {
        var feeds = [
            { url: "https://a.com/f.xml", name: "A", enabled: false },
            { url: "https://b.com/f.xml", name: "B" }
        ];
        assert.deepEqual(backend.configState({ feeds: feeds }), { ok: true, reason: null });
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

// ─── MinifluxBackend.fetchRequests ───

describe("MinifluxBackend.fetchRequests", () => {
    var backend = createMinifluxBackend(deps);

    function baseConfig(overrides) {
        return Object.assign({
            minifluxUrl: "https://miniflux.example.com",
            minifluxToken: "SECRET_TOKEN_VALUE",
            showStarred: false,
            maxItems: 20
        }, overrides || {});
    }

    test("builds the exact argv minifluxApiCall uses today for GET /v1/entries (unread), as a single-element array", () => {
        var reqs = backend.fetchRequests(baseConfig());
        assert.equal(reqs.length, 1);
        assert.deepEqual(reqs[0].argv, [
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

    test("meta is null for miniflux descriptors", () => {
        var reqs = backend.fetchRequests(baseConfig());
        assert.equal(reqs[0].meta, null);
    });

    test("timeoutMs is the deliberately-longer Miniflux Proc timeout", () => {
        var reqs = backend.fetchRequests(baseConfig());
        assert.equal(reqs[0].timeoutMs, 30000);
    });

    test("showStarred switches the endpoint to starred=true", () => {
        var reqs = backend.fetchRequests(baseConfig({ showStarred: true }));
        var url = reqs[0].argv[reqs[0].argv.length - 1];
        assert.equal(url, "https://miniflux.example.com/v1/entries?starred=true&limit=20&order=published_at&direction=desc");
    });

    test("returns [] when minifluxUrl or minifluxToken is missing/empty (config-not-usable no-op)", () => {
        assert.deepEqual(backend.fetchRequests(baseConfig({ minifluxUrl: "" })), []);
        assert.deepEqual(backend.fetchRequests(baseConfig({ minifluxToken: "" })), []);
        assert.deepEqual(backend.fetchRequests(null), []);
    });

    test("parse: valid entries payload maps through FeedParser.parseMinifluxEntries", () => {
        var reqs = backend.fetchRequests(baseConfig());
        var json = JSON.stringify({ entries: [{ id: 42, title: "Hello", url: "https://x.com/1" }] });
        var result = reqs[0].parse(json);
        var expected = FeedParser.parseMinifluxEntries(JSON.parse(json), "https://miniflux.example.com");
        assert.deepEqual(result.items, expected.items);
        assert.deepEqual(result.serverStatus, expected.serverStatus);
        assert.equal(result.error, null);
    });

    test("parse: invalid JSON reports an error and empty items/serverStatus", () => {
        var reqs = backend.fetchRequests(baseConfig());
        var result = reqs[0].parse("not json");
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(typeof result.error, "string");
    });

    test("parse: a Miniflux error_message payload reports the error and empty items", () => {
        var reqs = backend.fetchRequests(baseConfig());
        var result = reqs[0].parse(JSON.stringify({ error_message: "Invalid credentials" }));
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.serverStatus, []);
        assert.equal(result.error, "Miniflux: Invalid credentials");
    });
});

// ─── MinifluxBackend.configState ───

describe("MinifluxBackend.configState", () => {
    var backend = createMinifluxBackend(deps);

    test("no minifluxUrl -> unconfigured (matches the UI's !root.minifluxUrl branch)", () => {
        assert.deepEqual(backend.configState({ minifluxUrl: "", minifluxToken: "tok" }), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState({}), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState(null), { ok: false, reason: "unconfigured" });
    });

    test("minifluxUrl set -> ok (the UI does not distinguish a missing token as its own empty state)", () => {
        assert.deepEqual(backend.configState({ minifluxUrl: "https://mf.example.com", minifluxToken: "" }), { ok: true, reason: null });
        assert.deepEqual(backend.configState({ minifluxUrl: "https://mf.example.com", minifluxToken: "tok" }), { ok: true, reason: null });
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

    test("fetchRequests isolates the token", () => {
        assertTokenIsolated(backend.fetchRequests(config)[0].argv);
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
        var argv = backend.fetchRequests(nastyConfig)[0].argv;
        assert.ok(Array.isArray(argv));
        assert.ok(argv.indexOf("X-Auth-Token: " + nasty) !== -1);
    });
});
