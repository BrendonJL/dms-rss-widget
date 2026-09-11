// Pure reader-state helpers for the Dank RSS Widget.
//
// Shared with QML/Node like FeedParser.js — see README.md's "Architecture"
// section for the dual-load mechanism and the `.pragma library` rule (kept
// once, in FeedParser.js). See also docs/plans/v2-contract.md.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness — what makes the read/seen/notification rules testable without
// a running shell.

var DEFAULT_CAP = 1000;

// Dedupe preserving first-seen (newest-first) order, then bound the length.
// Non-string and empty entries are dropped so a corrupted state file cannot
// poison the list.
function boundIdList(ids, cap) {
    var limit = (typeof cap === "number" && cap > 0) ? cap : DEFAULT_CAP;
    var out = [];
    if (!ids || ids.length === undefined) {
        return out;
    }
    var seen = {};
    for (var i = 0; i < ids.length && out.length < limit; i++) {
        var v = ids[i];
        if (typeof v === "string" && v.length > 0 && !seen[v]) {
            seen[v] = true;
            out.push(v);
        }
    }
    return out;
}

// Build an O(1) lookup map from an id list.
function buildIdMap(ids) {
    var map = {};
    if (!ids || ids.length === undefined) {
        return map;
    }
    for (var i = 0; i < ids.length; i++) {
        if (typeof ids[i] === "string" && ids[i].length > 0) {
            map[ids[i]] = true;
        }
    }
    return map;
}

// Ids present in `currentIds` that are absent from `seenIds`.
function computeNewIds(currentIds, seenIds) {
    var seenMap = buildIdMap(seenIds);
    var out = [];
    var emitted = {};
    if (!currentIds || currentIds.length === undefined) {
        return out;
    }
    for (var i = 0; i < currentIds.length; i++) {
        var id = currentIds[i];
        if (typeof id !== "string" || id.length === 0) {
            continue;
        }
        if (!seenMap[id] && !emitted[id]) {
            emitted[id] = true;
            out.push(id);
        }
    }
    return out;
}

// The notification decision, in one pure function.
//
// Anti-spam rule: when the seen history is empty this is the first run ever,
// so the entire backlog is recorded silently and nothing is announced.
// Returns { firstRun, newIds, newCount, mergedSeen }.
function evaluateSeen(currentIds, seenIds, cap) {
    var firstRun = !seenIds || seenIds.length === 0;
    var newIds = firstRun ? [] : computeNewIds(currentIds, seenIds);
    var merged = boundIdList((currentIds || []).concat(seenIds || []), cap);
    return {
        firstRun: firstRun,
        newIds: newIds,
        newCount: newIds.length,
        mergedSeen: merged
    };
}

// Mark one id read: newest-first, no duplicates, bounded.
function addRead(readOrder, id, cap) {
    if (typeof id !== "string" || id.length === 0) {
        return boundIdList(readOrder, cap);
    }
    return boundIdList([id].concat(readOrder || []), cap);
}

// Unmark one id.
function removeRead(readOrder, id) {
    var out = [];
    if (!readOrder || readOrder.length === undefined) {
        return out;
    }
    for (var i = 0; i < readOrder.length; i++) {
        if (readOrder[i] !== id) {
            out.push(readOrder[i]);
        }
    }
    return out;
}

// Mark every supplied id read (used by "Mark all read").
function addAllRead(readOrder, ids, cap) {
    var incoming = [];
    if (ids && ids.length !== undefined) {
        for (var i = 0; i < ids.length; i++) {
            if (typeof ids[i] === "string" && ids[i].length > 0) {
                incoming.push(ids[i]);
            }
        }
    }
    return boundIdList(incoming.concat(readOrder || []), cap);
}

// Unmark every supplied id (used by "Mark all unread"). Ids read earlier that
// are not part of the current view are preserved.
function removeAllRead(readOrder, ids) {
    var drop = buildIdMap(ids);
    var out = [];
    if (!readOrder || readOrder.length === undefined) {
        return out;
    }
    for (var i = 0; i < readOrder.length; i++) {
        if (!drop[readOrder[i]]) {
            out.push(readOrder[i]);
        }
    }
    return out;
}

// Count items whose id is not in the read map.
function countUnread(items, readMap) {
    var n = 0;
    if (!items || items.length === undefined) {
        return 0;
    }
    for (var i = 0; i < items.length; i++) {
        var id = items[i] ? items[i].id : "";
        if (!id || !readMap || !readMap[id]) {
            n++;
        }
    }
    return n;
}

