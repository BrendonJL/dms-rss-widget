const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const FeedParser = require("../FeedParser.js");
const ReaderState = require("../ReaderState.js");
const { createGoogleReaderBackend, normalizeGreaderId, MAX_CHAIN_LINKS } = require("../GoogleReader.js");

var deps = { FeedParser: FeedParser, ReaderState: ReaderState };

var config = {
    greaderUrl: "http://127.0.0.1:8085",
    greaderUsername: "admin",
    greaderPassword: "secret",
    maxItems: 20,
    showStarred: false
};

// Builds the exact stdout shape curl -w '\nHTTPSTATUS:%{http_code}' produces.
function wire(body, status) {
    return body + "\nHTTPSTATUS:" + status;
}

function run(descriptor, stdout) {
    return descriptor.parse(stdout);
}

// ─── normalizeGreaderId ───

describe("normalizeGreaderId", () => {
    test("decimal encoding", () => {
        assert.equal(normalizeGreaderId("46"), "r:46");
    });

    test("long-form (tag:...) encoding normalises to the SAME id as decimal", () => {
        assert.equal(
            normalizeGreaderId("tag:google.com,2005:reader/item/000000000000002e"),
            "r:46"
        );
    });

    test("uses its own prefix, distinct from g:/l:/h:/m:", () => {
        var id = normalizeGreaderId("46");
        assert.ok(id.startsWith("r:"));
        assert.notEqual(id.charAt(0), "g");
        assert.notEqual(id.charAt(0), "l");
        assert.notEqual(id.charAt(0), "h");
        assert.notEqual(id.charAt(0), "m");
    });

    test("garbage input returns null rather than throwing", () => {
        assert.equal(normalizeGreaderId(""), null);
        assert.equal(normalizeGreaderId(null), null);
        assert.equal(normalizeGreaderId(undefined), null);
        assert.equal(normalizeGreaderId("not-an-id"), null);
    });
});

// ─── fetchRequests: chain construction ───

describe("GoogleReaderBackend.fetchRequests", () => {
    var backend = createGoogleReaderBackend(deps);

    test("returns [] when config is not ready", () => {
        assert.deepEqual(backend.fetchRequests({}, null), []);
        assert.deepEqual(backend.fetchRequests(null, null), []);
    });

    test("no session -> chain starts at ClientLogin", () => {
        var reqs = backend.fetchRequests(config, null);
        assert.equal(reqs.length, 1);
        assert.ok(reqs[0].argv.join(" ").includes("/accounts/ClientLogin"));
    });

    test("authToken cached but no postToken -> chain starts at the token endpoint", () => {
        var reqs = backend.fetchRequests(config, { authToken: "tok" });
        assert.equal(reqs.length, 1);
        assert.ok(reqs[0].argv.join(" ").includes("/reader/api/0/token"));
        assert.ok(reqs[0].argv.includes("Authorization: GoogleLogin auth=tok"));
    });

    test("fully cached session -> chain starts directly at items/ids (skips auth entirely)", () => {
        var reqs = backend.fetchRequests(config, { authToken: "tok", postToken: "pt" });
        assert.equal(reqs.length, 1);
        assert.ok(reqs[0].argv.join(" ").includes("/reader/api/0/stream/items/ids"));
    });

    test("unread view excludes read items via xt=; starred view does not", () => {
        var unread = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        assert.ok(unread.argv.join(" ").includes("xt=user%2F-%2Fstate%2Fcom.google%2Fread"));

        var starred = backend.fetchRequests(Object.assign({}, config, { showStarred: true }), { authToken: "a", postToken: "p" })[0];
        assert.ok(!starred.argv.join(" ").includes("xt="));
        assert.ok(starred.argv.join(" ").includes("state%2Fcom.google%2Fstarred"));
    });
});

// ─── ClientLogin parsing ───

