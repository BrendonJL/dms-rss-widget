// Backend provider interface for the Dank RSS Widget (Phase 0, stage 0a).
//
// Shared, like FeedParser.js and ReaderState.js, between QML and the Node
// test suite:
//   QML  : import "Backends.js" as Backends
//   Node : require("./Backends.js")
//
// IMPORTANT: no `.pragma library` line here — it is invalid JavaScript and
// would break `require()` in the tests. See docs/plans/2026-09-08-phase0-
// backend-interface-design.md.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness. Request-descriptor functions never run curl themselves — they
// return { argv, parse, meta, timeoutMs } (a full curl argv vector plus a
// pure function to turn stdout into normalised items) or null/[] when the
// call is a no-op for that backend. fetchRequests(config) returns an ARRAY
// of descriptors (one per eligible feed for standard, at most one for
// Miniflux); markReadRequest/markUnreadRequest/toggleStarRequest each still
// return a single descriptor or null. QML alone is responsible for actually
// spawning `argv` and handing the result to `parse`.
//
// DEPENDENCY INJECTION: this file has no way to `import`/`require` its
// sibling shared modules (FeedParser.js, ReaderState.js) in a form both QML
// and Node accept — QML's non-pragma `.import` directive is not valid
// JavaScript syntax, so a literal `.import` line here would break Node's
// require(). Callers (the DankRssWidget.qml aggregator in stage 0b, or a
// test file here) already import both modules themselves and pass them in:
//
//   var backends = Backends.createBackends({ FeedParser: FeedParser, ReaderState: ReaderState });

// Proc-side timeout for Miniflux calls, deliberately LONGER than curl's own
// --max-time of 25s. Carried on the request descriptor because it is a real
// part of the contract: DankRssWidget.qml:787-790 documents that without it a
// slow-but-fine request races Proc's default timeout and gets killed early,
// surfacing a spurious failure toast. Standard-mode fetches use null (Proc's
// default), matching fetchFeed today.
var MINIFLUX_PROC_TIMEOUT_MS = 30000;

// ─── shared curl argv builder (Miniflux) ───
//
// Lifted verbatim from minifluxApiCall (DankRssWidget.qml:763-792).
//
// SECURITY: the API token is always its own argv element (the "-H" value
// slot curl's own syntax requires), never merged into the URL, the method,
// another header, or the body — and this function never joins argv into a
// single string for a shell. Proc.runCommand (QML side) spawns `argv`
// directly; no code path here or in the caller builds a shell command
// string. See tests/backends.test.js's "SECURITY: token isolation" suite.
function minifluxCurlArgv(method, minifluxUrl, endpoint, token, body) {
    var url = minifluxUrl + endpoint;
    var args = [
        "curl", "-sS",
        // --fail-with-body: curl exits 0 on an HTTP 400, so every Miniflux API
        // error was silently discarded -- the caller only reacts to a nonzero
        // exit. This makes a 4xx/5xx exit 22 while still returning the body,
        // so the existing error path fires. Without it, mark-as-read failed
        // server-side through 2.3.3 with no toast, no log, nothing.
        "--fail-with-body",
        "--connect-timeout", "5",
        "--max-time", "25",
        "--proto", "=http,https",
        "--proto-redir", "=http,https",
        "--max-redirs", "5",
        "--max-filesize", "5000000",
        "-X", method,
        "-H", "X-Auth-Token: " + token
    ];
    if (method !== "GET") {
        args.push("-H", "Content-Type: application/json");
        if (body)
            args.push("-d", body);
    }
    args.push(url);
    return args;
}

function minifluxConfigReady(config) {
    return !!(config && config.minifluxUrl && config.minifluxToken);
}

// ─── StandardBackend ───
//
// Direct feed fetching, local-only state. capabilities.serverState is
// false and reconcile() is the identity function — there is no server to
// reconcile against.
function buildStandardFetchRequest(feed, FeedParser) {
    var url = feed.url;
    var name = feed.name || url;

    return {
        argv: [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "10",
            "-L",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0",
            url
        ],
        timeoutMs: null,
        meta: { url: url, name: name },
        parse: function (stdout) {
            try {
                return { items: FeedParser.parseFeed(stdout, name, url), serverStatus: [], error: null };
            } catch (e) {
                return { items: [], serverStatus: [], error: "Parse failed" };
            }
        }
    };
}