// --- Persistence capability detection ---------------------------------------
//
// DMS does NOT hand every plugin the same service object. A desktop-widget
// INSTANCE receives `instanceScopedPluginService` from DesktopPluginWrapper.qml,
// a reduced shim exposing only loadPluginData/savePluginData/getPluginVariants/
// isPluginLoaded. It has no loadPluginState/savePluginState, so calling those
// on an instance throws — which previously aborted startup and stopped the
// widget from fetching at all. Always feature-detect before use.

function hasStateApi(service) {
    return !!service
        && typeof service === "object"
        && typeof service.loadPluginState === "function"
        && typeof service.savePluginState === "function";
}

// Pick the first service that can actually persist state, else null.
function resolveStateService(preferred, fallback) {
    if (hasStateApi(preferred)) {
        return preferred;
    }
    if (hasStateApi(fallback)) {
        return fallback;
    }
    return null;
}

// --- Bookmarks -------------------------------------------------------------
//
// Bookmarks are stored as a newest-first id list, same shape as read/seen
// history, so they persist through the same state-tier mechanism. They are
// bounded too, but a user's explicit bookmark is more valuable than a read
// flag, so the cap exists only as a runaway guard — newest entries survive.

function isBookmarked(bookmarkMap, id) {
    return !!(id && bookmarkMap && bookmarkMap[id]);
}

function toggleBookmark(bookmarkOrder, id, cap) {
    if (typeof id !== "string" || id.length === 0) {
        return boundIdList(bookmarkOrder, cap);
    }
    var map = buildIdMap(bookmarkOrder);
    if (map[id]) {
        return removeRead(bookmarkOrder, id);
    }
    return boundIdList([id].concat(bookmarkOrder || []), cap);
}

function countBookmarked(items, bookmarkMap) {
    var n = 0;
    if (!items || items.length === undefined) {
        return 0;
    }
    for (var i = 0; i < items.length; i++) {
        var id = items[i] ? items[i].id : "";
        if (isBookmarked(bookmarkMap, id)) {
            n++;
        }
    }
    return n;
}

// --- Search + filtering ----------------------------------------------------

// Split a raw query into lowercase terms. Multiple terms are ANDed, so
// "linux kernel" matches an item containing both words in any order and in
// any of the searched fields.
function tokenizeQuery(query) {
    if (typeof query !== "string") {
        return [];
    }
    var trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) {
        return [];
    }
    var raw = trimmed.split(/\s+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        if (raw[i].length > 0) {
            out.push(raw[i]);
        }
    }
    return out;
}

// The text a search query is matched against: title, description, source.
function itemHaystack(item) {
    if (!item) {
        return "";
    }
    var title = item.title || "";
    var description = item.description || "";
    var source = item.source || "";
    return (title + " " + description + " " + source).toLowerCase();
}

function matchesTokens(item, tokens) {
    if (!tokens || tokens.length === 0) {
        return true;
    }
    var hay = itemHaystack(item);
    for (var i = 0; i < tokens.length; i++) {
        if (hay.indexOf(tokens[i]) === -1) {
            return false;
        }
    }
    return true;
}

function matchesQuery(item, query) {
    return matchesTokens(item, tokenizeQuery(query));
}

// Apply the view filter AND the search query together. `options` is
// { mode, query, readMap, bookmarkMap } where mode is "all" | "unread" |
// "bookmarked". An item with no id is treated as unread and un-bookmarked
// rather than being dropped.
function filterItems(items, options) {
    var opts = options || {};
    var mode = opts.mode || "all";
    var readMap = opts.readMap || {};
    var bookmarkMap = opts.bookmarkMap || {};
    var tokens = tokenizeQuery(opts.query);

    var out = [];
    if (!items || items.length === undefined) {
        return out;
    }

    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item) {
            continue;
        }
        var id = item.id || "";

        if (mode === "unread" && id && readMap[id]) {
            continue;
        }
        if (mode === "bookmarked" && !isBookmarked(bookmarkMap, id)) {
            continue;
        }
        if (!matchesTokens(item, tokens)) {
            continue;
        }
        out.push(item);
    }
    return out;
}

// Classify one finished curl attempt into a fetch state (ok/timeout/error).
// `exitCode` 124 is what Proc.runCommand synthesizes on its own timeout.

