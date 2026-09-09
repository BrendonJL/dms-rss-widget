// Google Reader API backend for the Dank RSS Widget (Phase 1, stage 1a).
//
// Shared, like Backends.js/FeedParser.js/ReaderState.js, between QML and the
// Node test suite:
//   QML  : import "GoogleReader.js" as GoogleReader
//   Node : require("./GoogleReader.js")
//
// IMPORTANT: no `.pragma library` line here — it is invalid JavaScript and
// would break `require()` in the tests.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness, no mutable module-level state. Request-descriptor functions
// never run curl themselves — they return { argv, parse, meta, timeoutMs }.
// QML alone spawns `argv` and hands the result to `parse`.
//
// DEPENDENCY INJECTION: this file cannot `require()`/`.import` its sibling
// shared modules in a form both QML and Node accept, so the caller passes
// them in: GoogleReader.createGoogleReaderBackend({ FeedParser: FeedParser,
// ReaderState: ReaderState }).
//
// ─── The protocol, as probed against a live Miniflux 2.x instance ─────────
//
// See docs/plans/2026-09-09-phase1-google-reader-design.md for the full
// write-up. Summary:
//
//   1. POST /accounts/ClientLogin (Email=, Passwd=) -> body has an "Auth="
//      line. That's the bearer token for every later call, sent as
//      "Authorization: GoogleLogin auth=<token>".
//   2. Every POST additionally needs a POST-token from
//      GET /reader/api/0/token, sent as "T=" in the form body. Skip it and a
//      POST returns 401 with no explanation.
//   3. GET /reader/api/0/stream/items/ids?s=<stream>&n=<n>&output=json ->
//      { itemRefs: [{id: "46"}, ...], continuation: "..." }. Ids here are
//      DECIMAL strings.
//   4. POST /reader/api/0/stream/items/contents?output=json (T=, repeated
//      i=) -> the full items. Ids here are the LONG form
//      ("tag:google.com,2005:reader/item/000000000000002e", hex, zero-padded
//      to 16). `stream/contents` itself (the single-request shortcut the
//      original docs describe) is NOT implemented by Miniflux: every variant
//      returns a bare `[]` with HTTP 200, so this file always uses the two-
//      step ids -> contents flow.
//   5. POST /reader/api/0/edit-tag (T=, i=, a=/r=) with
//      user/-/state/com.google/read or .../starred flips read/star state.
//      Confirmed to accept EITHER id encoding.
//
// Both id encodings normalise to one id here, prefixed "r:" — its own
// prefix, distinct from makeItemId's "g:"/"l:"/"h:" and Miniflux's "m:"
// (FeedParser.js:395-401).
//
// ─── Chain interface (the extension this backend needs) ───────────────────
//
// Phase 0's fetchRequests(config) -> [descriptor] assumes independent,
// parallel requests. Google Reader is a CHAIN: contents needs ids, which
// needs a post token, which needs an auth token. `parse` may therefore
// return a `nextRequest` descriptor (or null) alongside the usual
// { items, serverStatus, error }; the QML runner (stage 1b) runs that
// instead of finishing. Standard/Miniflux never set it.
//
// The chain is capped at MAX_CHAIN_LINKS (5): one full cold start
// (ClientLogin -> token -> ids -> contents = 4 links) leaves exactly one
// spare link, which is what a single re-authenticate-on-401 recovery from a
// fully-cached, gone-stale session needs (ids -> ClientLogin -> token -> ids
// -> contents = 5 links). A SECOND 401 in the same chain does not retry
// again — reauthAttempted latches true and the chain terminates with an
// error instead of looping.
//
// ─── Session ────────────────────────────────────────────────────────────
//
// The backend holds no mutable state (or the tests would break). The
// caller owns a `session` object { authToken, postToken } and passes it
// into fetchRequests/markReadRequest/markUnreadRequest/toggleStarRequest.
// The terminal link of every fetch chain reports back `session: { authToken,
// postToken }` (nulls where unknown) so the caller can cache them; without a
// session the fetch chain starts at ClientLogin, and the mark/star
// mutations simply refuse (return null) since edit-tag cannot be built
// without a cached post token.