describe("GoogleReaderBackend chain: ClientLogin link", () => {
    var backend = createGoogleReaderBackend(deps);

    test("happy path extracts Auth= and chains into the token request", () => {
        var req = backend.fetchRequests(config, null)[0];
        var body = "SID=admin/xyz\nLSID=admin/xyz\nAuth=admin/xyz\n";
        var result = run(req, wire(body, 200));

        assert.equal(result.error, null);
        assert.ok(result.nextRequest);
        assert.ok(result.nextRequest.argv.join(" ").includes("/reader/api/0/token"));
        assert.ok(result.nextRequest.argv.includes("Authorization: GoogleLogin auth=admin/xyz"));
        assert.deepEqual(result.items, []);
        assert.equal(result.session.authToken, "admin/xyz");
        assert.equal(result.session.postToken, null);
    });

    test("malformed body (no Auth= line, status 200) terminates the chain with an error", () => {
        var req = backend.fetchRequests(config, null)[0];
        var result = run(req, wire("SID=admin/xyz\nLSID=admin/xyz\n", 200));

        assert.ok(result.error);
        assert.equal(result.nextRequest, null);
        assert.deepEqual(result.items, []);
    });

    test("401 (bad credentials) terminates the chain with an error, not a retry", () => {
        var req = backend.fetchRequests(config, null)[0];
        var result = run(req, wire('{"error_message":"access unauthorized"}', 401));

        assert.ok(result.error);
        assert.equal(result.nextRequest, null);
    });
});

// ─── token link ───

describe("GoogleReaderBackend chain: token link", () => {
    var backend = createGoogleReaderBackend(deps);

    test("happy path yields a post token and chains into items/ids", () => {
        var req = backend.fetchRequests(config, { authToken: "admin/xyz" })[0];
        var result = run(req, wire("admin/xyz", 200));

        assert.equal(result.error, null);
        assert.equal(result.session.authToken, "admin/xyz");
        assert.equal(result.session.postToken, "admin/xyz");
        assert.ok(result.nextRequest.argv.join(" ").includes("/reader/api/0/stream/items/ids"));
    });

    test("401 restarts the chain from ClientLogin exactly once (reauth)", () => {
        var req = backend.fetchRequests(config, { authToken: "stale" })[0];
        var result = run(req, wire("Unauthorized", 401));

        assert.equal(result.error, null);
        assert.ok(result.nextRequest);
        assert.ok(result.nextRequest.argv.join(" ").includes("/accounts/ClientLogin"));
    });

    test("empty body with 200 is treated as a failure, not a valid empty token", () => {
        var req = backend.fetchRequests(config, { authToken: "admin/xyz" })[0];
        var result = run(req, wire("", 200));

        assert.ok(result.error);
        assert.equal(result.nextRequest, null);
    });
});

// ─── items/ids link ───

describe("GoogleReaderBackend chain: items/ids link", () => {
    var backend = createGoogleReaderBackend(deps);

    test("empty itemRefs terminates the chain successfully with no error and no items", () => {
        var req = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        var result = run(req, wire('{"itemRefs":[],"continuation":"0"}', 200));

        assert.equal(result.error, null);
        assert.equal(result.nextRequest, null);
        assert.deepEqual(result.items, []);
        assert.equal(result.session.authToken, "a");
        assert.equal(result.session.postToken, "p");
    });

    test("non-empty itemRefs chains into items/contents carrying decimal ids", () => {
        var req = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        var result = run(req, wire('{"itemRefs":[{"id":"46"},{"id":"61"}],"continuation":"2"}', 200));

        assert.equal(result.error, null);
        var argvStr = result.nextRequest.argv.join(" ");
        assert.ok(argvStr.includes("/reader/api/0/stream/items/contents"));
        assert.ok(result.nextRequest.argv.includes("T=p"));
        assert.ok(result.nextRequest.argv.includes("i=46"));
        assert.ok(result.nextRequest.argv.includes("i=61"));
    });

    test("malformed JSON terminates the chain with an error, preserving the known-good session", () => {
        var req = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        var result = run(req, wire("not json", 200));

        assert.ok(result.error);
        assert.equal(result.nextRequest, null);
        assert.equal(result.session.authToken, "a");
        assert.equal(result.session.postToken, "p");
    });

    test("401 triggers reauth restart", () => {
        var req = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        var result = run(req, wire("Unauthorized", 401));

        assert.equal(result.error, null);
        assert.ok(result.nextRequest.argv.join(" ").includes("/accounts/ClientLogin"));
    });
});

// ─── items/contents link + item shape ───