function createStandardBackend(deps) {
    var FeedParser = deps && deps.FeedParser;
    var ReaderState = deps && deps.ReaderState;

    return {
        id: "standard",

        capabilities: {
            serverState: false,
            star: true,
            subscribe: true,
            categories: false,
            fullText: false
        },

        // config: { feeds }. One descriptor per ELIGIBLE feed -- enabled
        // (ReaderState.isFeedEnabled) and with a url -- in the same order
        // fetchAllFeeds iterates today (DankRssWidget.qml:514-568).
        // ReaderState.activeFeeds applies exactly that filter and preserves
        // order, so it is reused rather than re-derived here.
        fetchRequests: function (config) {
            var feeds = (config && config.feeds) || [];
            var active = ReaderState.activeFeeds(feeds);
            var out = [];
            for (var i = 0; i < active.length; i++) {
                var req = buildStandardFetchRequest(active[i], FeedParser);
                // meta.index is the position in the ORIGINAL feeds array, not
                // in `active`. The caller matches descriptors to its own
                // status rows by this index. Matching on url instead collapses
                // two feeds that share a url under different display names
                // onto one descriptor, and one of them then renders its items
                // under the other feed's name. Nothing enforces url
                // uniqueness in settings, so that config is reachable.
                req.meta.index = feeds.indexOf(active[i]);
                out.push(req);
            }
            return out;
        },

        // config: { feeds }. Mirrors the empty-state branches
        // (DankRssWidget.qml ~1727-1790): no feeds at all is distinct from
        // feeds that exist but are all disabled (activeFeedCount === 0).
        configState: function (config) {
            var feeds = (config && config.feeds) || [];
            if (feeds.length === 0)
                return { ok: false, reason: "unconfigured" };
            if (ReaderState.activeFeeds(feeds).length === 0)
                return { ok: false, reason: "empty" };
            return { ok: true, reason: null };
        },

        // No server-backed state in standard mode: read/unread/star are
        // purely local (ReaderState), so these are always a no-op.
        markReadRequest: function (config, ids) { return null; },
        markUnreadRequest: function (config, ids) { return null; },
        toggleStarRequest: function (config, id) { return null; },

        // Identity: nothing to reconcile against.
        reconcile: function (localState, serverEntries) {
            return {
                readOrder: (localState && localState.readOrder) || [],
                bookmarkOrder: (localState && localState.bookmarkOrder) || [],
                readChanged: false,
                bookmarkChanged: false
            };
        }
    };
}