var GREADER_PROC_TIMEOUT_MS = 30000;
var MAX_CHAIN_LINKS = 5;
var STATUS_MARKER = "\nHTTPSTATUS:";

var READ_TAG = "user/-/state/com.google/read";
var STARRED_TAG = "user/-/state/com.google/starred";
var READING_LIST_STREAM = "user/-/state/com.google/reading-list";
var STARRED_STREAM = "user/-/state/com.google/starred";

function greaderConfigReady(config) {
    return !!(config && config.greaderUrl && config.greaderUsername && config.greaderPassword);
}

function chainLinkAllowed(linkIndex) {
    return linkIndex <= MAX_CHAIN_LINKS;
}

// Splits curl's stdout (body + our injected "-w" trailer) back into
// { body, status }. Discovered independently of the design doc: a plain
// `curl -sS` body carries no HTTP status line at all, and 401 responses on
// /reader/api/0/* are the bare text "Unauthorized" with no distinguishing
// JSON -- there is nothing in the body alone to detect failure reliably.
// `-w '\nHTTPSTATUS:%{http_code}'` appended to every argv sidesteps that:
// the trailer can never collide with a JSON body (which never ends in a
// bare newline + "HTTPSTATUS:") or with the ClientLogin key=value body.
function splitHttpStatus(stdout) {
    var s = typeof stdout === "string" ? stdout : "";
    var idx = s.lastIndexOf(STATUS_MARKER);
    if (idx === -1)
        return { body: s, status: 0 };
    var statusStr = s.slice(idx + STATUS_MARKER.length);
    var status = parseInt(statusStr, 10);
    return { body: s.slice(0, idx), status: isNaN(status) ? 0 : status };
}

// Shared curl argv builder. `formFields` is an array of [key, value] pairs
// (not an object) because edit-tag/items-contents repeat the "i=" key once
// per id -- an object could not represent that.
function greaderCurlArgv(method, baseUrl, endpoint, authToken, formFields) {
    var args = [
        "curl", "-sS",
        "--connect-timeout", "5",
        "--max-time", "25",
        "--proto", "=http,https",
        "--proto-redir", "=http,https",
        "--max-redirs", "5",
        "--max-filesize", "5000000",
        "-w", STATUS_MARKER + "%{http_code}",
        "-X", method
    ];
    if (authToken)
        args.push("-H", "Authorization: GoogleLogin auth=" + authToken);
    if (formFields) {
        for (var i = 0; i < formFields.length; i++)
            args.push("--data-urlencode", formFields[i][0] + "=" + formFields[i][1]);
    }
    args.push(baseUrl + endpoint);
    return args;
}

function parseClientLoginAuth(body) {
    var lines = (body || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("Auth=") === 0) {
            var v = lines[i].slice(5).trim();
            return v.length > 0 ? v : null;
        }
    }
    return null;
}

// Normalises BOTH id encodings items/ids and items/contents hand back --
// decimal ("46") and the long form
// ("tag:google.com,2005:reader/item/000000000000002e", hex) -- onto one
// "r:"-prefixed id, distinct from makeItemId's "g:"/"l:"/"h:" and
// Miniflux's "m:".
function normalizeGreaderId(rawId) {
    if (typeof rawId !== "string" || rawId.length === 0)
        return null;

    var longForm = /reader\/item\/([0-9a-fA-F]+)$/.exec(rawId);
    if (longForm) {
        var fromHex = parseInt(longForm[1], 16);
        return isNaN(fromHex) ? null : "r:" + fromHex;
    }

    if (/^[0-9]+$/.test(rawId))
        return "r:" + parseInt(rawId, 10);

    return null;
}

