import QtQuick
import QtQuick.Layouts
import QtQml
import Quickshell
import Quickshell.Io
import qs.Common
import qs.Services
import qs.Widgets
import qs.Modules.Plugins
import "FeedParser.js" as FeedParser
import "ReaderState.js" as ReaderState
import "Backends.js" as Backends

DesktopPluginComponent {
    id: root

    // --- Settings from pluginData ---
    property var feeds: pluginData.feeds ?? []
    property int updateInterval: (pluginData.updateInterval ?? 30) * 60  // stored as minutes, used as seconds
    property int maxItems: pluginData.maxItems ?? 20
    property real backgroundOpacity: (pluginData.backgroundOpacity ?? 60) / 100
    property bool enableBorder: pluginData.enableBorder ?? false
    property int borderThickness: pluginData.borderThickness ?? 1
    property real borderOpacity: (pluginData.borderOpacity ?? 100) / 100
    property string borderColor: pluginData.borderColor ?? "primary"
    property bool showFeedName: pluginData.showFeedName ?? true
    property bool openInBrowser: pluginData.openInBrowser ?? true
    property bool showImages: pluginData.showImages ?? true
    property string sortMode: pluginData.sortMode ?? "newest"  // "newest", "oldest", "byFeed"
    property int maxPerFeed: pluginData.maxPerFeed ?? 5  // per-feed cap when grouping by feed
    property string viewMode: pluginData.viewMode ?? "expanded"  // "compact" or "expanded"
    property int fontSize: pluginData.fontSize ?? Theme.fontSizeSmall
    property bool notifyNewItems: pluginData.notifyNewItems ?? true

    // --- Miniflux settings (v2.4) ---
    // "standard" | "miniflux" -- exclusive, never hybrid (see v2.4 plan §0).
    // The ?? "standard" default is load-bearing for users upgrading from a
    // pre-2.4 install with no sourceMode key at all: they must land in
    // standard/RSS mode with every existing behavior intact (v2.4 plan §5.5).
    property string sourceMode: pluginData.sourceMode ?? "standard"
    property string minifluxUrl: (pluginData.minifluxUrl ?? "").replace(/\/$/, "")
    property string minifluxToken: pluginData.minifluxToken ?? ""
    property bool syncReadOnOpen: pluginData.syncReadOnOpen ?? true
    property bool showStarred: pluginData.showStarred ?? false

    // --- Backend provider interface (Phase 0 / stage 0b) ---
    // JS owns every backend-specific decision (which URL, method, headers,
    // body, how to parse a response, what the backend can do); QML owns only
    // the side effects (running Proc, showing toasts, assigning properties).
    // See docs/plans/2026-09-08-phase0-backend-interface-design.md.
    readonly property var backends: Backends.createBackends({ FeedParser: FeedParser, ReaderState: ReaderState })
    readonly property var backend: root.backends[root.sourceMode] || root.backends.standard
    readonly property var backendConfig: ({
        feeds: root.feeds,
        minifluxUrl: root.minifluxUrl,
        minifluxToken: root.minifluxToken,
        maxItems: root.maxItems,
        showStarred: root.showStarred
    })

    // --- Internal state ---
    property var allItems: []          // full sorted/capped result set
    // Defaults true (not false): between Component.onCompleted and the
    // 1500ms initialRunTimer's first handleVisibilityChange() call, the
    // widget would otherwise sit at feedModel.count===0 && !isLoading and
    // flash "No items loaded" right before the spinner/fetch actually
    // starts. handleVisibilityChange() and fetchAllFeeds() are responsible
    // for clearing this back to false whenever no fetch will ever be
    // started for the current config (zero feeds, or all feeds disabled)
    // so a zero-feed user is never left with a permanent spinner.
    property bool isLoading: true
    property var windowRef: null
    property int fetchGeneration: 0    // guards against overlapping refreshes (see below)
    property string filterMode: "all"  // "all", "unread" or "bookmarked"
    property string searchQuery: ""
    property bool searchActive: false   // whether the search field is revealed
    property int timeTick: 0           // bumped to re-evaluate relative-time bindings

    // T6/PR#3: clicks anywhere in the row/controls must be ignored while the
    // niri overview is open -- otherwise clicking a thumbnail in the overview
    // to switch workspaces can land on this widget instead and silently open
    // a link / mark an item read. A plain "inOverview" check is not enough:
    // the overview-close IPC event and the Wayland pointer delivery are async,
    // so NiriService.inOverview can already read false by the time the stray
    // click arrives. _overviewGuard stays true for overviewReleaseTimer's
    // window after overview close to absorb that race. CompositorService.isNiri
    // and NiriService.inOverview are both `qs.Services` singletons (already
    // imported above); the typeof guards are defense in depth only, matching
    // how this file already treats ToastService/PluginService.
    property bool _overviewGuard: false

    function _clickFromOverview() {
        return (typeof CompositorService !== "undefined"
            && typeof NiriService !== "undefined"
            && CompositorService.isNiri)
            ? (NiriService.inOverview || root._overviewGuard)
            : false;
    }

    Connections {
        target: (typeof NiriService !== "undefined") ? NiriService : null
        function onInOverviewChanged() {
            if (NiriService.inOverview)
                root._overviewGuard = true;
            else
                overviewReleaseTimer.restart();
        }
    }

    Timer {
        id: overviewReleaseTimer
        interval: 450
        onTriggered: root._overviewGuard = false
    }

    // D8: DMS maps this onto WlrKeyboardFocus.OnDemand (surface-eligible,
    // not surface-focused) vs. None. Widening it to include pointer hover
    // does not reintroduce the keybind-swallowing problem this guard exists
    // for: OnDemand never grants focus on its own, it only lets a click that
    // lands on us claim it. While the pointer merely rests over the widget
    // with nothing clicked, keys still go to niri untouched. This is needed
    // because the surface must already be focus-eligible *before* the click
    // that opens search, or that very click grants nothing and typing is a
    // no-op until a second click (see search-fixes design doc, Problem 1).
    property bool acceptsKeyboardFocus: root.searchActive || widgetHover.hovered

    // Read tracking, keyed by stable item id. `readMap` is replaced (not mutated)
    // so QML property-change notification fires; `readOrder` keeps newest-first
    // insertion order so the persisted list can be bounded predictably.
    property var readMap: ({})
    property var readOrder: []
    property var seenIds: []
    property bool readerStateLoaded: false

    // Bookmarks, same id-list shape as read state so they persist identically.
    property var bookmarkMap: ({})
    property var bookmarkOrder: []

    // Selection is TRANSIENT: never persisted, never bounded/capped like
    // readOrder/bookmarkOrder. Pruned only against root.allItems (S10), so it
    // survives search/filter-chip changes and can include ids currently
    // hidden by the active filter -- not just what's on screen. Plain map
    // (not an id-order list) because membership is all that matters; order
    // is irrelevant. Mirrors readMap/bookmarkMap's "map alongside a QML
    // property, replaced not mutated" pattern.
    property var selectedMap: ({})
    readonly property int selectedCount: ReaderState.countSelected(root.selectedMap)

    // The visible set applyFilter last built, cached so the selection bar can
    // ask "how many selected items are off-screen right now?" without redoing
    // the filter pass -- and, more importantly, so that answer changes on the
    // same debounced beat as the list itself rather than on every keystroke.
    property var visibleItems: []

    // Shared by searchToggleComponent and both Loaders that instantiate it.
    // A Loader given an explicit Layout size does NOT stretch its item to fit,
    // so the button only lands correctly while the two numbers agree -- with a
    // literal in each place, drift would silently leave dead click area.
    readonly property int searchToggleSize: 22

    // Per-feed runtime status, mirrored to the state tier for the settings panel
    property var feedStatuses: []

    readonly property int idHistoryCap: 1000

    readonly property int unreadCount: ReaderState.countUnread(root.allItems, root.readMap)

    readonly property int bookmarkedCount: ReaderState.countBookmarked(root.allItems, root.bookmarkMap)

    readonly property bool searching: root.searchQuery.trim().length > 0

    readonly property int failedFeedCount: {
        var n = 0;
        for (var i = 0; i < root.feedStatuses.length; i++) {
            var s = root.feedStatuses[i].state;
            if (s === "error" || s === "timeout")
                n++;
        }
        return n;
    }

    readonly property int activeFeedCount: ReaderState.activeFeeds(root.feeds).length

    property color resolvedBorderColor: {
        switch (borderColor) {
            case "secondary": return Theme.secondary;
            case "surface": return Theme.surfaceText;
            default: return Theme.primary;
        }
    }

    // Settings' "Force Refresh" button (Miniflux mode) has no direct handle
    // to this widget instance, only to shared pluginData -- bumping this
    // value is how it asks for an immediate refresh.
    property var lastRefreshRequest: pluginData.lastRefreshRequest ?? 0
    onLastRefreshRequestChanged: {
        if (root.isRunnable())
            root.fetchAllFeeds();
    }

    // --- Lifecycle ---
    Component.onCompleted: {
        root.windowRef = Window.window ?? null;
        // Arm the fetch FIRST. Reader state is a nice-to-have; fetching is the
        // whole point of the widget, and an exception in the state layer must
        // never be able to stop the timer from starting again.
        initialRunTimer.running = true;
        root.loadReaderState();
    }

    onVisibleChanged: root.handleVisibilityChange()
    onWidgetWidthChanged: root.handleVisibilityChange()
    onWidgetHeightChanged: root.handleVisibilityChange()

    // NOTE: do NOT declare `onPluginServiceChanged` here. DesktopPluginComponent
    // already handles it (to call loadPluginData()), and a derived declaration
    // would REPLACE the base handler, leaving pluginData permanently empty.
    // Reader state is loaded lazily instead — see loadReaderState() callers.

    Component.onDestruction: {
        timer.running = false;
    }

    function isRunnable() {
        const win = root.windowRef;
        const winVisible = win === null ? true : !!win.visible;
        return root.visible && winVisible && root.widgetWidth > 0 && root.widgetHeight > 0;
    }

    onFeedsChanged: {
        if (root.isRunnable()) {
            fetchAllFeeds();
            timer.restart();
        }
    }

    // v2.4 Risk #3: switching sourceMode must clear ONLY the per-mode view
    // (feedModel/allItems), never readMap/bookmarkMap -- those are shared,
    // cross-mode-safe id lists keyed by the "m:"/"g:"/"l:"/"h:"-prefixed
    // stable ids, and clearing them on every toggle would un-read/un-bookmark
    // everything in BOTH modes every time the user flips the settings switch.
    onSourceModeChanged: {
        if (root.isRunnable()) {
            root.allItems = [];
            feedModel.clear();
            root.fetchAllFeeds();
            timer.restart();
        }
    }

    function handleVisibilityChange() {
        if (root.isRunnable()) {
            // A local (non-server-backed) backend with a zero-feed config
            // will never fetch anything -- resolve isLoading now instead of
            // leaving the T5 default-true spinner running forever. A
            // server-backed backend (e.g. Miniflux) has no per-feed list
            // here; fetchAllFeeds resolves isLoading itself when its config
            // isn't ready, and the timer is still armed below so a
            // later-configured server is picked up without a dedicated
            // "config changed" watcher.
            if (!root.backend.capabilities.serverState && root.feeds.length === 0) {
                root.isLoading = false;
            } else if (!timer.running) {
                fetchAllFeeds();
                timer.running = true;
            }
        } else {
            timer.running = false;
        }
    }

    // --- Timers ---
    Timer {
        id: timer
        interval: root.updateInterval * 1000
        repeat: true
        running: false
        onTriggered: root.fetchAllFeeds()
    }

    Timer {
        id: initialRunTimer
        interval: 1500
        repeat: false
        running: false
        onTriggered: root.handleVisibilityChange()
    }

    // Keeps "5m ago" honest between fetches without re-parsing anything.
    Timer {
        id: relativeTimeTimer
        interval: 60000
        repeat: true
        running: true
        onTriggered: root.timeTick++
    }

    // --- Persistence (state tier: dedicated per-plugin JSON, debounced writes) ---
    //
    // IMPORTANT: the object injected as `pluginService` is NOT always the real
    // PluginService. A desktop-widget INSTANCE receives instanceScopedPluginService
    // from DesktopPluginWrapper.qml, which implements only load/savePluginData —
    // it has NO load/savePluginState. Calling those on it throws, and such an
    // exception previously aborted fetchAllFeeds() before a single feed was
    // requested (the widget just sat on "No items loaded"). So: prefer the real
    // singleton, feature-detect it, and never let a persistence failure take the
    // fetch path down with it.
    readonly property var stateService: ReaderState.resolveStateService(
        typeof PluginService !== "undefined" ? PluginService : null,
        root.pluginService)

    function statePersistenceAvailable() {
        return root.stateService !== null && !!root.pluginId;
    }

    function readState(key, fallback) {
        if (!root.statePersistenceAvailable())
            return fallback;
        try {
            return root.stateService.loadPluginState(root.pluginId, key, fallback);
        } catch (e) {
            console.warn("DankRssWidget: state read failed for", key, e);
            return fallback;
        }
    }

    function writeState(key, value) {
        if (!root.statePersistenceAvailable())
            return;
        try {
            root.stateService.savePluginState(root.pluginId, key, value);
        } catch (e) {
            console.warn("DankRssWidget: state write failed for", key, e);
        }
    }

    function loadReaderState() {
        if (root.readerStateLoaded || !root.statePersistenceAvailable())
            return;

        var order = ReaderState.boundIdList(root.readState("readIds", []), root.idHistoryCap);
        root.readMap = ReaderState.buildIdMap(order);
        root.readOrder = order;

        root.seenIds = ReaderState.boundIdList(root.readState("seenIds", []), root.idHistoryCap);

        var bookmarks = ReaderState.boundIdList(root.readState("bookmarkedIds", []), root.idHistoryCap);
        root.bookmarkMap = ReaderState.buildIdMap(bookmarks);
        root.bookmarkOrder = bookmarks;

        root.readerStateLoaded = true;
    }

    function saveReadState() {
        root.readOrder = ReaderState.boundIdList(root.readOrder, root.idHistoryCap);
        root.writeState("readIds", root.readOrder);
    }

    function saveSeenState() {
        root.seenIds = ReaderState.boundIdList(root.seenIds, root.idHistoryCap);
        root.writeState("seenIds", root.seenIds);
    }

    function saveBookmarkState() {
        root.writeState("bookmarkedIds", root.bookmarkOrder);
    }

    function toggleBookmark(itemId) {
        if (!itemId)
            return;
        // v2.4 §2.3: bookmarkMap/bookmarkOrder are reused as-is for
        // Miniflux's starred state -- no separate starred map. Bookmarks
        // made in RSS mode are untouched by a mode switch: an RSS id's
        // "h:"/"g:"/"l:" prefix can never collide with a Miniflux "m:" id,
        // so switching sourceMode naturally hides the other mode's
        // bookmarks from view (they simply aren't in allItems) without
        // deleting them.
        root.bookmarkOrder = ReaderState.toggleBookmark(root.bookmarkOrder, itemId, root.idHistoryCap);
        root.bookmarkMap = ReaderState.buildIdMap(root.bookmarkOrder);
        root.saveBookmarkState();

        // Asking the backend directly (instead of branching on sourceMode)
        // means this is a no-op for free on any backend without server-side
        // star state: StandardBackend.toggleStarRequest always returns null.
        var req = root.backend.toggleStarRequest(root.backendConfig, root.minifluxNumericId(itemId));
        root.runRequest(req, function(output, code) {
            if (code !== null && code !== 0)
                root.toastError("Failed to toggle bookmark");
        });

        // In the Saved view, un-bookmarking should actually remove the row —
        // otherwise the list shows items that no longer belong to the filter.
        if (root.filterMode === "bookmarked")
            root.applyFilter();
    }

    function saveFeedStatuses() {
        root.writeState("feedStatus", root.feedStatuses);
    }

    function toggleSelected(itemId) {
        if (!itemId) return;
        root.selectedMap = ReaderState.toggleSelected(root.selectedMap, itemId);
    }

    function clearSelection() {
        root.selectedMap = ReaderState.clearSelection();
    }

    function bulkMarkReadSelected() {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0) return;
        root.readOrder = ReaderState.addAllRead(root.readOrder, ids, root.idHistoryCap);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();

        // v2.4 §2.7: push to the server in one batched call rather than one
        // per id (Miniflux's PUT /v1/entries already accepts an array of
        // entry_ids). Filtered to "m:"-prefixed ids as a cheap correctness
        // guard -- only one source mode's items are ever in allItems/
        // selectedMap at a time, so this filter should never actually drop
        // anything in practice. markReadRequest is a no-op (null) on any
        // backend without server-side read state, so no mode check is needed.
        var numIds = [];
        for (var i = 0; i < ids.length; i++) {
            var numId = root.minifluxNumericId(ids[i]);
            if (numId)
                numIds.push(numId);
        }
        root.runRequest(root.backend.markReadRequest(root.backendConfig, numIds), function(output, code) {
            if (code !== null && code !== 0)
                root.toastError("Failed to mark as read");
        });

        root.clearSelection();
        if (root.filterMode === "unread") root.applyFilter();
    }

    function bulkSaveSelected() {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0) return;

        // v2.4 §2.7: capture "already bookmarked" BEFORE the local additive
        // update below, since addAllBookmarked marks every selected id as
        // bookmarked regardless of its prior state -- checking bookmarkMap
        // AFTER that update would see every id as bookmarked and could never
        // tell which ones were newly starred. Computed unconditionally: on a
        // backend without server-side star state this is only ever consulted
        // by a loop whose toggleStarRequest is already a guaranteed no-op.
        var alreadyBookmarked = {};
        for (var i = 0; i < ids.length; i++) {
            if (root.bookmarkMap[ids[i]])
                alreadyBookmarked[ids[i]] = true;
        }

        root.bookmarkOrder = ReaderState.addAllBookmarked(root.bookmarkOrder, ids, root.idHistoryCap);
        root.bookmarkMap = ReaderState.buildIdMap(root.bookmarkOrder);
        root.saveBookmarkState();

        // toggleStarRequest TOGGLES server-side (no "set" endpoint) on a
        // server-backed backend, so it must only be called for ids not
        // already starred -- calling it on an already-starred entry would
        // un-star it.
        for (var j = 0; j < ids.length; j++) {
            var id = ids[j];
            if (alreadyBookmarked[id])
                continue;
            var numId = root.minifluxNumericId(id);
            var req = root.backend.toggleStarRequest(root.backendConfig, numId);
            root.runRequest(req, function(output, code) {
                if (code !== null && code !== 0)
                    root.toastError("Failed to toggle bookmark");
            });
        }

        root.clearSelection();
    }

    function markRead(itemId) {
        if (!itemId || root.readMap[itemId])
            return;
        var map = Object.assign({}, root.readMap);
        map[itemId] = true;
        root.readMap = map;
        root.readOrder = ReaderState.addRead(root.readOrder, itemId, root.idHistoryCap);
        root.saveReadState();
    }

    function markUnread(itemId) {
        if (!itemId || !root.readMap[itemId])
            return;
        var map = Object.assign({}, root.readMap);
        delete map[itemId];
        root.readMap = map;

        root.readOrder = ReaderState.removeRead(root.readOrder, itemId);
        root.saveReadState();
    }

    function setAllRead(read) {
        var ids = [];
        for (var i = 0; i < root.allItems.length; i++) {
            if (root.allItems[i].id)
                ids.push(root.allItems[i].id);
        }

        root.readOrder = read
            ? ReaderState.addAllRead(root.readOrder, ids, root.idHistoryCap)
            : ReaderState.removeAllRead(root.readOrder, ids);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();

        // v2.4 §2.7: same batched-push pattern as bulkMarkReadSelected.
        var numIds = [];
        for (var i2 = 0; i2 < ids.length; i2++) {
            var numId = root.minifluxNumericId(ids[i2]);
            if (numId)
                numIds.push(numId);
        }
        var req = read
            ? root.backend.markReadRequest(root.backendConfig, numIds)
            : root.backend.markUnreadRequest(root.backendConfig, numIds);
        root.runRequest(req, function(output, code) {
            if (code !== null && code !== 0)
                root.toastError(read ? "Failed to mark as read" : "Failed to mark as unread");
        });
    }

    // --- Feed fetching ---
    function refreshNow() {
        if (root.isLoading)
            return;
        root.fetchAllFeeds();
        timer.restart();
    }

    // The ONLY place a request descriptor becomes a process. `req.timeoutMs`
    // must be honoured: Miniflux carries 30000 deliberately, longer than
    // curl's own 25s --max-time inside that descriptor's argv, because
    // otherwise a slow-but-fine request races Proc's default timeout and
    // surfaces a spurious failure toast. A null/absent request is a no-op
    // for that backend (e.g. StandardBackend's mark/star requests) -- report
    // it as such via a null exit code so callers can tell "nothing to do"
    // apart from a real failure.
    function runRequest(req, cb) {
        if (!req) {
            cb(null, null);
            return;
        }
        // T4/v2.4 §2.4: id is deliberately null on every call -- Proc's
        // debounce map (_procDebouncers) keys entries by id and only cleans
        // up entries created with a falsy id; a fixed string id is kept
        // forever and, worse, is SHARED across overlapping calls (a manual
        // refresh firing while a periodic one is still in flight), so the
        // second call would clobber the first's callback before it exits.
        // A null id makes Proc generate a fresh id per call and self-clean.
        Proc.runCommand(null, req.argv, function(out, code) {
            cb(out, code);
        }, undefined, req.timeoutMs || undefined);
    }

    function fetchAllFeeds() {
        if (!root.isRunnable())
            return;

        // Lazy + idempotent: pluginService may not have been injected yet when
        // Component.onCompleted ran, and we must never miss persisted read state
        // (missing it would re-mark everything unread).
        root.loadReaderState();

        // Invalidate any in-flight callbacks from a previous cycle. Without this,
        // two overlapping fetches share one collector and one pending counter,
        // and the cycle finalizes early on a half-filled result set.
        //
        // v2.4/Stage 0b: incremented ABOVE the backend lookup below (not
        // below it) so every backend shares one generation counter, even if
        // sourceMode is toggled mid-flight (v2.4 plan §5 Risk #1).
        root.fetchGeneration++;
        var gen = root.fetchGeneration;

        var backend = root.backend;
        var config = root.backendConfig;
        var requests = backend.fetchRequests(config) || [];

        // Per-feed status rows: only a LOCAL (non-server-backed) backend has
        // a feed list of its own here -- a server-backed backend (Miniflux)
        // has no concept of it, just one logical stream. fetchRequests only
        // returns descriptors for ELIGIBLE feeds (enabled + url set); the
        // status rows for disabled/url-less feeds, which produce no
        // descriptor, are still QML's job.
        var statuses = [];
        var descriptors = [];

        if (!backend.capabilities.serverState) {
            // Keyed by meta.index (position in root.feeds), NOT by url: two
            // enabled feeds may share a url under different display names,
            // and keying on url collapses them onto one descriptor so one
            // renders its items under the other's name.
            var byIndex = ({});
            for (var r = 0; r < requests.length; r++) {
                if (requests[r].meta)
                    byIndex[requests[r].meta.index] = requests[r];
            }

            for (var i = 0; i < root.feeds.length; i++) {
                var feed = root.feeds[i];
                if (!feed || !feed.url)
                    continue;
                var name = feed.name || feed.url;
                // A feed with no `enabled` key predates per-feed disable and
                // counts as enabled -- see ReaderState.isFeedEnabled.
                if (!ReaderState.isFeedEnabled(feed)) {
                    statuses.push({
                        url: feed.url,
                        name: name,
                        state: "disabled",
                        lastFetched: 0,
                        lastSuccess: 0,
                        lastError: "",
                        itemCount: 0
                    });
                    continue;
                }
                var status = {
                    url: feed.url,
                    name: name,
                    state: "loading",
                    lastFetched: 0,
                    lastSuccess: 0,
                    lastError: "",
                    itemCount: 0
                };
                statuses.push(status);
                var matched = byIndex[i];
                if (matched)
                    descriptors.push({ req: matched, statusIndex: statuses.length - 1 });
            }
        } else {
            // Server-backed backend: one synthetic status row per descriptor
            // (in practice at most one -- one server, one request). meta is
            // null (no per-feed identity to attribute), so fall back to a
            // generic label derived from the backend's own id.
            var label = backend.id.charAt(0).toUpperCase() + backend.id.slice(1);
            for (var s = 0; s < requests.length; s++) {
                var req = requests[s];
                var status2 = {
                    url: req.meta ? req.meta.url : config.minifluxUrl,
                    name: req.meta ? req.meta.name : label,
                    state: "loading",
                    lastFetched: 0,
                    lastSuccess: 0,
                    lastError: "",
                    itemCount: 0
                };
                statuses.push(status2);
                descriptors.push({ req: req, statusIndex: statuses.length - 1 });
            }
        }

        root.feedStatuses = statuses;

        if (descriptors.length === 0) {
            root.allItems = [];
            root.isLoading = false;
            root.applyFilter();
            root.saveFeedStatuses();
            return;
        }

        root.isLoading = true;

        // Only nag on failure when there's nothing on screen; a transient
        // blip during a periodic refresh should keep the stale items on
        // screen silently rather than spamming a toast every cycle. Only
        // relevant for a server-backed backend: a local per-feed backend
        // already surfaces failures via its own per-feed status rows.
        var hadItems = root.allItems.length > 0;

        var ctx = {
            gen: gen,
            pending: descriptors.length,
            collector: [],
            statuses: statuses
        };

        for (var d = 0; d < descriptors.length; d++) {
            root.fetchDescriptor(descriptors[d].req, ctx.statuses[descriptors[d].statusIndex], ctx, hadItems);
        }
    }

    function fetchDescriptor(req, status, ctx, hadItems) {
        root.runRequest(req, function(output, exitCode) {
            // Stale callback from a superseded fetch cycle: drop it entirely.
            if (ctx.gen !== root.fetchGeneration)
                return;

            status.lastFetched = Date.now();

            // SECURITY: --max-filesize bounds what curl itself will download,
            // but a feed could still redirect to something that leaks a large
            // response for other reasons; belt-and-suspenders cap before the
            // parser ever sees the payload.
            if (output && output.length > 5000000) {
                status.state = "error";
                status.lastError = "Response too large";
                if (root.backend.capabilities.serverState && !hadItems) {
                    var label0 = root.backend.id.charAt(0).toUpperCase() + root.backend.id.slice(1);
                    root.toastError(label0 + " fetch failed: response too large");
                }
                ctx.pending--;
                if (ctx.pending <= 0)
                    root.finalizeFetch(ctx);
                return;
            }

            var parsed = { items: [], serverStatus: [], error: null };
            if (exitCode === 0 && output && output.trim().length > 0)
                parsed = req.parse(output);

            // Proc synthesizes exit code 124 on its own timeout, which we
            // surface separately from a generic failure.
            var verdict = ReaderState.classifyFetch(exitCode, output, parsed.items.length);
            status.state = verdict.state;
            status.lastError = parsed.error ? parsed.error : verdict.lastError;

            if (verdict.state === "ok") {
                status.lastSuccess = status.lastFetched;
                status.itemCount = parsed.items.length;
                for (var j = 0; j < parsed.items.length; j++)
                    ctx.collector.push(parsed.items[j]);

                // Server wins on fetch reconciliation (v2.4 §2.2/§2.3):
                // reconcile server read/starred status into local readMap/
                // bookmarkMap. This is the ONLY place this runs -- never on
                // a local action -- so a local push has already had a
                // chance to reach the server by the time this corrects any
                // drift. A no-op (identity) on any backend without
                // server-side state.
                var reconciled = root.backend.reconcile({
                    readOrder: root.readOrder,
                    bookmarkOrder: root.bookmarkOrder,
                    cap: root.idHistoryCap
                }, parsed.serverStatus);
                if (reconciled.readChanged) {
                    root.readOrder = reconciled.readOrder;
                    root.readMap = ReaderState.buildIdMap(root.readOrder);
                    root.saveReadState();
                }
                if (reconciled.bookmarkChanged) {
                    root.bookmarkOrder = reconciled.bookmarkOrder;
                    root.bookmarkMap = ReaderState.buildIdMap(root.bookmarkOrder);
                    root.saveBookmarkState();
                }
            } else if (root.backend.capabilities.serverState && !hadItems) {
                var label = root.backend.id.charAt(0).toUpperCase() + root.backend.id.slice(1);
                root.toastError(label + " fetch failed" + (status.lastError ? ": " + status.lastError : ""));
            }

            ctx.pending--;
            if (ctx.pending <= 0)
                root.finalizeFetch(ctx);
        });
    }

    function finalizeFetch(ctx) {
        if (ctx.gen !== root.fetchGeneration)
            return;

        var items = FeedParser.dedupeItems(ctx.collector);

        if (root.sortMode === "oldest") {
            items.sort(function(a, b) { return a.timestamp - b.timestamp; });
        } else if (root.sortMode === "byFeed") {
            // Newest within each feed first, then apply the per-feed cap
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
            var feedCounts = {};
            items = items.filter(function(item) {
                var src = item.source || "";
                feedCounts[src] = (feedCounts[src] || 0) + 1;
                return feedCounts[src] <= root.maxPerFeed;
            });
            // Then group in the order the feeds are arranged in settings, so
            // the move-up/move-down buttons actually affect what you see.
            var orderMap = ReaderState.feedOrderMap(root.feeds);
            items.sort(function(a, b) {
                return ReaderState.compareByFeedOrder(a, b, orderMap);
            });
        } else {
            // "newest" — default
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
        }

        if (items.length > root.maxItems) {
            items = items.slice(0, root.maxItems);
        }

        root.allItems = items;
        root.feedStatuses = ctx.statuses.slice();
        root.notifyForNewItems(items);
        root.applyFilter();
        root.isLoading = false;
        root.saveFeedStatuses();
    }

    // Notifies only for ids never seen before. On the very first run the id
    // history is empty, so everything is recorded silently instead of
    // announcing the entire backlog.
    function notifyForNewItems(items) {
        var currentIds = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].id)
                currentIds.push(items[i].id);
        }

        var result = ReaderState.evaluateSeen(currentIds, root.seenIds, root.idHistoryCap);

        if (!result.firstRun && root.notifyNewItems && result.newCount > 0
            && typeof ToastService !== "undefined") {
            ToastService.showInfo(result.newCount + " new item"
                + (result.newCount > 1 ? "s" : "") + " in RSS Feeds");
        }

        root.seenIds = result.mergedSeen;
        root.saveSeenState();
    }

    // --- Miniflux source mode (v2.4) ---

    function toastError(msg) {
        if (typeof ToastService !== "undefined")
            ToastService.showError(msg);
    }

    // Strips the "m:" id prefix for the numeric id Miniflux's API expects.
    // Returns "" for anything that isn't a Miniflux id (defensive: callers
    // should already only reach here with "m:"-prefixed ids, but a filter
    // that silently no-ops on a non-Miniflux id is cheap insurance against
    // read-state corruption crossing between source modes -- v2.4 plan §5
    // Risk #2).
    function minifluxNumericId(itemId) {
        if (typeof itemId !== "string" || itemId.indexOf("m:") !== 0)
            return "";
        return itemId.slice(2);
    }

    // minifluxApiCall, fetchMinifluxEntries, minifluxMarkRead,
    // minifluxMarkUnread and minifluxToggleStar (v2.4/PR #6) are gone --
    // Backends.js's MinifluxBackend now builds their argv/parse descriptors,
    // and runRequest/fetchAllFeeds/fetchDescriptor above and the mark/star
    // call sites below run them uniformly with StandardBackend's, whose
    // equivalents are no-ops (null descriptors). See Stage 0b addendum in
    // docs/plans/2026-09-08-phase0-backend-interface-design.md.

    // --- View model ---
    function applyFilter() {
        var visible = ReaderState.filterItems(root.allItems, {
            mode: root.filterMode,
            query: root.searchQuery,
            readMap: root.readMap,
            bookmarkMap: root.bookmarkMap
        });

        feedModel.clear();
        for (var i = 0; i < visible.length; i++) {
            var item = visible[i];
            // `id` is renamed to `itemId` here: a ListModel role called `id`
            // collides with QML's own `id` in delegate scope.
            feedModel.append({
                itemId: item.id || "",
                title: item.title || "",
                link: item.link || "",
                description: item.description || "",
                timestamp: item.timestamp || 0,
                source: item.source || "",
                sourceUrl: item.sourceUrl || "",
                imageUrl: item.imageUrl || ""
            });
        }

        // S10: prune selection against the full dataset (root.allItems), not
        // the newly-rebuilt visible set -- selection must survive search and
        // filter-chip changes and only drop an id once it leaves the dataset
        // entirely (e.g. a refresh evicting an old item). selectedCount can
        // therefore exceed what's on screen; bulk actions already iterate
        // selectedMap rather than the visible model, so this is safe, and the
        // selection-bar label below surfaces the hidden portion explicitly.
        root.selectedMap = ReaderState.pruneSelected(root.selectedMap, root.allItems);
        root.visibleItems = visible;
    }

    onFilterModeChanged: root.applyFilter()

    ListModel {
        id: feedModel
    }

    // --- UI ---
    Rectangle {
        anchors.fill: parent
        radius: Theme.cornerRadius
        color: Theme.withAlpha(Theme.surfaceContainer, root.backgroundOpacity)
        border.width: root.enableBorder ? root.borderThickness : 0
        border.color: Theme.withAlpha(root.resolvedBorderColor, root.borderOpacity)
        clip: true

        // Backs D8's acceptsKeyboardFocus above. A pointer handler, not a
        // MouseArea: the widget is full of child MouseAreas (filterArea,
        // markAllArea, per-item areas) and a parent MouseArea's containsMouse
        // goes false whenever a hover-enabled child takes the pointer, so the
        // flag would flicker exactly while the user aims at the search
        // button. HoverHandler observes the pointer over its parent's bounds
        // without competing for the event.
        HoverHandler {
            id: widgetHover
        }

        ColumnLayout {
            anchors.fill: parent
            anchors.margins: Theme.spacingM
            spacing: Theme.spacingS

            // --- Header ---
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacingXS

                    DankIcon {
                        name: "rss_feed"
                        size: Theme.iconSizeSmall
                        color: Theme.primary
                    }

                    StyledText {
                        text: "RSS Feeds"
                        font.pixelSize: Theme.fontSizeMedium
                        font.weight: Font.Bold
                        color: Theme.surfaceText
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    // Failed-feed indicator; per-feed detail lives in settings.
                    DankIcon {
                        visible: root.failedFeedCount > 0
                        name: "error_outline"
                        size: 14
                        color: Theme.error
                    }

                    StyledText {
                        visible: root.failedFeedCount > 0
                        text: root.failedFeedCount
                        font.pixelSize: root.fontSize - 2
                        color: Theme.error
                    }

                    DankSpinner {
                        visible: root.isLoading
                        running: root.isLoading
                        size: 14
                        color: Theme.primary
                    }

                    DankActionButton {
                        visible: !root.isLoading
                        iconName: "refresh"
                        iconSize: 14
                        buttonSize: 22
                        enabled: !root.isLoading && root.activeFeedCount > 0
                        onClicked: root.refreshNow()
                    }
                }

                StyledText {
                    text: {
                        if (root.isLoading)
                            return "Updating...";
                        if (root.allItems.length === 0)
                            return "0 items";
                        return root.allItems.length + " items · " + root.unreadCount + " unread";
                    }
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignHCenter
                }
            }

            // --- Separator ---
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: Theme.outlineVariant
            }

            // Search toggle, shared by the actions bar and the selection bar
            // (S6) so the two copies cannot drift out of sync. Layout.*
            // sizing is set on the Loader that instantiates this, not here --
            // a Component's root item isn't a direct RowLayout child, so
            // attached properties set inside it are ignored by the layout.
            Component {
                id: searchToggleComponent

                DankActionButton {
                    iconName: root.searchActive ? "search_off" : "search"
                    iconSize: 14
                    buttonSize: root.searchToggleSize
                    iconColor: (root.searchActive || root.searching) ? Theme.primary : Theme.surfaceVariantText
                    onClicked: {
                        root.searchActive = !root.searchActive;
                        // Closing search must not leave an invisible query
                        // silently filtering the list.
                        if (!root.searchActive && root.searchQuery !== "") {
                            searchField.clear();
                            root.searchQuery = "";
                            root.applyFilter();
                        }
                    }
                }
            }

            // --- Actions bar: filter + mark all (normal mode) ---
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.spacingXS
                visible: root.allItems.length > 0 && root.selectedCount === 0

                Repeater {
                    model: [
                        { key: "all", label: "All" },
                        { key: "unread", label: "Unread" },
                        { key: "bookmarked", label: "Saved" }
                    ]

                    delegate: Rectangle {
                        required property var modelData
                        readonly property bool active: root.filterMode === modelData.key

                        Layout.preferredWidth: filterLabel.implicitWidth + Theme.spacingS
                        height: 22
                        radius: Theme.cornerRadius
                        color: active
                            ? Theme.withAlpha(Theme.primary, 0.18)
                            : (filterArea.containsMouse ? Theme.withAlpha(Theme.primary, 0.08) : "transparent")

                        StyledText {
                            id: filterLabel
                            anchors.centerIn: parent
                            text: {
                                if (modelData.key === "unread")
                                    return "Unread (" + root.unreadCount + ")";
                                if (modelData.key === "bookmarked")
                                    return "Saved (" + root.bookmarkedCount + ")";
                                return modelData.label;
                            }
                            font.pixelSize: root.fontSize - 2
                            font.weight: parent.active ? Font.Medium : Font.Normal
                            color: parent.active ? Theme.primary : Theme.surfaceVariantText
                        }

                        MouseArea {
                            id: filterArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.filterMode = parent.modelData.key
                        }
                    }
                }

                Item { Layout.fillWidth: true }

                // Search toggle. Search gets its own row when revealed so the
                // filter chips stay readable at narrow widget widths.
                Loader {
                    Layout.preferredWidth: root.searchToggleSize
                    Layout.preferredHeight: root.searchToggleSize
                    sourceComponent: searchToggleComponent
                }

                // Mark all read / unread toggle
                Rectangle {
                    id: markAllRect
                    readonly property bool allRead: root.allItems.length > 0 && root.unreadCount === 0

                    Layout.preferredWidth: allReadRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    visible: root.widgetWidth >= 160
                    height: 22
                    radius: Theme.cornerRadius
                    color: markAllArea.containsMouse ? Theme.withAlpha(Theme.primary, 0.15) : "transparent"

                    RowLayout {
                        id: allReadRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: markAllRect.allRead ? "remove_done" : "done_all"
                            size: 14
                            color: markAllArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }

                        // Label drops out on a narrow widget; the icon carries
                        // the action on its own.
                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: markAllRect.allRead ? "Mark all unread" : "Mark all read"
                            font.pixelSize: root.fontSize - 2
                            color: markAllArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: markAllArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            root.setAllRead(!parent.allRead);
                            if (root.filterMode === "unread")
                                root.applyFilter();
                        }
                    }
                }
            }

            // --- Selection bar (S6): replaces the row above while items are selected ---
            RowLayout {
                id: selectionActionsRow
                Layout.fillWidth: true
                spacing: Theme.spacingXS
                visible: root.selectedCount > 0

                // S10: selection can now include ids hidden by the active
                // filter/search (pruned only against root.allItems), so the
                // label must say so rather than silently undercounting what
                // "N selected" implies is on screen. Derived from
                // root.visibleItems (the set applyFilter last built) rather
                // than re-running filterItems here: that would both duplicate
                // the scan and read root.searchQuery live, so the count would
                // race ahead of the list during searchDebounce's 150ms and
                // briefly disagree with what is on screen.
                readonly property int hiddenSelected: root.selectedCount - ReaderState.countSelectedIn(root.selectedMap, root.visibleItems)

                StyledText {
                    text: root.selectedCount + " selected"
                        + (selectionActionsRow.hiddenSelected > 0 ? " (" + selectionActionsRow.hiddenSelected + " hidden)" : "")
                    font.pixelSize: root.fontSize - 2
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }

                // Save (bulk bookmark) — additive only (S7).
                Rectangle {
                    Layout.preferredWidth: saveRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    height: 22
                    radius: Theme.cornerRadius
                    color: saveArea.containsMouse ? Theme.withAlpha(Theme.primary, 0.15) : "transparent"

                    RowLayout {
                        id: saveRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: "bookmark"
                            size: 14
                            color: saveArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }

                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: "Save"
                            font.pixelSize: root.fontSize - 2
                            color: saveArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: saveArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.bulkSaveSelected()
                    }
                }

                // Mark read — additive only (S7).
                Rectangle {
                    Layout.preferredWidth: markReadRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    height: 22
                    radius: Theme.cornerRadius
                    color: markReadArea.containsMouse ? Theme.withAlpha(Theme.primary, 0.15) : "transparent"

                    RowLayout {
                        id: markReadRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: "mark_email_read"
                            size: 14
                            color: markReadArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }

                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: "Mark read"
                            font.pixelSize: root.fontSize - 2
                            color: markReadArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: markReadArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.bulkMarkReadSelected()
                    }
                }

                // Search toggle (Problem 2): the header's filter/search row
                // is replaced by this bar while items are selected, so
                // search needs its own entry point here too, sharing the
                // header's exact behaviour via searchToggleComponent.
                Loader {
                    Layout.preferredWidth: root.searchToggleSize
                    Layout.preferredHeight: root.searchToggleSize
                    sourceComponent: searchToggleComponent
                }

                // Clear selection — icon-only always (never needs a label; "X"
                // reads as "clear" without text at any width).
                DankActionButton {
                    iconName: "close"
                    iconSize: 14
                    buttonSize: 22
                    Layout.preferredWidth: 22
                    Layout.preferredHeight: 22
                    onClicked: root.clearSelection()
                }
            }

            // --- Search row (revealed by the header's search toggle) ---
            DankTextField {
                id: searchField
                Layout.fillWidth: true
                Layout.preferredHeight: 30
                visible: root.searchActive && root.allItems.length > 0
                placeholderText: "Search title, text, source"
                leftIconName: "search"
                leftIconSize: 14
                showClearButton: true
                font.pixelSize: root.fontSize

                // NOTE: `text` is deliberately NOT bound to root.searchQuery.
                // `text` aliases the inner TextInput, so typing would break the
                // binding while this handler writes back to the same property.
                // The field owns the text; root.searchQuery mirrors it.
                onTextChanged: {
                    if (root.searchQuery === text)
                        return;
                    root.searchQuery = text;
                    searchDebounce.restart();
                }

                onVisibleChanged: {
                    // D8/Problem 1: focus arrival is not synchronous with the
                    // click that revealed us (seat focus grant races Qt's
                    // internal focus item), so a single forceActiveFocus()
                    // can land before the surface is actually eligible. The
                    // deferred retry catches that case.
                    if (visible) {
                        forceActiveFocus();
                        Qt.callLater(forceActiveFocus);
                    }
                }
            }

            // Rebuilding the ListModel on every keystroke is wasteful and makes
            // typing feel laggy; a short debounce keeps it responsive.
            Timer {
                id: searchDebounce
                interval: 150
                repeat: false
                onTriggered: root.applyFilter()
            }

            // --- Feed list ---
            ListView {
                id: feedListView
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: root.viewMode === "compact" ? 1 : Theme.spacingXS
                model: feedModel
                visible: feedModel.count > 0

                delegate: Rectangle {
                    id: itemDelegate
                    readonly property bool isRead: root.readMap[model.itemId] === true
                    readonly property bool isBookmarked: ReaderState.isBookmarked(root.bookmarkMap, model.itemId)
                    readonly property bool isSelected: root.selectedMap[model.itemId] === true

                    // Sizing contract for the leading checkbox and the two
                    // trailing DankActionButtons, shared by the row
                    // MouseArea's leftMargin/rightMargin.
                    readonly property int controlSize: 22
                    // Gap between the leading checkbox and the text column,
                    // and between the two trailing buttons -- both equal
                    // itemColumn.spacing, a FIXED Theme.spacingS regardless
                    // of viewMode (only itemColumn's outer anchors.margins
                    // vary by viewMode, not its internal spacing).
                    readonly property int leadingControlWidth: controlSize + Theme.spacingS
                    readonly property int controlsRowWidth: controlSize * 2 + Theme.spacingS

                    width: feedListView.width
                    height: itemColumn.implicitHeight + Theme.spacingS * 2
                    radius: root.viewMode === "compact" ? 0 : Theme.cornerRadius
                    opacity: isRead ? 0.5 : 1.0
                    color: itemDelegate.isSelected
                        ? Theme.withAlpha(Theme.primary, 0.12)
                        : (rowHover.hovered ? Theme.withAlpha(Theme.primary, 0.08) : "transparent")

                    Behavior on color {
                        ColorAnimation { duration: Theme.shortDuration }
                    }
                    Behavior on opacity {
                        NumberAnimation { duration: Theme.shortDuration }
                    }

                    // Tracks hover across the WHOLE row, including the two
                    // trailing control buttons. The row MouseArea below is
                    // shrunk to exclude those buttons (so they can receive
                    // their own clicks), which means its own containsMouse
                    // would go false the moment the pointer reaches a
                    // control -- causing the controls to fade out just as
                    // the user reaches for them. HoverHandler doesn't have
                    // that problem: it tracks hover independently of any
                    // MouseArea's hit-testing, so it stays true over the
                    // whole delegate including the buttons on top.
                    HoverHandler {
                        id: rowHover
                    }

                    // Whole-row MouseArea declared FIRST: later children (the
                    // leading checkbox and two trailing DankActionButtons)
                    // are visually on top and get their own clicks; this
                    // MouseArea's hit area is shrunk on both edges so it
                    // never overlaps them.
                    MouseArea {
                        id: itemMouseArea
                        anchors.fill: parent
                        anchors.leftMargin: (root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS)
                            + itemDelegate.leadingControlWidth
                        anchors.rightMargin: (root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS)
                            + itemDelegate.controlsRowWidth
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            // T6: a click that lands here while the niri
                            // overview is open is a stray overview-navigation
                            // click, not user intent to open/mark this item.
                            if (root._clickFromOverview())
                                return;

                            // D1: row click ALWAYS opens + marks read. Never
                            // un-reads -- that regressed link-opening once an
                            // item had been read before. None of the three
                            // controls (selection, mark-read, bookmark) ever
                            // open a link.
                            var id = model.itemId;
                            if (!id)
                                return;
                            root.markRead(id);
                            // v2.4 §2.2: opening an item syncs read state to
                            // the server only when the user opted in via
                            // "Mark as read on open" -- unlike the explicit
                            // mark-read button (below), which always syncs.
                            if (root.syncReadOnOpen) {
                                var numId = root.minifluxNumericId(id);
                                root.runRequest(root.backend.markReadRequest(root.backendConfig, numId ? [numId] : []), function(output, code) {
                                    if (code !== null && code !== 0)
                                        root.toastError("Failed to mark as read");
                                });
                            }
                            if (root.openInBrowser && model.link) {
                                // T2 SECURITY: never hand an unsafe-scheme
                                // link (javascript:, file:, data:, ...) to
                                // Qt.openUrlExternally -- surface it instead
                                // so the user knows the feed gave a bad link,
                                // rather than silently swallowing it.
                                if (!FeedParser.isSafeUrl(model.link)) {
                                    ToastService.showWarning("Blocked unsafe link from feed", model.link);
                                } else if (!Qt.openUrlExternally(model.link)) {
                                    ToastService.showError("Could not open link", model.link);
                                }
                            }
                        }
                    }

                    RowLayout {
                        id: itemColumn
                        // No z needed: the MouseArea above is declared first,
                        // so this paints on top naturally, and its
                        // rightMargin excludes the two buttons below.
                        anchors.fill: parent
                        anchors.margins: root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS
                        spacing: Theme.spacingS

                        // NEW, leading: selection checkbox (S1/S2). Never
                        // opens a link, never touches read state.
                        DankActionButton {
                            iconName: itemDelegate.isSelected ? "check_box" : "check_box_outline_blank"
                            iconSize: 14
                            buttonSize: itemDelegate.controlSize
                            iconColor: itemDelegate.isSelected ? Theme.primary : Theme.surfaceVariantText
                            Layout.alignment: Qt.AlignVCenter
                            opacity: (rowHover.hovered || itemDelegate.isSelected) ? 1.0 : 0.45
                            enabled: true
                            onClicked: {
                                if (root._clickFromOverview())
                                    return;
                                root.toggleSelected(model.itemId);
                            }

                            Behavior on opacity {
                                NumberAnimation { duration: Theme.shortDuration }
                            }
                        }

                        // Text content
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: root.viewMode === "compact" ? 0 : 2

                            // Source + Title row
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacingXS

                                StyledText {
                                    visible: root.showFeedName
                                    text: model.source || ""
                                    font.pixelSize: root.fontSize
                                    font.weight: Font.Medium
                                    color: itemDelegate.isRead ? Theme.surfaceVariantText : Theme.primary
                                    Layout.maximumWidth: 120
                                    elide: Text.ElideRight
                                }

                                StyledText {
                                    visible: root.showFeedName
                                    text: "·"
                                    font.pixelSize: root.fontSize
                                    color: Theme.surfaceVariantText
                                }

                                StyledText {
                                    text: model.title || ""
                                    font.pixelSize: root.fontSize
                                    font.weight: Font.Medium
                                    color: itemDelegate.isRead ? Theme.surfaceVariantText : Theme.surfaceText
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight
                                    maximumLineCount: 1
                                    wrapMode: Text.NoWrap
                                }

                                // Compact mode: inline date
                                StyledText {
                                    visible: root.viewMode === "compact" && text !== ""
                                    text: {
                                        root.timeTick;  // dependency: forces re-evaluation on the 60s tick
                                        return model.timestamp > 0
                                            ? FeedParser.getRelativeTime(new Date(model.timestamp))
                                            : "";
                                    }
                                    font.pixelSize: root.fontSize - 2
                                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.7)
                                }
                            }

                            // Description (hidden in compact mode)
                            StyledText {
                                visible: root.viewMode !== "compact" && (model.description || "") !== ""
                                text: model.description || ""
                                font.pixelSize: root.fontSize
                                color: Theme.surfaceVariantText
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                                maximumLineCount: 2
                                wrapMode: Text.WordWrap
                            }

                            // Date (hidden in compact mode — shown inline instead)
                            StyledText {
                                visible: root.viewMode !== "compact" && text !== ""
                                text: {
                                    root.timeTick;  // dependency: forces re-evaluation on the 60s tick
                                    return model.timestamp > 0
                                        ? FeedParser.getRelativeTime(new Date(model.timestamp))
                                        : "";
                                }
                                font.pixelSize: root.fontSize - 2
                                color: Theme.withAlpha(Theme.surfaceVariantText, 0.7)
                            }
                        }

                        // Thumbnail (hidden in compact mode). T2 SECURITY:
                        // gated on FeedParser.isSafeUrl as defense in depth --
                        // FeedParser already blanks unsafe imageUrl values at
                        // parse time, but a QML Image must never be pointed
                        // at an unvetted URL even if that first line of
                        // defense were ever bypassed.
                        Rectangle {
                            id: thumbRect
                            visible: root.viewMode !== "compact" && root.showImages && FeedParser.isSafeUrl(model.imageUrl) && thumbImage.status !== Image.Error
                            Layout.preferredWidth: 48
                            Layout.preferredHeight: 48
                            Layout.alignment: Qt.AlignVCenter
                            radius: Theme.cornerRadius
                            color: Theme.surfaceContainerHigh
                            clip: true

                            Image {
                                id: thumbImage
                                anchors.fill: parent
                                source: (root.showImages && FeedParser.isSafeUrl(model.imageUrl)) ? model.imageUrl : ""
                                fillMode: Image.PreserveAspectCrop
                                asynchronous: true
                                cache: true
                            }
                        }

                        // NEW, trailing #1: mark-read toggle (S3). Takes over
                        // the read-toggle behavior the checkbox used to have
                        // before this plan, moved here with a distinct icon
                        // so it can't be confused with the leading selection
                        // checkbox. Always enabled, always hittable -- never
                        // disable the subtree via `enabled: <opacity expr>`,
                        // that's what broke the bookmark button before.
                        DankActionButton {
                            iconName: itemDelegate.isRead ? "mark_email_read" : "mark_email_unread"
                            iconSize: 14
                            buttonSize: itemDelegate.controlSize
                            iconColor: itemDelegate.isRead ? Theme.primary : Theme.surfaceVariantText
                            Layout.alignment: Qt.AlignVCenter
                            opacity: (rowHover.hovered || itemDelegate.isRead) ? 1.0 : 0.45
                            enabled: true
                            onClicked: {
                                if (root._clickFromOverview())
                                    return;
                                var wasRead = itemDelegate.isRead;
                                if (wasRead)
                                    root.markUnread(model.itemId);
                                else
                                    root.markRead(model.itemId);
                                // v2.4 §2.2: an explicit toggle via this
                                // button ALWAYS syncs to the server,
                                // regardless of syncReadOnOpen (that setting
                                // only gates the row-click "open" path above).
                                var numId = root.minifluxNumericId(model.itemId);
                                var ids = numId ? [numId] : [];
                                var req = wasRead
                                    ? root.backend.markUnreadRequest(root.backendConfig, ids)
                                    : root.backend.markReadRequest(root.backendConfig, ids);
                                root.runRequest(req, function(output, code) {
                                    if (code !== null && code !== 0)
                                        root.toastError(wasRead ? "Failed to mark as unread" : "Failed to mark as read");
                                });
                            }

                            Behavior on opacity {
                                NumberAnimation { duration: Theme.shortDuration }
                            }
                        }

                        // D3: bookmark toggle. `enabled` stays true always --
                        // binding it to the opacity expression disabled the
                        // whole subtree for input whenever idle, which is
                        // why it used to be unclickable without hovering
                        // first.
                        DankActionButton {
                            iconName: itemDelegate.isBookmarked ? "bookmark" : "bookmark_border"
                            iconSize: 14
                            buttonSize: itemDelegate.controlSize
                            iconColor: itemDelegate.isBookmarked ? Theme.primary : Theme.surfaceVariantText
                            Layout.alignment: Qt.AlignVCenter
                            opacity: (rowHover.hovered || itemDelegate.isBookmarked) ? 1.0 : 0.45
                            enabled: true
                            onClicked: {
                                if (root._clickFromOverview())
                                    return;
                                root.toggleBookmark(model.itemId);
                            }

                            Behavior on opacity {
                                NumberAnimation { duration: Theme.shortDuration }
                            }
                        }
                    }
                }
            }

            // --- Empty state ---
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: feedModel.count === 0 && !root.isLoading
                spacing: Theme.spacingS

                Item { Layout.fillHeight: true }

                DankIcon {
                    name: {
                        // v2.4 §2.6/Stage 0b: the widget asks the backend
                        // whether its config is usable, never which backend
                        // it is. `reason` is shared across backends
                        // ("unconfigured"/"empty"/null) but the user-facing
                        // wording differs, so capabilities.serverState picks
                        // between them below.
                        var cs = root.backend.configState(root.backendConfig);
                        if (!cs.ok)
                            return root.backend.capabilities.serverState ? "sync" : "rss_feed";
                        if (root.failedFeedCount > 0 && root.allItems.length === 0)
                            return "cloud_off";
                        if (root.allItems.length > 0 && root.searching)
                            return "search_off";
                        if (root.allItems.length > 0 && root.filterMode === "bookmarked")
                            return "bookmark_border";
                        return root.backend.capabilities.serverState ? "sync" : "rss_feed";
                    }
                    size: Theme.iconSize * 2
                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.4)
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: {
                        var cs = root.backend.configState(root.backendConfig);
                        if (!cs.ok) {
                            if (cs.reason === "unconfigured")
                                return root.backend.capabilities.serverState
                                    ? "Configure Miniflux in settings"
                                    : "No feeds configured";
                            // reason === "empty": feeds exist but are all disabled
                            // (only reachable for a non-server-backed backend).
                            return "All feeds disabled";
                        }
                        if (root.allItems.length === 0 && root.failedFeedCount > 0)
                            return "All feeds failed to load";
                        // A search that matches nothing is distinct from an
                        // empty filter, which is distinct from an empty feed.
                        if (root.allItems.length > 0 && root.searching)
                            return "No matching items";
                        if (root.allItems.length > 0 && root.filterMode === "bookmarked")
                            return "No saved items";
                        if (root.allItems.length > 0 && root.filterMode === "unread")
                            return "All caught up";
                        return "No items loaded";
                    }
                    font.pixelSize: Theme.fontSizeMedium
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }

                StyledText {
                    visible: text !== ""
                    text: {
                        var cs = root.backend.configState(root.backendConfig);
                        if (!cs.ok) {
                            if (cs.reason === "unconfigured")
                                return root.backend.capabilities.serverState
                                    ? "Enter your server URL and API token"
                                    : "Add feeds in the widget settings";
                            return "Re-enable a feed in settings";
                        }
                        if (root.allItems.length === 0 && root.failedFeedCount > 0)
                            return "See per-feed errors in settings";
                        if (root.allItems.length > 0 && root.searching)
                            return "Try a different search term";
                        if (root.allItems.length > 0 && root.filterMode === "bookmarked")
                            return "Hover an item and tap the bookmark icon";
                        return "";
                    }
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.6)
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }

                Item { Layout.fillHeight: true }
            }

            // --- Loading state ---
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: feedModel.count === 0 && root.isLoading
                spacing: Theme.spacingS

                Item { Layout.fillHeight: true }

                DankSpinner {
                    running: root.isLoading
                    size: 24
                    color: Theme.primary
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: "Loading feeds..."
                    font.pixelSize: Theme.fontSizeMedium
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    Layout.alignment: Qt.AlignHCenter
                }

                Item { Layout.fillHeight: true }
            }
        }
    }
}