// ─── MinifluxBackend ───
//
// Lifted verbatim from DankRssWidget.qml's sourceMode === "miniflux"
// branches: minifluxApiCall, fetchMinifluxEntries, minifluxMarkRead,
// minifluxMarkUnread, minifluxToggleStar, and the reconciliation call in
// fetchMinifluxEntries's success path.
function createMinifluxBackend(deps) {
    var FeedParser = deps && deps.FeedParser;
    var ReaderState = deps && deps.ReaderState;

    return {
        id: "miniflux",

        capabilities: {
            serverState: true,
            star: true,
            subscribe: false,
            categories: false,
            fullText: false
        },

        // config: { minifluxUrl, minifluxToken, showStarred, maxItems }.
        // Mirrors fetchMinifluxEntries's endpoint choice
        // (DankRssWidget.qml:828-830) and minifluxApiCall's GET argv. Always
        // a single-element array (one server, one request) or [] when the
        // config isn't usable yet -- see the Stage 0b addendum.
        fetchRequests: function (config) {
            if (!minifluxConfigReady(config))
                return [];

            var endpoint = config.showStarred
                ? "/v1/entries?starred=true&limit=" + config.maxItems + "&order=published_at&direction=desc"
                : "/v1/entries?status=unread&limit=" + config.maxItems + "&order=published_at&direction=desc";

            var minifluxUrl = config.minifluxUrl;

            return [{
                argv: minifluxCurlArgv("GET", minifluxUrl, endpoint, config.minifluxToken, null),
                timeoutMs: MINIFLUX_PROC_TIMEOUT_MS,
                meta: null,
                parse: function (stdout) {
                    var parsed = null;
                    var error = null;

                    try {
                        parsed = JSON.parse(stdout);
                    } catch (e) {
                        parsed = null;
                        error = "Parse failed";
                    }

                    if (parsed && parsed.error_message) {
                        error = "Miniflux: " + parsed.error_message;
                        parsed = null;
                    }

                    var result = (parsed && !error)
                        ? FeedParser.parseMinifluxEntries(parsed, minifluxUrl)
                        : { items: [], serverStatus: [] };

                    return { items: result.items, serverStatus: result.serverStatus, error: error };
                }
            }];
        },

        // config: { minifluxUrl, ... }. Mirrors the UI's empty-state branch
        // (DankRssWidget.qml ~1727-1790), which checks only !root.minifluxUrl
        // -- a missing token is not its own distinct empty state today, so
        // this deliberately does not invent one.
        configState: function (config) {
            if (!config || !config.minifluxUrl)
                return { ok: false, reason: "unconfigured" };
            return { ok: true, reason: null };
        },

        // Batched PUT /v1/entries, mirroring minifluxMarkRead/
        // minifluxMarkUnread (DankRssWidget.qml:927-941). The "only call
        // when there's something to send" guard previously lived in each
        // caller (bulkMarkReadSelected, setAllRead); it is now the
        // no-op decision this function itself makes.
        markReadRequest: function (config, ids) {
            return minifluxMarkRequest(config, ids, "read");
        },
        markUnreadRequest: function (config, ids) {
            return minifluxMarkRequest(config, ids, "unread");
        },

        // PUT /v1/entries/{id}/bookmark, mirroring minifluxToggleStar
        // (DankRssWidget.qml:946-951).
        toggleStarRequest: function (config, id) {
            if (!minifluxConfigReady(config) || !id)
                return null;

            return {
                argv: minifluxCurlArgv("PUT", config.minifluxUrl, "/v1/entries/" + id + "/bookmark", config.minifluxToken, null),
                timeoutMs: MINIFLUX_PROC_TIMEOUT_MS,
                parse: function (stdout) { return null; }
            };
        },

        // Server wins on fetch reconciliation (v2.4 §2.2/§2.3) — delegates
        // straight to the existing, already-tested ReaderState function.
        reconcile: function (localState, serverEntries) {
            var ls = localState || {};
            return ReaderState.reconcileServerStatus(ls.readOrder, ls.bookmarkOrder, serverEntries, ls.cap);
        }
    };
}

function minifluxMarkRequest(config, ids, status) {
    if (!minifluxConfigReady(config))
        return null;

    // Miniflux types entry_ids as int64 and rejects the whole request with
    // HTTP 400 if any element is a string. The widget's ids arrive as strings
    // (minifluxNumericId returns itemId.slice(2)), so coerce here rather than
    // at every call site. This shipped broken through 2.3.3: mark-as-read
    // never reached the server, and curl exits 0 on a 400, so nothing ever
    // surfaced it. Verified against a live Miniflux 2.x instance.
    var numeric = [];
    for (var i = 0; i < (ids || []).length; i++) {
        var n = parseInt(ids[i], 10);
        if (!isNaN(n))
            numeric.push(n);
    }
    if (numeric.length === 0)
        return null;

    var body = JSON.stringify({ entry_ids: numeric, status: status });

    return {
        argv: minifluxCurlArgv("PUT", config.minifluxUrl, "/v1/entries", config.minifluxToken, body),
        timeoutMs: MINIFLUX_PROC_TIMEOUT_MS,
        parse: function (stdout) { return null; }
    };
}

// ─── factory ───

function createBackends(deps) {
    return {
        standard: createStandardBackend(deps),
        miniflux: createMinifluxBackend(deps)
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createStandardBackend: createStandardBackend,
        createMinifluxBackend: createMinifluxBackend,
        createBackends: createBackends
    };
}