function pickGreaderLink(raw) {
    if (raw.canonical && raw.canonical.length && raw.canonical[0] && raw.canonical[0].href)
        return raw.canonical[0].href;
    if (raw.alternate && raw.alternate.length && raw.alternate[0] && raw.alternate[0].href)
        return raw.alternate[0].href;
    return "";
}

// Miniflux's own enclosures carry a real "image/*" mime_type; Google
// Reader's `enclosure` entries here come back typed "application/
// octet-stream" regardless of content -- a protocol detail this file had to
// discover by probing, since the design doc doesn't mention it. mime-type
// filtering (as minifluxEntryImage does) is useless here, so this just takes
// the first enclosure url that passes isSafeUrl, then falls back to
// scanning the content HTML.
function pickGreaderImage(raw, contentHtml, FeedParser) {
    var enclosures = raw.enclosure || [];
    for (var i = 0; i < enclosures.length; i++) {
        var url = enclosures[i] && enclosures[i].url;
        if (url && FeedParser.isSafeUrl(url))
            return url;
    }
    return FeedParser.extractImageUrl("", contentHtml || "");
}

// One items/contents entry -> the shared Item shape, plus its serverStatus
// row. Never throws: an entry with no usable id is skipped by the caller.
function buildGreaderItem(raw, config, FeedParser) {
    var id = normalizeGreaderId(raw && raw.id);
    if (!id)
        return null;

    var contentHtml = (raw.content && raw.content.content) || (raw.summary && raw.summary.content) || "";
    var publishedSec = (typeof raw.published === "number") ? raw.published : 0;
    var timestamp = publishedSec > 0 ? publishedSec * 1000 : 0;
    var categories = raw.categories || [];
    var isRead = categoriesHaveState(categories, "read");
    var isStarred = categoriesHaveState(categories, "starred");

    return {
        item: {
            id: id,
            title: FeedParser.cleanText(raw.title || ""),
            link: pickGreaderLink(raw),
            description: FeedParser.cleanText(FeedParser.stripHtml(contentHtml)),
            dateStr: timestamp > 0 ? new Date(timestamp).toISOString() : "",
            timestamp: timestamp,
            source: (raw.origin && raw.origin.title) || "",
            sourceUrl: (raw.origin && raw.origin.htmlUrl) || (config && config.greaderUrl) || "",
            imageUrl: pickGreaderImage(raw, contentHtml, FeedParser)
        },
        status: {
            id: id,
            status: isRead ? "read" : "unread",
            starred: isStarred
        }
    };
}

// Discovered by probing, not documented in the design: edit-tag's a=/r=
// values use the literal "user/-/state/com.google/<name>" form (confirmed
// live), but the `categories` array items/contents hands back for the SAME
// state uses the resolved numeric user id instead of "-"
// ("user/1/state/com.google/read"). A straight string/indexOf match against
// READ_TAG/STARRED_TAG against that array therefore never matches. Match on
// the "/state/com.google/<name>" suffix instead, which is stable across
// both forms.
function categoriesHaveState(categories, name) {
    var suffix = "/state/com.google/" + name;
    for (var i = 0; i < categories.length; i++) {
        if (typeof categories[i] === "string" && categories[i].indexOf(suffix, categories[i].length - suffix.length) !== -1)
            return true;
    }
    return false;
}

function parseGreaderItems(rawItems, config, FeedParser) {
    var items = [];
    var serverStatus = [];
    for (var i = 0; i < rawItems.length; i++) {
        var built = buildGreaderItem(rawItems[i], config, FeedParser);
        if (!built)
            continue;
        items.push(built.item);
        serverStatus.push(built.status);
    }
    return { items: FeedParser.dedupeItems(items), serverStatus: serverStatus };
}

function terminal(error, session) {
    return {
        items: [],
        serverStatus: [],
        error: error,
        nextRequest: null,
        session: session || { authToken: null, postToken: null }
    };
}