// Human-readable curl failures. "curl exit 6" is accurate and useless to the
// person reading it in the settings panel; every one of these is a thing the
// user can act on (fix a typo, start the server, check the certificate).
// The numeric code is kept in parentheses so a bug report is still diagnosable.
//
// Codes are curl's documented exit statuses. 22 arrives via --fail-with-body,
// which is what makes an HTTP 4xx/5xx a nonzero exit at all -- without it
// those returned 0 and were silently treated as success.
var CURL_EXIT_MESSAGES = {
    1: "Unsupported protocol",
    3: "Malformed URL",
    5: "Could not resolve proxy",
    6: "Could not resolve host",
    7: "Could not connect to server",
    22: "Server returned an error",
    23: "Write error",
    28: "Timed out",
    35: "TLS handshake failed",
    47: "Too many redirects",
    52: "Empty reply from server",
    56: "Connection lost while receiving",
    60: "Certificate could not be verified",
    63: "Response exceeded the size limit"
};

function curlExitMessage(exitCode) {
    var known = CURL_EXIT_MESSAGES[exitCode];
    return known ? known + " (curl " + exitCode + ")" : "Fetch failed (curl " + exitCode + ")";
}
function classifyFetch(exitCode, output, parsedCount) {
    if (exitCode === 124) {
        return { state: "timeout", lastError: "Timed out" };
    }
    if (exitCode !== 0) {
        return { state: "error", lastError: curlExitMessage(exitCode) };
    }
    if (!output || output.trim().length === 0) {
        return { state: "error", lastError: "Empty response" };
    }
    if (!parsedCount) {
        return { state: "error", lastError: "No items found" };
    }
    return { state: "ok", lastError: "" };
}

// A feed with no `enabled` key is enabled. This is the migration rule for
// configs written before per-feed enable/disable existed.
function isFeedEnabled(feed) {
    return !!feed && feed.enabled !== false;
}

// Position of each configured feed, keyed by URL. Used so that "group by feed"
// sorting honors the order the user arranged in settings instead of sorting
// source names alphabetically. Keyed by URL, not display name, because names
// can repeat or be blank while the URL uniquely identifies a configured feed.
function feedOrderMap(feeds) {
    var map = {};
    if (!feeds || feeds.length === undefined) {
        return map;
    }
    for (var i = 0; i < feeds.length; i++) {
        var f = feeds[i];
        if (f && f.url && map[f.url] === undefined) {
            map[f.url] = i;
        }
    }
    return map;
}

// Sort comparator for "group by feed": configured feed order first, then
// newest-first within each feed. Items from an unknown feed sort last.
var UNRANKED = 999999;

function compareByFeedOrder(a, b, orderMap) {
    var ai = (orderMap && orderMap[a ? a.sourceUrl : ""] !== undefined)
        ? orderMap[a.sourceUrl] : UNRANKED;
    var bi = (orderMap && orderMap[b ? b.sourceUrl : ""] !== undefined)
        ? orderMap[b.sourceUrl] : UNRANKED;
    if (ai !== bi) {
        return ai - bi;
    }
    return ((b ? b.timestamp : 0) || 0) - ((a ? a.timestamp : 0) || 0);
}

// --- Selection (transient, in-memory only) ---------------------------------
//
// Selection is a plain { id: true } map, NOT a boundIdList array: it is
// never persisted, has no cap, and order is irrelevant — only membership
// matters. Mirrors the readMap/bookmarkMap shape the QML layer already
// consumes directly.

function toggleSelected(selectedMap, id) {
    if (typeof id !== "string" || id.length === 0) {
        return selectedMap || {};
    }
    var map = Object.assign({}, selectedMap || {});
    if (map[id]) {
        delete map[id];
    } else {
        map[id] = true;
    }
    return map;
}

function clearSelection() {
    return {};
}

function countSelected(selectedMap) {
    if (!selectedMap) return 0;
    return Object.keys(selectedMap).filter(function (k) { return selectedMap[k]; }).length;
}

// Count how many selected ids are present in `items` (the intersection).
// Used to render the "N hidden" portion of the selection count once
// selection is allowed to exceed the visible/filtered set.
function countSelectedIn(selectedMap, items) {
    if (!selectedMap) return 0;
    var present = buildIdMap((items || []).map(function (i) { return i ? i.id : ""; }));
    var count = 0;
    for (var k in selectedMap) {
        if (selectedMap[k] && present[k]) {
            count++;
        }
    }
    return count;
}

// Drop any selected id whose item has left the dataset entirely. The
// caller passes the full dataset, not the filtered/visible view — selection
// is intentionally allowed to exceed what's on screen (search, filter chips)
// and is only cleared for an id when a refresh evicts it from `items`.
function pruneSelected(selectedMap, items) {
    if (!selectedMap) return {};
    var present = buildIdMap((items || []).map(function (i) { return i ? i.id : ""; }));
    var out = {};
    for (var k in selectedMap) {
        if (selectedMap[k] && present[k]) {
            out[k] = true;
        }
    }
    return out;
}