describe("GoogleReaderBackend chain: items/contents link", () => {
    var backend = createGoogleReaderBackend(deps);

    function contentsRequestFor(ids) {
        var idsReq = backend.fetchRequests(config, { authToken: "a", postToken: "p" })[0];
        var refs = ids.map((id) => ({ id: id }));
        var idsResult = run(idsReq, wire(JSON.stringify({ itemRefs: refs, continuation: String(ids.length) }), 200));
        return idsResult.nextRequest;
    }

    test("parses items into the shared Item shape, normalising the long-form id", () => {
        var req = contentsRequestFor(["46"]);
        var body = JSON.stringify({
            items: [{
                id: "tag:google.com,2005:reader/item/000000000000002e",
                title: "Hello <b>World</b>",
                canonical: [{ href: "https://example.com/a" }],
                summary: { content: "<p>Body text</p>" },
                published: 1700000000,
                origin: { title: "Example Feed", htmlUrl: "https://example.com" },
                categories: ["user/1/state/com.google/reading-list"]
            }]
        });
        var result = run(req, wire(body, 200));

        assert.equal(result.error, null);
        assert.equal(result.nextRequest, null);
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].id, "r:46");
        assert.equal(result.items[0].link, "https://example.com/a");
        assert.equal(result.items[0].source, "Example Feed");
        assert.equal(result.items[0].timestamp, 1700000000000);
        assert.equal(result.serverStatus.length, 1);
        assert.equal(result.serverStatus[0].id, "r:46");
        assert.equal(result.serverStatus[0].status, "unread");
        assert.equal(result.serverStatus[0].starred, false);

        assert.equal(result.session.authToken, "a");
        assert.equal(result.session.postToken, "p");
    });

    test("read/starred categories map onto serverStatus", () => {
        var req = contentsRequestFor(["46"]);
        var body = JSON.stringify({
            items: [{
                id: "46",
                title: "T",
                categories: [
                    "user/1/state/com.google/reading-list",
                    "user/1/state/com.google/read",
                    "user/1/state/com.google/starred"
                ]
            }]
        });
        var result = run(req, wire(body, 200));

        assert.equal(result.serverStatus[0].status, "read");
        assert.equal(result.serverStatus[0].starred, true);
    });

    test("malformed items/contents body terminates with an error", () => {
        var req = contentsRequestFor(["46"]);
        var result = run(req, wire("[]garbage", 200));
        assert.ok(result.error);
        assert.equal(result.nextRequest, null);
    });

    test("401 on items/contents also triggers reauth restart", () => {
        var req = contentsRequestFor(["46"]);
        var result = run(req, wire("Unauthorized", 401));
        assert.equal(result.error, null);
        assert.ok(result.nextRequest.argv.join(" ").includes("/accounts/ClientLogin"));
    });
});

// ─── chain cap ───

describe("GoogleReaderBackend chain: 5-link cap", () => {
    var backend = createGoogleReaderBackend(deps);

    test("a full cold-start reauth recovery (5 links) succeeds", () => {
        // Worst realistic case: fully-cached session has gone stale.
        // items/ids(1) 401 -> ClientLogin(2) -> token(3) -> items/ids(4) ->
        // items/contents(5). All five links must be reachable.
        var link1 = backend.fetchRequests(config, { authToken: "stale-a", postToken: "stale-p" })[0];
        var r1 = run(link1, wire("Unauthorized", 401));
        assert.equal(r1.error, null, "link 1->2 (reauth trigger) must not error");

        var link2 = r1.nextRequest; // ClientLogin
        var r2 = run(link2, wire("Auth=fresh/tok\n", 200));
        assert.equal(r2.error, null, "link 2->3 (ClientLogin) must not error");

        var link3 = r2.nextRequest; // token
        var r3 = run(link3, wire("fresh/tok", 200));
        assert.equal(r3.error, null, "link 3->4 (token) must not error");

        var link4 = r3.nextRequest; // items/ids
        var r4 = run(link4, wire('{"itemRefs":[{"id":"1"}],"continuation":"1"}', 200));
        assert.equal(r4.error, null, "link 4->5 (items/ids) must not error");

        var link5 = r4.nextRequest; // items/contents -- the 5th and final link
        assert.ok(link5, "the 5th link must be reachable");
        var r5 = run(link5, wire(JSON.stringify({ items: [{ id: "1", title: "x" }] }), 200));
        assert.equal(r5.error, null);
        assert.equal(r5.nextRequest, null);
        assert.equal(r5.items.length, 1);
    });

    test("a SECOND 401 in the same chain does not loop -- it terminates with an error", () => {
        var link1 = backend.fetchRequests(config, { authToken: "stale-a", postToken: "stale-p" })[0];
        var r1 = run(link1, wire("Unauthorized", 401)); // triggers reauth #1
        var link2 = r1.nextRequest; // ClientLogin (reauthAttempted latched true)

        var r2 = run(link2, wire("Auth=fresh/tok\n", 200));
        var link3 = r2.nextRequest; // token

        // Server is STILL rejecting us even after reauth -- a broken/looping
        // server. This must terminate, not build a second ClientLogin.
        var r3 = run(link3, wire("Unauthorized", 401));
        assert.ok(r3.error, "a second 401 after an already-attempted reauth must be a terminal error");
        assert.equal(r3.nextRequest, null);
    });

    test("MAX_CHAIN_LINKS is exactly 5", () => {
        assert.equal(MAX_CHAIN_LINKS, 5);
    });
});