// A 401 anywhere past ClientLogin means the cached session went stale.
// Restart the chain from ClientLogin exactly ONCE per chain (reauthAttempted
// latches true on the restart); a second 401 in the same chain terminates
// with an error rather than looping.
function handleAuthFailure(config, chainState, FeedParser) {
    if (chainState.reauthAttempted)
        return terminal("GoogleReader: authentication expired");

    var next = buildClientLoginRequest(config, { linkIndex: chainState.linkIndex + 1, reauthAttempted: true }, FeedParser);
    if (!next)
        return terminal("GoogleReader: chain link limit exceeded");

    return { items: [], serverStatus: [], error: null, nextRequest: next, session: { authToken: null, postToken: null } };
}

// ─── chain links ────────────────────────────────────────────────────────

function buildClientLoginRequest(config, chainState, FeedParser) {
    if (!chainLinkAllowed(chainState.linkIndex))
        return null;

    var linkIndex = chainState.linkIndex;
    var reauthAttempted = chainState.reauthAttempted;

    return {
        argv: greaderCurlArgv("POST", config.greaderUrl, "/accounts/ClientLogin", null, [
            ["Email", config.greaderUsername],
            ["Passwd", config.greaderPassword]
        ]),
        timeoutMs: GREADER_PROC_TIMEOUT_MS,
        meta: { step: "clientLogin", linkIndex: linkIndex },
        parse: function (stdout) {
            var split = splitHttpStatus(stdout);
            var authToken = split.status === 200 ? parseClientLoginAuth(split.body) : null;
            if (!authToken)
                return terminal("GoogleReader: authentication failed");

            var next = buildTokenRequest(config, authToken, { linkIndex: linkIndex + 1, reauthAttempted: reauthAttempted }, FeedParser);
            if (!next)
                return terminal("GoogleReader: chain link limit exceeded", { authToken: authToken, postToken: null });

            return { items: [], serverStatus: [], error: null, nextRequest: next, session: { authToken: authToken, postToken: null } };
        }
    };
}

function buildTokenRequest(config, authToken, chainState, FeedParser) {
    if (!chainLinkAllowed(chainState.linkIndex))
        return null;

    var linkIndex = chainState.linkIndex;
    var reauthAttempted = chainState.reauthAttempted;

    return {
        argv: greaderCurlArgv("GET", config.greaderUrl, "/reader/api/0/token", authToken, null),
        timeoutMs: GREADER_PROC_TIMEOUT_MS,
        meta: { step: "token", linkIndex: linkIndex },
        parse: function (stdout) {
            var split = splitHttpStatus(stdout);
            if (split.status === 401)
                return handleAuthFailure(config, { linkIndex: linkIndex, reauthAttempted: reauthAttempted }, FeedParser);
            if (split.status !== 200 || !split.body || split.body.trim().length === 0)
                return terminal("GoogleReader: token request failed", { authToken: authToken, postToken: null });

            var postToken = split.body.trim();
            var next = buildItemsIdsRequest(config, authToken, postToken, { linkIndex: linkIndex + 1, reauthAttempted: reauthAttempted }, FeedParser);
            if (!next)
                return terminal("GoogleReader: chain link limit exceeded", { authToken: authToken, postToken: postToken });

            return { items: [], serverStatus: [], error: null, nextRequest: next, session: { authToken: authToken, postToken: postToken } };
        }
    };
}