// Bulk-bookmark, additive only — mirrors addAllRead exactly (same
// generic "prepend + dedupe + cap" list operation), given a distinct name
// at the bookmark call sites so the code reads correctly there. Delegates
// to addAllRead rather than duplicating its body.
function addAllBookmarked(bookmarkOrder, ids, cap) {
    return addAllRead(bookmarkOrder, ids, cap);
}


// --- AI summary cache -------------------------------------------------------
//
// Summaries cost ~5s of GPU time each (measured: qwen3:8b on an RTX 2070
// Super, two sentences from a ~120-word article), so asking twice for the same
// article must never cost twice. The cache survives restarts: an article does
// not change, so a summary of it does not go stale.
//
// Bounded like readOrder/bookmarkOrder, but at a much lower cap. Those store
// ids; this stores paragraphs, and the whole state file is rewritten on every
// change. 100 entries of a few hundred characters is tens of KB per write,
// which is a different order of cost from a list of ids.
var DEFAULT_SUMMARY_CAP = 100;

// Newest first, deduped, capped -- the same shape as boundIdList, but carrying
// a value per id. Returns { order, map }, both replaced rather than mutated so
// a QML property assignment fires its change notification.
function addSummary(order, map, id, text, cap) {
    var limit = (typeof cap === "number" && cap > 0) ? cap : DEFAULT_SUMMARY_CAP;
    if (typeof id !== "string" || id.length === 0 || typeof text !== "string") {
        return { order: (order || []).slice(), map: shallowCopy(map) };
    }

    // `seen` guards against duplicates already present in `order`, not just
    // against the id being inserted. addSummary is the only writer and keeps
    // the invariant itself, so a duplicate can only arrive from a corrupted or
    // hand-edited state file -- and boundIdList, which read and bookmark
    // history use, self-heals exactly that case. A cache that stayed corrupt
    // where the other lists recover would be a surprising asymmetry.
    var nextOrder = [id];
    var seen = {};
    seen[id] = true;
    var src = order || [];
    for (var i = 0; i < src.length && nextOrder.length < limit; i++) {
        var candidate = src[i];
        if (typeof candidate === "string" && candidate.length > 0 && !seen[candidate]) {
            seen[candidate] = true;
            nextOrder.push(candidate);
        }
    }

    // Rebuild the map from the bounded order, so an entry evicted from the
    // list cannot linger in the map and grow the state file forever. Doing it
    // the other way round -- deleting keys as they fall off -- is the same
    // thing with one more chance to leak.
    var nextMap = {};
    var prev = map || {};
    for (var j = 0; j < nextOrder.length; j++) {
        var key = nextOrder[j];
        nextMap[key] = (key === id) ? text : prev[key];
        if (typeof nextMap[key] !== "string") {
            nextMap[key] = "";
        }
    }
    return { order: nextOrder, map: nextMap };
}

function shallowCopy(obj) {
    var out = {};
    var src = obj || {};
    for (var k in src) {
        if (typeof src[k] === "string") {
            out[k] = src[k];
        }
    }
    return out;
}

// "" is a real cached value (a model can legitimately return nothing), so
// callers must distinguish absent from empty. null means absent.
function getSummary(map, id) {
    if (!map || typeof id !== "string") {
        return null;
    }
    return (typeof map[id] === "string") ? map[id] : null;
}

function hasSummary(map, id) {
    return getSummary(map, id) !== null;
}

