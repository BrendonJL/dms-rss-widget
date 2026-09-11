const { test, describe } = require("node:test");
const assert = require("node:assert");

const R = require("../ReaderState.js");

describe("boundIdList", () => {
    test("dedupes preserving first-seen order", () => {
        assert.deepStrictEqual(R.boundIdList(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
    });

    test("bounds to the cap, keeping the newest (front) entries", () => {
        const ids = ["n1", "n2", "n3", "n4", "n5"];
        assert.deepStrictEqual(R.boundIdList(ids, 3), ["n1", "n2", "n3"]);
    });

    test("defaults to a cap of 1000", () => {
        const ids = [];
        for (let i = 0; i < 1500; i++) ids.push("id" + i);
        const out = R.boundIdList(ids);
        assert.strictEqual(out.length, 1000);
        assert.strictEqual(out[0], "id0");
        assert.strictEqual(out[999], "id999");
    });

    test("drops non-string and empty entries from a corrupted state file", () => {
        assert.deepStrictEqual(R.boundIdList(["a", "", null, 42, undefined, "b", {}]), ["a", "b"]);
    });

    test("returns an empty array for null/undefined input", () => {
        assert.deepStrictEqual(R.boundIdList(null), []);
        assert.deepStrictEqual(R.boundIdList(undefined), []);
    });
});

describe("computeNewIds", () => {
    test("returns ids absent from the seen list", () => {
        assert.deepStrictEqual(R.computeNewIds(["a", "b", "c"], ["b"]), ["a", "c"]);
    });

    test("returns empty when everything was already seen", () => {
        assert.deepStrictEqual(R.computeNewIds(["a", "b"], ["a", "b", "z"]), []);
    });

    test("does not report the same new id twice", () => {
        assert.deepStrictEqual(R.computeNewIds(["a", "a", "b"], []), ["a", "b"]);
    });

    test("treats an empty seen list as everything being new", () => {
        assert.deepStrictEqual(R.computeNewIds(["a", "b"], []), ["a", "b"]);
    });
});

describe("evaluateSeen — notification correctness", () => {
    test("first run announces NOTHING but records the whole backlog", () => {
        const r = R.evaluateSeen(["a", "b", "c"], []);
        assert.strictEqual(r.firstRun, true);
        assert.strictEqual(r.newCount, 0, "first run must not spam the backlog");
        assert.deepStrictEqual(r.mergedSeen, ["a", "b", "c"]);
    });

    test("second run announces only genuinely new ids", () => {
        const first = R.evaluateSeen(["a", "b"], []);
        const second = R.evaluateSeen(["c", "a", "b"], first.mergedSeen);
        assert.strictEqual(second.firstRun, false);
        assert.deepStrictEqual(second.newIds, ["c"]);
        assert.strictEqual(second.newCount, 1);
    });

    test("a refetch with no new items announces nothing", () => {
        const first = R.evaluateSeen(["a", "b"], []);
        const second = R.evaluateSeen(["a", "b"], first.mergedSeen);
        assert.strictEqual(second.newCount, 0);
    });

    // This is the regression the old count-based heuristic produced: a feed
    // failing shrinks the total, and the next success then looks like new items.
    test("items disappearing then reappearing does not create phantom notifications", () => {
        const first = R.evaluateSeen(["a", "b", "c"], []);
        const outage = R.evaluateSeen(["a"], first.mergedSeen);
        assert.strictEqual(outage.newCount, 0, "an outage must not announce anything");
        const recovered = R.evaluateSeen(["a", "b", "c"], outage.mergedSeen);
        assert.strictEqual(recovered.newCount, 0, "recovery must not re-announce known items");
    });

    test("merged seen history stays bounded", () => {
        const ids = [];
        for (let i = 0; i < 40; i++) ids.push("x" + i);
        const r = R.evaluateSeen(ids, ["old1", "old2"], 10);
        assert.strictEqual(r.mergedSeen.length, 10);
        assert.strictEqual(r.mergedSeen[0], "x0");
    });
});

describe("read state transitions", () => {
    test("addRead puts the newest id first", () => {
        assert.deepStrictEqual(R.addRead(["b"], "a"), ["a", "b"]);
    });

    test("addRead does not duplicate an already-read id", () => {
        assert.deepStrictEqual(R.addRead(["a", "b"], "a"), ["a", "b"]);
    });

    test("addRead ignores an empty id", () => {
        assert.deepStrictEqual(R.addRead(["a"], ""), ["a"]);
    });

    test("addRead respects the cap", () => {
        assert.deepStrictEqual(R.addRead(["b", "c"], "a", 2), ["a", "b"]);
    });

    test("removeRead drops just that id", () => {
        assert.deepStrictEqual(R.removeRead(["a", "b", "c"], "b"), ["a", "c"]);
    });

    test("removeRead is a no-op for an unknown id", () => {
        assert.deepStrictEqual(R.removeRead(["a"], "zzz"), ["a"]);
    });

    test("addAllRead marks every current id read", () => {
        assert.deepStrictEqual(R.addAllRead(["old"], ["a", "b"]), ["a", "b", "old"]);
    });

    test("removeAllRead preserves read ids outside the current view", () => {
        const out = R.removeAllRead(["a", "b", "older"], ["a", "b"]);
        assert.deepStrictEqual(out, ["older"], "history beyond the visible list must survive");
    });
});

describe("countUnread", () => {
    test("counts items missing from the read map", () => {
        const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
        assert.strictEqual(R.countUnread(items, { b: true }), 2);
    });

    test("counts everything when nothing is read", () => {
        assert.strictEqual(R.countUnread([{ id: "a" }, { id: "b" }], {}), 2);
    });

    test("treats an item with no id as unread rather than crashing", () => {
        assert.strictEqual(R.countUnread([{ id: "" }, { id: "a" }], { a: true }), 1);
    });

    test("returns 0 for an empty list", () => {
        assert.strictEqual(R.countUnread([], { a: true }), 0);
    });
});

describe("classifyFetch — per-feed status", () => {
    test("exit code 124 is reported as a timeout, distinct from a generic error", () => {
        const r = R.classifyFetch(124, "", 0);
        assert.strictEqual(r.state, "timeout");
        assert.strictEqual(r.lastError, "Timed out");
    });


    // "curl exit 6" is accurate and useless to whoever reads it in the
    // settings panel. Each of these is something the user can act on.
    test("common curl failures read as English, keeping the code for triage", () => {
        assert.match(R.classifyFetch(6, "", 0).lastError, /Could not resolve host/);
        assert.match(R.classifyFetch(7, "", 0).lastError, /Could not connect/);
        assert.match(R.classifyFetch(28, "", 0).lastError, /Timed out/);
        assert.match(R.classifyFetch(60, "", 0).lastError, /Certificate/);
        assert.match(R.classifyFetch(22, "", 0).lastError, /Server returned an error/);
        // the numeric code survives, so a bug report is still diagnosable
        assert.match(R.classifyFetch(6, "", 0).lastError, /curl 6/);
    });

    test("an unmapped exit code still says something useful", () => {
        var r = R.classifyFetch(43, "", 0);
        assert.strictEqual(r.state, "error");
        assert.match(r.lastError, /Fetch failed/);
        assert.match(r.lastError, /43/);
    });

    // 124 is Proc's own timeout, not curl's, and must keep its own state.
    test("124 is still a timeout state, not folded into the curl mapping", () => {
        var r = R.classifyFetch(124, "", 0);
        assert.strictEqual(r.state, "timeout");
        assert.doesNotMatch(r.lastError, /curl/);
    });
    test("a nonzero exit code is an error naming the code", () => {
        const r = R.classifyFetch(6, "", 0);
        assert.strictEqual(r.state, "error");
        assert.match(r.lastError, /6/);
    });

    test("success with empty output is an error, not a silent pass", () => {
        assert.strictEqual(R.classifyFetch(0, "   ", 0).state, "error");
        assert.strictEqual(R.classifyFetch(0, "", 0).lastError, "Empty response");
    });

    test("output that parses to zero items is an error", () => {
        const r = R.classifyFetch(0, "<html>not a feed</html>", 0);
        assert.strictEqual(r.state, "error");
        assert.strictEqual(r.lastError, "No items found");
    });

    test("a good fetch is ok with no error text", () => {
        const r = R.classifyFetch(0, "<rss>...</rss>", 5);
        assert.strictEqual(r.state, "ok");
        assert.strictEqual(r.lastError, "");
    });
});

describe("feed enable/disable migration", () => {
    test("a feed with no enabled key is treated as enabled", () => {
        assert.strictEqual(R.isFeedEnabled({ url: "u" }), true);
    });

    test("enabled:true is enabled", () => {
        assert.strictEqual(R.isFeedEnabled({ url: "u", enabled: true }), true);
    });

    test("only an explicit false disables", () => {
        assert.strictEqual(R.isFeedEnabled({ url: "u", enabled: false }), false);
    });

    test("null/undefined feeds are not enabled", () => {
        assert.strictEqual(R.isFeedEnabled(null), false);
        assert.strictEqual(R.isFeedEnabled(undefined), false);
    });

    test("activeFeeds skips disabled feeds", () => {
        const feeds = [
            { url: "a" },
            { url: "b", enabled: false },
            { url: "c", enabled: true }
        ];
        assert.deepStrictEqual(R.activeFeeds(feeds).map(f => f.url), ["a", "c"]);
    });

    test("activeFeeds skips entries with no url", () => {
        assert.deepStrictEqual(R.activeFeeds([{ name: "no url" }, { url: "x" }]).map(f => f.url), ["x"]);
    });

    test("activeFeeds handles an empty or missing list", () => {
        assert.deepStrictEqual(R.activeFeeds([]), []);
        assert.deepStrictEqual(R.activeFeeds(null), []);
    });
});

describe("bookmarks", () => {
    test("toggling an unbookmarked id adds it at the front", () => {
        assert.deepStrictEqual(R.toggleBookmark(["b"], "a"), ["a", "b"]);
    });

    test("toggling a bookmarked id removes it", () => {
        assert.deepStrictEqual(R.toggleBookmark(["a", "b"], "a"), ["b"]);
    });

    test("toggling twice returns to the original set", () => {
        const once = R.toggleBookmark(["x"], "a");
        const twice = R.toggleBookmark(once, "a");
        assert.deepStrictEqual(twice, ["x"]);
    });

    test("an empty id is ignored", () => {
        assert.deepStrictEqual(R.toggleBookmark(["a"], ""), ["a"]);
    });

    test("bookmarks are bounded, newest kept", () => {
        assert.deepStrictEqual(R.toggleBookmark(["b", "c"], "a", 2), ["a", "b"]);
    });

    test("isBookmarked reads the map safely", () => {
        assert.strictEqual(R.isBookmarked({ a: true }, "a"), true);
        assert.strictEqual(R.isBookmarked({ a: true }, "b"), false);
        assert.strictEqual(R.isBookmarked(null, "a"), false);
        assert.strictEqual(R.isBookmarked({ a: true }, ""), false);
    });

    test("countBookmarked counts only bookmarked items", () => {
        const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
        assert.strictEqual(R.countBookmarked(items, { a: true, c: true }), 2);
    });

    // Bookmarks persist by stable id, so they must survive a refetch that
    // rebuilds the item objects entirely.
    test("bookmark state survives items being reparsed into new objects", () => {
        const bookmarks = R.toggleBookmark([], "g:abc");
        const map = R.buildIdMap(bookmarks);
        const refetched = [{ id: "g:abc", title: "Rebuilt object" }];
        assert.strictEqual(R.countBookmarked(refetched, map), 1);
    });
});

describe("search", () => {
    const items = [
        { id: "1", title: "Linux kernel 7.2 released", description: "New scheduler", source: "LWN" },
        { id: "2", title: "Rust 2.0 announced", description: "Linux support improved", source: "Ars" },
        { id: "3", title: "Weather report", description: "Sunny", source: "BBC" }
    ];

    test("tokenizeQuery lowercases and splits on whitespace", () => {
        assert.deepStrictEqual(R.tokenizeQuery("  Linux   Kernel "), ["linux", "kernel"]);
    });

    test("tokenizeQuery returns empty for blank or non-string input", () => {
        assert.deepStrictEqual(R.tokenizeQuery(""), []);
        assert.deepStrictEqual(R.tokenizeQuery("   "), []);
        assert.deepStrictEqual(R.tokenizeQuery(null), []);
        assert.deepStrictEqual(R.tokenizeQuery(42), []);
    });

    test("matches on title, case-insensitively", () => {
        assert.strictEqual(R.matchesQuery(items[0], "LINUX"), true);
    });

    test("matches on description", () => {
        assert.strictEqual(R.matchesQuery(items[1], "scheduler"), false);
        assert.strictEqual(R.matchesQuery(items[1], "support"), true);
    });

    test("matches on source name", () => {
        assert.strictEqual(R.matchesQuery(items[2], "bbc"), true);
    });

    test("multiple terms are ANDed across fields", () => {
        // "linux" is in the description, "rust" in the title — both must match.
        assert.strictEqual(R.matchesQuery(items[1], "linux rust"), true);
        assert.strictEqual(R.matchesQuery(items[1], "linux weather"), false);
    });

    test("an empty query matches everything", () => {
        assert.strictEqual(R.matchesQuery(items[2], ""), true);
        assert.strictEqual(R.matchesQuery(items[2], "   "), true);
    });

    test("handles items with missing fields without throwing", () => {
        assert.strictEqual(R.matchesQuery({ id: "x" }, "anything"), false);
        assert.strictEqual(R.matchesQuery({ id: "x" }, ""), true);
        assert.strictEqual(R.matchesQuery(null, ""), true);
    });
});

describe("filterItems — search and filters together", () => {
    const items = [
        { id: "a", title: "Linux news", description: "", source: "LWN" },
        { id: "b", title: "Rust news", description: "", source: "Ars" },
        { id: "c", title: "Linux kernel", description: "", source: "LWN" }
    ];
    const readMap = { a: true };
    const bookmarkMap = { a: true, b: true };

    test("mode all with no query returns everything", () => {
        assert.strictEqual(R.filterItems(items, {}).length, 3);
    });

    test("unread mode excludes read items", () => {
        const out = R.filterItems(items, { mode: "unread", readMap: readMap });
        assert.deepStrictEqual(out.map(i => i.id), ["b", "c"]);
    });

    test("bookmarked mode returns only bookmarked items", () => {
        const out = R.filterItems(items, { mode: "bookmarked", bookmarkMap: bookmarkMap });
        assert.deepStrictEqual(out.map(i => i.id), ["a", "b"]);
    });

    test("search narrows within the unread filter", () => {
        const out = R.filterItems(items, { mode: "unread", query: "linux", readMap: readMap });
        assert.deepStrictEqual(out.map(i => i.id), ["c"], "read 'a' excluded, 'b' fails the query");
    });

    test("search narrows within the bookmarked filter", () => {
        const out = R.filterItems(items, { mode: "bookmarked", query: "rust", bookmarkMap: bookmarkMap });
        assert.deepStrictEqual(out.map(i => i.id), ["b"]);
    });

    test("a query matching nothing yields an empty list, not everything", () => {
        assert.deepStrictEqual(R.filterItems(items, { query: "zzzz" }), []);
    });

    test("items with no id are treated as unread and un-bookmarked", () => {
        const odd = [{ id: "", title: "No id" }];
        assert.strictEqual(R.filterItems(odd, { mode: "unread" }).length, 1);
        assert.strictEqual(R.filterItems(odd, { mode: "bookmarked" }).length, 0);
    });

    test("handles null/empty input safely", () => {
        assert.deepStrictEqual(R.filterItems(null, {}), []);
        assert.deepStrictEqual(R.filterItems([], {}), []);
        assert.deepStrictEqual(R.filterItems(items, null).length, 3);
    });

    test("an unknown mode falls back to showing everything", () => {
        assert.strictEqual(R.filterItems(items, { mode: "bogus" }).length, 3);
    });
});

describe("feedOrderMap / compareByFeedOrder — grouped-by-feed ordering", () => {
    const feeds = [
        { name: "Zebra News", url: "https://z.example/rss" },
        { name: "Alpha News", url: "https://a.example/rss" }
    ];

    test("maps each feed url to its configured position", () => {
        assert.deepStrictEqual(R.feedOrderMap(feeds), {
            "https://z.example/rss": 0,
            "https://a.example/rss": 1
        });
    });

    test("ignores feeds with no url and handles empty input", () => {
        assert.deepStrictEqual(R.feedOrderMap([{ name: "no url" }]), {});
        assert.deepStrictEqual(R.feedOrderMap(null), {});
    });

    test("a duplicate url keeps its first position", () => {
        const dup = [{ url: "u" }, { url: "u" }];
        assert.deepStrictEqual(R.feedOrderMap(dup), { u: 0 });
    });

    // The point of the feature: configured order beats alphabetical order.
    test("sorts by configured feed order, not source name", () => {
        const orderMap = R.feedOrderMap(feeds);
        const items = [
            { title: "a1", source: "Alpha News", sourceUrl: "https://a.example/rss", timestamp: 100 },
            { title: "z1", source: "Zebra News", sourceUrl: "https://z.example/rss", timestamp: 50 }
        ];
        items.sort((a, b) => R.compareByFeedOrder(a, b, orderMap));
        assert.deepStrictEqual(items.map(i => i.title), ["z1", "a1"],
            "Zebra is configured first, so it groups first despite sorting later alphabetically");
    });

    test("within one feed, newest comes first", () => {
        const orderMap = R.feedOrderMap(feeds);
        const items = [
            { title: "old", sourceUrl: "https://z.example/rss", timestamp: 10 },
            { title: "new", sourceUrl: "https://z.example/rss", timestamp: 99 }
        ];
        items.sort((a, b) => R.compareByFeedOrder(a, b, orderMap));
        assert.deepStrictEqual(items.map(i => i.title), ["new", "old"]);
    });

    test("items from an unconfigured feed sort last", () => {
        const orderMap = R.feedOrderMap(feeds);
        const items = [
            { title: "orphan", sourceUrl: "https://gone.example/rss", timestamp: 999 },
            { title: "known", sourceUrl: "https://a.example/rss", timestamp: 1 }
        ];
        items.sort((a, b) => R.compareByFeedOrder(a, b, orderMap));
        assert.deepStrictEqual(items.map(i => i.title), ["known", "orphan"]);
    });

    test("reordering the config reverses the grouping", () => {
        const reordered = [feeds[1], feeds[0]];
        const orderMap = R.feedOrderMap(reordered);
        const items = [
            { title: "z1", sourceUrl: "https://z.example/rss", timestamp: 50 },
            { title: "a1", sourceUrl: "https://a.example/rss", timestamp: 100 }
        ];
        items.sort((a, b) => R.compareByFeedOrder(a, b, orderMap));
        assert.deepStrictEqual(items.map(i => i.title), ["a1", "z1"]);
    });

    test("missing timestamps and null items do not throw", () => {
        assert.strictEqual(typeof R.compareByFeedOrder({ sourceUrl: "u" }, { sourceUrl: "u" }, {}), "number");
        assert.strictEqual(typeof R.compareByFeedOrder(null, null, {}), "number");
    });
});

// Regression: DMS injects a REDUCED "instanceScopedPluginService" shim into
// desktop-widget instances. It implements loadPluginData/savePluginData but
// NOT loadPluginState/savePluginState. Calling the missing method threw, which
// aborted Component.onCompleted before the refresh timer started, so the widget
// never fetched anything and showed "No items loaded".
describe("state service capability detection", () => {
    const realService = {
        loadPluginData() {}, savePluginData() {},
        loadPluginState() {}, savePluginState() {}
    };
    // Mirrors DesktopPluginWrapper.qml's instanceScopedPluginService exactly.
    const instanceShim = {
        loadPluginData() {}, savePluginData() {},
        getPluginVariants() {}, isPluginLoaded() {}
    };

    test("detects a service that has the state API", () => {
        assert.strictEqual(R.hasStateApi(realService), true);
    });

    test("rejects the instance shim, which lacks the state API", () => {
        assert.strictEqual(R.hasStateApi(instanceShim), false);
    });

    test("rejects null/undefined and non-objects", () => {
        assert.strictEqual(R.hasStateApi(null), false);
        assert.strictEqual(R.hasStateApi(undefined), false);
        assert.strictEqual(R.hasStateApi("nope"), false);
    });

    test("rejects a service with only half the state API", () => {
        assert.strictEqual(R.hasStateApi({ loadPluginState() {} }), false);
        assert.strictEqual(R.hasStateApi({ savePluginState() {} }), false);
    });

    test("resolver prefers the real service over the injected shim", () => {
        assert.strictEqual(R.resolveStateService(realService, instanceShim), realService);
    });

    test("resolver falls back to the injected service when the preferred one lacks the API", () => {
        assert.strictEqual(R.resolveStateService(instanceShim, realService), realService);
    });

    test("resolver returns null when neither can persist, rather than throwing", () => {
        assert.strictEqual(R.resolveStateService(instanceShim, null), null);
        assert.strictEqual(R.resolveStateService(null, null), null);
    });
});

describe("selection", () => {
    test("toggleSelected adds an unselected id", () => {
        assert.deepStrictEqual(R.toggleSelected({}, "a"), { a: true });
    });

    test("toggleSelected removes a selected id", () => {
        assert.deepStrictEqual(R.toggleSelected({ a: true }, "a"), {});
    });

    test("toggleSelected ignores an empty/invalid id", () => {
        assert.deepStrictEqual(R.toggleSelected({ a: true }, ""), { a: true });
        assert.deepStrictEqual(R.toggleSelected({ a: true }, null), { a: true });
    });

    test("clearSelection always returns an empty map", () => {
        assert.deepStrictEqual(R.clearSelection(), {});
    });

    test("countSelected counts truthy keys only", () => {
        assert.strictEqual(R.countSelected({ a: true, b: true }), 2);
        assert.strictEqual(R.countSelected({}), 0);
        assert.strictEqual(R.countSelected(null), 0);
    });

    test("pruneSelected drops ids whose item is no longer present", () => {
        const items = [{ id: "a" }, { id: "c" }];
        const out = R.pruneSelected({ a: true, b: true, c: true }, items);
        assert.deepStrictEqual(out, { a: true, c: true });
    });

    test("pruneSelected on an empty item set clears everything", () => {
        assert.deepStrictEqual(R.pruneSelected({ a: true }, []), {});
    });

    test("pruneSelected handles an empty selection safely", () => {
        assert.deepStrictEqual(R.pruneSelected({}, [{ id: "a" }]), {});
        assert.deepStrictEqual(R.pruneSelected(null, [{ id: "a" }]), {});
    });

    test("pruneSelected keeps an id present in the dataset but absent from a filtered view", () => {
        const allItems = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const filteredView = [{ id: "b" }];
        const out = R.pruneSelected({ a: true, b: true, c: true }, allItems);
        assert.deepStrictEqual(out, { a: true, b: true, c: true });
        // Sanity check: the same ids would have been dropped against the filtered view.
        assert.deepStrictEqual(R.pruneSelected({ a: true, b: true, c: true }, filteredView), { b: true });
    });

    test("pruneSelected still drops an id absent from the dataset entirely", () => {
        const allItems = [{ id: "a" }, { id: "c" }];
        const out = R.pruneSelected({ a: true, b: true, c: true }, allItems);
        assert.deepStrictEqual(out, { a: true, c: true });
    });

    test("countSelectedIn returns the size of the intersection", () => {
        const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
        assert.strictEqual(R.countSelectedIn({ a: true, b: true }, items), 2);
        assert.strictEqual(R.countSelectedIn({ a: true, z: true }, items), 1);
    });

    test("countSelectedIn returns 0 for an empty or null map", () => {
        const items = [{ id: "a" }];
        assert.strictEqual(R.countSelectedIn({}, items), 0);
        assert.strictEqual(R.countSelectedIn(null, items), 0);
    });

    test("countSelectedIn ignores keys whose value is falsy", () => {
        const items = [{ id: "a" }, { id: "b" }];
        assert.strictEqual(R.countSelectedIn({ a: true, b: false }, items), 1);
    });

    test("selection survives a filter round-trip: select, filter down, restore", () => {
        const allItems = [{ id: "a" }, { id: "b" }, { id: "c" }];
        let selectedMap = {};
        selectedMap = R.toggleSelected(selectedMap, "a");
        selectedMap = R.toggleSelected(selectedMap, "b");
        selectedMap = R.toggleSelected(selectedMap, "c");

        const filteredView = [{ id: "b" }];
        selectedMap = R.pruneSelected(selectedMap, allItems);
        assert.strictEqual(R.countSelectedIn(selectedMap, filteredView), 1);
        assert.strictEqual(R.countSelected(selectedMap), 3);

        selectedMap = R.pruneSelected(selectedMap, allItems);
        assert.strictEqual(R.countSelected(selectedMap), 3);
    });
});

describe("addAllBookmarked", () => {
    test("adds all selected ids to the front, newest first", () => {
        assert.deepStrictEqual(R.addAllBookmarked(["old"], ["a", "b"]), ["a", "b", "old"]);
    });

    test("bulk save when some items are already bookmarked does not duplicate them", () => {
        const out = R.addAllBookmarked(["a", "old"], ["a", "b"]);
        assert.deepStrictEqual(out, ["a", "b", "old"]);
    });

    test("respects the cap", () => {
        assert.deepStrictEqual(R.addAllBookmarked(["c"], ["a", "b"], 2), ["a", "b"]);
    });

    test("empty ids list is a no-op beyond dedup/cap of the existing order", () => {
        assert.deepStrictEqual(R.addAllBookmarked(["x", "y"], []), ["x", "y"]);
    });
});

describe("AI summary cache", () => {
    test("insert then read back", () => {
        const r = R.addSummary([], {}, "a", "Summary of a.");
        assert.deepStrictEqual(r.order, ["a"]);
        assert.strictEqual(R.getSummary(r.map, "a"), "Summary of a.");
    });

    test("re-inserting an existing id moves it to newest, replaces text, no duplicate in order", () => {
        let state = R.addSummary([], {}, "a", "first");
        state = R.addSummary(state.order, state.map, "b", "second");
        state = R.addSummary(state.order, state.map, "a", "updated");
        assert.deepStrictEqual(state.order, ["a", "b"]);
        assert.strictEqual(R.getSummary(state.map, "a"), "updated");
        assert.strictEqual(R.getSummary(state.map, "b"), "second");
    });

    test("cap evicts oldest-first, and the evicted id is gone from map too (not just order)", () => {
        let state = { order: [], map: {} };
        state = R.addSummary(state.order, state.map, "a", "sa", 2);
        state = R.addSummary(state.order, state.map, "b", "sb", 2);
        state = R.addSummary(state.order, state.map, "c", "sc", 2);
        assert.deepStrictEqual(state.order, ["c", "b"]);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(state.map, "a"), false,
            "evicted id must not linger in the map -- that's exactly the leak that would grow the state file forever");
        assert.strictEqual(R.getSummary(state.map, "a"), null);
        assert.strictEqual(Object.keys(state.map).length, 2);
    });

    test("default cap is DEFAULT_SUMMARY_CAP", () => {
        assert.strictEqual(R.DEFAULT_SUMMARY_CAP, 100);
        let state = { order: [], map: {} };
        for (let i = 0; i < 150; i++) {
            state = R.addSummary(state.order, state.map, "id" + i, "s" + i);
        }
        assert.strictEqual(state.order.length, 100);
        assert.strictEqual(Object.keys(state.map).length, 100);
        assert.strictEqual(R.getSummary(state.map, "id0"), null, "oldest evicted");
        assert.strictEqual(R.getSummary(state.map, "id149"), "s149");
    });

    test('"" is a real cached value, distinct from absent', () => {
        const r = R.addSummary([], {}, "empty", "");
        assert.strictEqual(R.getSummary(r.map, "empty"), "");
        assert.strictEqual(R.hasSummary(r.map, "empty"), true);
        assert.strictEqual(R.getSummary(r.map, "unknown"), null);
        assert.strictEqual(R.hasSummary(r.map, "unknown"), false);
    });

    test("addSummary never throws on garbage input and does not corrupt the structure", () => {
        assert.doesNotThrow(() => R.addSummary(null, null, "a", "text"));
        assert.doesNotThrow(() => R.addSummary(undefined, undefined, "a", "text"));

        let r = R.addSummary(null, null, "a", "text");
        assert.deepStrictEqual(r.order, ["a"]);
        assert.strictEqual(r.map.a, "text");

        // non-string id
        r = R.addSummary(["a"], { a: "x" }, 42, "text");
        assert.deepStrictEqual(r.order, ["a"]);
        assert.deepStrictEqual(r.map, { a: "x" });

        // non-string text
        r = R.addSummary(["a"], { a: "x" }, "b", { not: "a string" });
        assert.deepStrictEqual(r.order, ["a"]);
        assert.deepStrictEqual(r.map, { a: "x" });

        // empty id
        r = R.addSummary(["a"], { a: "x" }, "", "text");
        assert.deepStrictEqual(r.order, ["a"]);
        assert.deepStrictEqual(r.map, { a: "x" });

        assert.doesNotThrow(() => R.getSummary(null, "a"));
        assert.strictEqual(R.getSummary(null, "a"), null);
        assert.strictEqual(R.getSummary({ a: "x" }, null), null);
        assert.strictEqual(R.hasSummary(null, "a"), false);

        assert.doesNotThrow(() => R.pruneSummaries(null, null, null));
        assert.deepStrictEqual(R.pruneSummaries(null, null, null), { order: [], map: {} });
    });

    test("pruneSummaries drops ids absent from the items list and keeps the rest", () => {
        let state = { order: [], map: {} };
        state = R.addSummary(state.order, state.map, "a", "sa");
        state = R.addSummary(state.order, state.map, "b", "sb");
        state = R.addSummary(state.order, state.map, "c", "sc");
        const items = [{ id: "a" }, { id: "c" }];
        const pruned = R.pruneSummaries(state.order, state.map, items);
        // state.order is newest-first ["c", "b", "a"]; pruning "b" preserves
        // the remaining relative order.
        assert.deepStrictEqual(pruned.order, ["c", "a"]);
        assert.deepStrictEqual(pruned.map, { a: "sa", c: "sc" });
    });

    // Summaries key off the stable id, not object identity -- equivalent to
    // the "bookmark state survives items being reparsed into new objects"
    // test above.
    test("a summary survives its item being reparsed into a brand-new object", () => {
        const r = R.addSummary([], {}, "g:abc", "Cached summary.");
        const refetched = [{ id: "g:abc", title: "Rebuilt object" }];
        assert.strictEqual(R.hasSummary(r.map, refetched[0].id), true);
        assert.strictEqual(R.getSummary(r.map, refetched[0].id), "Cached summary.");
        // and it survives a prune against the refetched dataset too
        const pruned = R.pruneSummaries(r.order, r.map, refetched);
        assert.strictEqual(R.getSummary(pruned.map, "g:abc"), "Cached summary.");
    });

    // addSummary is the only writer and keeps the no-duplicates invariant
    // itself, so a duplicate can only come from a corrupted or hand-edited
    // state file. boundIdList -- which read and bookmark history use --
    // self-heals that, and a cache that stayed corrupt where the other lists
    // recover would be a surprising asymmetry.
    test("addSummary heals pre-existing duplicates in order, like boundIdList", () => {
        const r = R.addSummary(["a", "b", "a"], { a: "sa", b: "sb" }, "c", "sc");
        assert.deepStrictEqual(r.order, ["c", "a", "b"]);
        assert.deepStrictEqual(Object.keys(r.map).sort(), ["a", "b", "c"]);
    });
});

describe("reconcileServerStatus", () => {
    test("server marks an id read that's currently absent -> added, readChanged true", () => {
        const result = R.reconcileServerStatus([], [], [{ id: "m:1", status: "read", starred: false }]);
        assert.deepStrictEqual(result.readOrder, ["m:1"]);
        assert.strictEqual(result.readChanged, true);
        assert.strictEqual(result.bookmarkChanged, false);
    });

    test("server marks an id unread that IS in readOrder -> removed, readChanged true", () => {
        const result = R.reconcileServerStatus(["m:1", "m:2"], [], [{ id: "m:1", status: "unread", starred: false }]);
        assert.deepStrictEqual(result.readOrder, ["m:2"]);
        assert.strictEqual(result.readChanged, true);
    });

    test("no-op when server status already matches local state", () => {
        const result = R.reconcileServerStatus(["m:1"], ["m:2"], [
            { id: "m:1", status: "read", starred: false },
            { id: "m:2", status: "unread", starred: true }
        ]);
        assert.deepStrictEqual(result.readOrder, ["m:1"]);
        assert.deepStrictEqual(result.bookmarkOrder, ["m:2"]);
        assert.strictEqual(result.readChanged, false);
        assert.strictEqual(result.bookmarkChanged, false);
    });

    test("mixed batch: read added, read removed, starred added all in one call", () => {
        const result = R.reconcileServerStatus(
            ["m:2"], [],
            [
                { id: "m:1", status: "read", starred: true },
                { id: "m:2", status: "unread", starred: false },
                { id: "m:3", status: "unread", starred: false }
            ]
        );
        assert.deepStrictEqual(result.readOrder, ["m:1"]);
        assert.deepStrictEqual(result.bookmarkOrder, ["m:1"]);
        assert.strictEqual(result.readChanged, true);
        assert.strictEqual(result.bookmarkChanged, true);
    });

    test("cap is respected when reconciling into a near-cap readOrder", () => {
        const existing = ["a", "b"];
        const result = R.reconcileServerStatus(existing, [], [
            { id: "m:1", status: "read", starred: false },
            { id: "m:2", status: "read", starred: false }
        ], 3);
        assert.strictEqual(result.readOrder.length, 3);
    });

    test("empty serverEntries -> no changes, both *Changed flags false", () => {
        const result = R.reconcileServerStatus(["m:1"], ["m:2"], []);
        assert.deepStrictEqual(result.readOrder, ["m:1"]);
        assert.deepStrictEqual(result.bookmarkOrder, ["m:2"]);
        assert.strictEqual(result.readChanged, false);
        assert.strictEqual(result.bookmarkChanged, false);
    });

    test("null/undefined readOrder/bookmarkOrder do not throw", () => {
        assert.doesNotThrow(() => R.reconcileServerStatus(null, undefined, [{ id: "m:1", status: "read", starred: true }]));
        const result = R.reconcileServerStatus(null, undefined, [{ id: "m:1", status: "read", starred: true }]);
        assert.deepStrictEqual(result.readOrder, ["m:1"]);
        assert.deepStrictEqual(result.bookmarkOrder, ["m:1"]);
    });
});