function buildItemsIdsRequest(config, authToken, postToken, chainState, FeedParser) {
    if (!chainLinkAllowed(chainState.linkIndex))
        return null;

    var linkIndex = chainState.linkIndex;
    var reauthAttempted = chainState.reauthAttempted;

    var stream = config.showStarred ? STARRED_STREAM : READING_LIST_STREAM;
    var n = (config.maxItems && config.maxItems > 0) ? config.maxItems : 20;
    var endpoint = "/reader/api/0/stream/items/ids?s=" + encodeURIComponent(stream) + "&n=" + n + "&output=json";
    // Discovered by probing, not documented in the design: the reading-list
    // stream returns EVERY item regardless of read state (a read item stays
    // in it forever). "xt=" (exclude tag) with the read state string filters
    // it back down to unread, mirroring Miniflux's status=unread. Starred
    // view intentionally shows starred items regardless of read state, so
    // this filter is skipped there.
    if (!config.showStarred)
        endpoint += "&xt=" + encodeURIComponent(READ_TAG);

    return {
        argv: greaderCurlArgv("GET", config.greaderUrl, endpoint, authToken, null),
        timeoutMs: GREADER_PROC_TIMEOUT_MS,
        meta: { step: "itemsIds", linkIndex: linkIndex },
        parse: function (stdout) {
            var split = splitHttpStatus(stdout);
            if (split.status === 401)
                return handleAuthFailure(config, { linkIndex: linkIndex, reauthAttempted: reauthAttempted }, FeedParser);
            if (split.status !== 200)
                return terminal("GoogleReader: items/ids request failed", { authToken: authToken, postToken: postToken });

            var parsed = null;
            try {
                parsed = JSON.parse(split.body);
            } catch (e) {
                parsed = null;
            }
            if (!parsed || !parsed.itemRefs || parsed.itemRefs.length === undefined)
                return terminal("GoogleReader: malformed items/ids response", { authToken: authToken, postToken: postToken });

            var ids = [];
            for (var i = 0; i < parsed.itemRefs.length; i++) {
                var ref = parsed.itemRefs[i];
                if (ref && ref.id)
                    ids.push(String(ref.id));
            }

            if (ids.length === 0)
                return { items: [], serverStatus: [], error: null, nextRequest: null, session: { authToken: authToken, postToken: postToken } };

            var next = buildItemsContentsRequest(config, authToken, postToken, ids, { linkIndex: linkIndex + 1, reauthAttempted: reauthAttempted }, FeedParser);
            if (!next)
                return terminal("GoogleReader: chain link limit exceeded", { authToken: authToken, postToken: postToken });

            return { items: [], serverStatus: [], error: null, nextRequest: next, session: { authToken: authToken, postToken: postToken } };
        }
    };
}

function buildItemsContentsRequest(config, authToken, postToken, ids, chainState, FeedParser) {
    if (!chainLinkAllowed(chainState.linkIndex))
        return null;

    var linkIndex = chainState.linkIndex;
    var reauthAttempted = chainState.reauthAttempted;

    var fields = [["T", postToken]];
    for (var i = 0; i < ids.length; i++)
        fields.push(["i", ids[i]]);

    return {
        argv: greaderCurlArgv("POST", config.greaderUrl, "/reader/api/0/stream/items/contents?output=json", authToken, fields),
        timeoutMs: GREADER_PROC_TIMEOUT_MS,
        meta: { step: "itemsContents", linkIndex: linkIndex },
        parse: function (stdout) {
            var split = splitHttpStatus(stdout);
            if (split.status === 401)
                return handleAuthFailure(config, { linkIndex: linkIndex, reauthAttempted: reauthAttempted }, FeedParser);
            if (split.status !== 200)
                return terminal("GoogleReader: items/contents request failed", { authToken: authToken, postToken: postToken });

            var parsed = null;
            try {
                parsed = JSON.parse(split.body);
            } catch (e) {
                parsed = null;
            }
            if (!parsed || !parsed.items || parsed.items.length === undefined)
                return terminal("GoogleReader: malformed items/contents response", { authToken: authToken, postToken: postToken });

            var result = parseGreaderItems(parsed.items, config, FeedParser);
            return {
                items: result.items,
                serverStatus: result.serverStatus,
                error: null,
                nextRequest: null,
                session: { authToken: authToken, postToken: postToken }
            };
        }
    };
}