// Drop cached summaries for ids no longer in the dataset, mirroring
// pruneSelected. Called on refresh so the cache tracks what the user can
// actually see rather than growing until it hits the cap.
function pruneSummaries(order, map, items) {
    var present = buildIdMap((items || []).map(function (i) { return i ? i.id : ""; }));
    var nextOrder = [];
    var nextMap = {};
    var src = order || [];
    for (var i = 0; i < src.length; i++) {
        var id = src[i];
        if (present[id] && typeof (map || {})[id] === "string") {
            nextOrder.push(id);
            nextMap[id] = map[id];
        }
    }
    return { order: nextOrder, map: nextMap };
}
// --- Miniflux server-status reconciliation ----------------------------------
//
// Called ONLY right after a successful Miniflux fetch, so the server's view
// (which already reflects any local push this widget made moments earlier)
// is applied as the eventual source of truth. `serverEntries` is
// `[{ id, status, starred }]` where `id` is the ALREADY-PREFIXED "m:"+entryId
// string -- prefixing is the caller's job (this file never constructs ids).
// Pure, no I/O -- delegates to addAllRead/addAllBookmarked/removeRead for the
// actual list surgery rather than duplicating that logic.
function reconcileServerStatus(readOrder, bookmarkOrder, serverEntries, cap) {
    var ro = boundIdList(readOrder, cap);
    var bo = boundIdList(bookmarkOrder, cap);
    var readMap = buildIdMap(ro);
    var bookmarkMap = buildIdMap(bo);

    var toMarkRead = [];
    var toMarkUnread = {};
    var toMarkStarred = [];
    var toMarkUnstarred = {};

    var entries = (serverEntries && serverEntries.length !== undefined) ? serverEntries : [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || typeof e.id !== "string" || e.id.length === 0)
            continue;

        if (e.status === "read" && !readMap[e.id]) {
            toMarkRead.push(e.id);
        } else if (e.status === "unread" && readMap[e.id]) {
            toMarkUnread[e.id] = true;
        }

        if (e.starred && !bookmarkMap[e.id]) {
            toMarkStarred.push(e.id);
        } else if (!e.starred && bookmarkMap[e.id]) {
            toMarkUnstarred[e.id] = true;
        }
    }

    var readChanged = toMarkRead.length > 0 || Object.keys(toMarkUnread).length > 0;
    var bookmarkChanged = toMarkStarred.length > 0 || Object.keys(toMarkUnstarred).length > 0;

    // Apply removals before additions so a same-cycle read+unread (or
    // star+unstar) flip on the same id nets out to the server's final state.
    var newReadOrder = ro;
    if (Object.keys(toMarkUnread).length > 0) {
        var filtered = [];
        for (var k = 0; k < ro.length; k++) {
            if (!toMarkUnread[ro[k]])
                filtered.push(ro[k]);
        }
        newReadOrder = filtered;
    }
    if (toMarkRead.length > 0) {
        newReadOrder = addAllRead(newReadOrder, toMarkRead, cap);
    }

    var newBookmarkOrder = bo;
    if (Object.keys(toMarkUnstarred).length > 0) {
        var filteredB = [];
        for (var m = 0; m < bo.length; m++) {
            if (!toMarkUnstarred[bo[m]])
                filteredB.push(bo[m]);
        }
        newBookmarkOrder = filteredB;
    }
    if (toMarkStarred.length > 0) {
        newBookmarkOrder = addAllBookmarked(newBookmarkOrder, toMarkStarred, cap);
    }

    return {
        readOrder: newReadOrder,
        bookmarkOrder: newBookmarkOrder,
        readChanged: readChanged,
        bookmarkChanged: bookmarkChanged
    };
}

// The feeds that a fetch cycle should actually request.
function activeFeeds(feeds) {
    var out = [];
    if (!feeds || feeds.length === undefined) {
        return out;
    }
    for (var i = 0; i < feeds.length; i++) {
        var f = feeds[i];
        if (f && f.url && isFeedEnabled(f)) {
            out.push(f);
        }
    }
    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        DEFAULT_CAP: DEFAULT_CAP,
        hasStateApi: hasStateApi,
        resolveStateService: resolveStateService,
        boundIdList: boundIdList,
        buildIdMap: buildIdMap,
        computeNewIds: computeNewIds,
        evaluateSeen: evaluateSeen,
        addRead: addRead,
        removeRead: removeRead,
        addAllRead: addAllRead,
        removeAllRead: removeAllRead,
        countUnread: countUnread,
        isBookmarked: isBookmarked,
        toggleBookmark: toggleBookmark,
        countBookmarked: countBookmarked,
        tokenizeQuery: tokenizeQuery,
        itemHaystack: itemHaystack,
        matchesQuery: matchesQuery,
        filterItems: filterItems,
        classifyFetch: classifyFetch,
        addSummary: addSummary,
        getSummary: getSummary,
        hasSummary: hasSummary,
        pruneSummaries: pruneSummaries,
        DEFAULT_SUMMARY_CAP: DEFAULT_SUMMARY_CAP,
        curlExitMessage: curlExitMessage,
        isFeedEnabled: isFeedEnabled,
        activeFeeds: activeFeeds,
        feedOrderMap: feedOrderMap,
        compareByFeedOrder: compareByFeedOrder,
        toggleSelected: toggleSelected,
        clearSelection: clearSelection,
        countSelected: countSelected,
        countSelectedIn: countSelectedIn,
        pruneSelected: pruneSelected,
        addAllBookmarked: addAllBookmarked,
        reconcileServerStatus: reconcileServerStatus
    };
}