// ─── edit-tag mutations ───

describe("GoogleReaderBackend mutations (edit-tag)", () => {
    var backend = createGoogleReaderBackend(deps);
    var session = { authToken: "admin/xyz", postToken: "admin/xyz" };

    test("markReadRequest sends a= read", () => {
        var req = backend.markReadRequest(config, session, ["46"]);
        assert.ok(req.argv.join(" ").includes("/reader/api/0/edit-tag"));
        assert.ok(req.argv.includes("T=admin/xyz"));
        assert.ok(req.argv.includes("i=46"));
        assert.ok(req.argv.includes("a=user/-/state/com.google/read"));
        assert.ok(!req.argv.includes("r=user/-/state/com.google/read"));
    });

    test("markUnreadRequest sends r= read", () => {
        var req = backend.markUnreadRequest(config, session, ["46"]);
        assert.ok(req.argv.includes("r=user/-/state/com.google/read"));
        assert.ok(!req.argv.some((a) => a.startsWith("a=user/-/state/com.google/read")));
    });

    test("toggleStarRequest(currentlyStarred=false) sends a= starred", () => {
        var req = backend.toggleStarRequest(config, session, "46", false);
        assert.ok(req.argv.includes("a=user/-/state/com.google/starred"));
    });

    test("toggleStarRequest(currentlyStarred=true) sends r= starred", () => {
        var req = backend.toggleStarRequest(config, session, "46", true);
        assert.ok(req.argv.includes("r=user/-/state/com.google/starred"));
    });

    test("markReadRequest batches multiple ids into one call", () => {
        var req = backend.markReadRequest(config, session, ["1", "2", "3"]);
        assert.ok(req.argv.includes("i=1"));
        assert.ok(req.argv.includes("i=2"));
        assert.ok(req.argv.includes("i=3"));
    });

    test("returns null for an empty or missing id list", () => {
        assert.equal(backend.markReadRequest(config, session, []), null);
        assert.equal(backend.markReadRequest(config, session, null), null);
        assert.equal(backend.toggleStarRequest(config, session, null, false), null);
    });

    test("returns null when config is not ready", () => {
        assert.equal(backend.markReadRequest({}, session, ["46"]), null);
    });

    // The post-token requirement (design trap #1): without a cached session
    // there is no way to build a valid edit-tag call at all.
    test("returns null without a session", () => {
        assert.equal(backend.markReadRequest(config, null, ["46"]), null);
        assert.equal(backend.markReadRequest(config, {}, ["46"]), null);
    });

    test("returns null with an authToken but no postToken", () => {
        assert.equal(backend.markReadRequest(config, { authToken: "a" }, ["46"]), null);
    });

    test("returns null with a postToken but no authToken", () => {
        assert.equal(backend.markReadRequest(config, { postToken: "p" }, ["46"]), null);
    });
});

// ─── configState / capabilities ───

describe("GoogleReaderBackend.configState", () => {
    var backend = createGoogleReaderBackend(deps);

    test("unconfigured when any of url/username/password is missing", () => {
        assert.deepEqual(backend.configState({}), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState({ greaderUrl: "http://x" }), { ok: false, reason: "unconfigured" });
        assert.deepEqual(backend.configState(null), { ok: false, reason: "unconfigured" });
    });

    test("ok when fully configured", () => {
        assert.deepEqual(backend.configState(config), { ok: true, reason: null });
    });
});

describe("GoogleReaderBackend.capabilities", () => {
    test("snapshot", () => {
        var backend = createGoogleReaderBackend(deps);
        assert.deepEqual(backend.capabilities, {
            serverState: true,
            star: true,
            subscribe: true,
            categories: true,
            fullText: false
        });
    });
});

// ─── reconcile ───

describe("GoogleReaderBackend.reconcile", () => {
    test("delegates to ReaderState.reconcileServerStatus", () => {
        var backend = createGoogleReaderBackend(deps);
        var localState = { readOrder: [], bookmarkOrder: [], cap: 500 };
        var serverEntries = [{ id: "r:46", status: "read", starred: false }];

        var actual = backend.reconcile(localState, serverEntries);
        var expected = ReaderState.reconcileServerStatus(localState.readOrder, localState.bookmarkOrder, serverEntries, localState.cap);
        assert.deepEqual(actual, expected);
    });
});