// ─── mutations (edit-tag) ───────────────────────────────────────────────
//
// Unlike fetchRequests, these never chain: without a cached session there
// is no way to build a valid edit-tag call (no post token to send), so they
// simply refuse (return null) rather than attempt a fetch-style
// reauth cascade. The caller is expected to have a session from a prior
// successful fetch before it lets the user mark/star anything.
function greaderEditTagRequest(config, session, ids, addTag, removeTag) {
    if (!greaderConfigReady(config))
        return null;
    if (!session || !session.authToken || !session.postToken)
        return null;

    var list = [];
    for (var i = 0; i < (ids || []).length; i++) {
        if (ids[i])
            list.push(String(ids[i]));
    }
    if (list.length === 0)
        return null;

    var fields = [["T", session.postToken]];
    for (var j = 0; j < list.length; j++)
        fields.push(["i", list[j]]);
    if (addTag)
        fields.push(["a", addTag]);
    if (removeTag)
        fields.push(["r", removeTag]);

    return {
        argv: greaderCurlArgv("POST", config.greaderUrl, "/reader/api/0/edit-tag", session.authToken, fields),
        timeoutMs: GREADER_PROC_TIMEOUT_MS,
        parse: function (stdout) { return null; }
    };
}

// ─── factory ────────────────────────────────────────────────────────────

function createGoogleReaderBackend(deps) {
    var FeedParser = deps && deps.FeedParser;
    var ReaderState = deps && deps.ReaderState;

    return {
        id: "greader",

        // subscribe: true because /accounts/ClientLogin + quickadd exist;
        // categories: true because subscription/list returns them. Neither
        // needs UI yet -- these flags just stop the UI asking which backend
        // it has.
        capabilities: {
            serverState: true,
            star: true,
            subscribe: true,
            categories: true,
            fullText: false
        },

        // config: { greaderUrl, greaderUsername, greaderPassword, maxItems,
        // showStarred }. session: { authToken, postToken } | null/undefined.
        // Always a single-element array (the head of the chain) or []
        // when the config isn't usable yet, matching the Phase 0 contract;
        // the REST of the chain travels via parse()'s nextRequest.
        fetchRequests: function (config, session) {
            if (!greaderConfigReady(config))
                return [];

            var sess = session || {};
            var chainState = { linkIndex: 1, reauthAttempted: false };
            var head;

            if (sess.authToken && sess.postToken)
                head = buildItemsIdsRequest(config, sess.authToken, sess.postToken, chainState, FeedParser);
            else if (sess.authToken)
                head = buildTokenRequest(config, sess.authToken, chainState, FeedParser);
            else
                head = buildClientLoginRequest(config, chainState, FeedParser);

            return head ? [head] : [];
        },

        configState: function (config) {
            if (!greaderConfigReady(config))
                return { ok: false, reason: "unconfigured" };
            return { ok: true, reason: null };
        },

        // ids: raw decimal id strings (the "r:" prefix already stripped by
        // the caller), mirroring Miniflux's markReadRequest convention.
        markReadRequest: function (config, session, ids) {
            return greaderEditTagRequest(config, session, ids, READ_TAG, null);
        },
        markUnreadRequest: function (config, session, ids) {
            return greaderEditTagRequest(config, session, ids, null, READ_TAG);
        },
        // Google Reader's edit-tag has no toggle semantics -- it is always
        // an explicit add or remove -- so unlike Standard/Miniflux this
        // needs the CURRENT starred state from the caller to know which.
        toggleStarRequest: function (config, session, id, currentlyStarred) {
            if (!id)
                return null;
            return currentlyStarred
                ? greaderEditTagRequest(config, session, [id], null, STARRED_TAG)
                : greaderEditTagRequest(config, session, [id], STARRED_TAG, null);
        },

        // Server wins on fetch reconciliation, same as Miniflux -- delegates
        // straight to the existing, already-tested ReaderState function.
        reconcile: function (localState, serverEntries) {
            var ls = localState || {};
            return ReaderState.reconcileServerStatus(ls.readOrder, ls.bookmarkOrder, serverEntries, ls.cap);
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createGoogleReaderBackend: createGoogleReaderBackend,
        normalizeGreaderId: normalizeGreaderId,
        MAX_CHAIN_LINKS: MAX_CHAIN_LINKS
    };
}
