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
import "GoogleReader.js" as GoogleReader
import "ChainRunner.js" as ChainRunner
import "KeyMap.js" as KeyMap
import "ExportProvider.js" as ExportProvider
import "HtmlExtract.js" as HtmlExtract
import "AiProvider.js" as AiProvider
import "Ranking.js" as Ranking
import "Palette.js" as Palette

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

    // --- Miniflux settings ---
    // sourceMode is "standard" or "miniflux", never hybrid. The ?? "standard"
    // default is load-bearing: an install with no sourceMode key at all
    // (pre-Miniflux-support) must land in standard/RSS mode with every
    // existing behavior intact, not silently switch modes on upgrade.
    property string sourceMode: pluginData.sourceMode ?? "standard"
    property string minifluxUrl: (pluginData.minifluxUrl ?? "").replace(/\/$/, "")
    property string minifluxToken: pluginData.minifluxToken ?? ""
    property bool syncReadOnOpen: pluginData.syncReadOnOpen ?? true
    property bool showStarred: pluginData.showStarred ?? false

    // --- Google Reader settings ---
    // No settings UI yet; only reachable by hand-editing settings.json. That
    // is enough to exercise the backend runner while the UI is still pending.
    property string greaderUrl: (pluginData.greaderUrl ?? "").replace(/\/$/, "")
    property string greaderUsername: pluginData.greaderUsername ?? ""
    property string greaderPassword: pluginData.greaderPassword ?? ""

    // --- Notes export settings ---
    // DesktopPluginWrapper.qml's loadPluginData reads the instance config
    // first and falls back to the global plugin-wide store; savePluginData
    // writes to the instance config only. So these are per-instance for an
    // instanced widget and global otherwise -- the same as every other
    // setting in this file.
    // Stage 4d replaced the fixed markdown/obsidian/neovim provider dropdown
    // with an editable open-command template (exportOpenCommand); exportKind
    // is now the id of whichever preset is active rather than a closed set
    // of three values. resolveExportConfig() reads BOTH of those the same
    // way regardless of whether pluginData is in the old or new shape, so a
    // config saved before this stage (e.g. exportKind: "obsidian" with no
    // exportOpenCommand at all) lands on the equivalent preset instead of
    // silently losing its open-after-export behaviour.
    readonly property var _exportResolved: ExportProvider.resolveExportConfig(pluginData)
    property string exportKind: root._exportResolved.exportKind
    property string exportOpenCommand: root._exportResolved.exportOpenCommand
    property string exportRoot: pluginData.exportRoot ?? ""
    property string exportVault: pluginData.exportVault ?? ""
    property string exportTemplate: pluginData.exportTemplate ?? "{title}.md"
    property var exportTags: pluginData.exportTags ?? []
    // Off by default: this makes one outbound HTTP request per exported
    // article to whatever third-party site the feed links to, which is not
    // something to do without the user having opted in.
    property bool exportFullText: pluginData.exportFullText ?? false

    // Empty means follow Theme.fontFamily -- see ReaderWindow.qml.
    property string readerFontFamily: pluginData.readerFontFamily ?? ""
    property bool exportImages: pluginData.exportImages ?? false
    property var notificationRules: pluginData.notificationRules ?? []
    property bool markReadOnScroll: pluginData.markReadOnScroll ?? false
    // The plugin's own colour palette, resolved from the chosen preset.
    //
    // Every colour in this file goes through here rather than straight to
    // Theme, so a colour-vision preset can replace the matugen values without
    // the plugin ever WRITING to Theme -- which it must never do: Theme is a
    // pragma Singleton shared by the whole shell, and assigning to it would
    // repaint the bar, the popups and every other plugin too.
    //
    // "system" resolves to these same values unchanged, so the default path
    // is a pass-through and nothing moves for anyone who has not asked for a
    // preset.

    // Only the three roles the settings panel offers. Anything invalid or
    // absent is ignored by applyOverrides, so a half-set custom theme falls
    // back to its base palette rather than to undefined colours.
    function pluginDataValue(key, fallback) {
        var v = pluginData[key];
        return (v === undefined || v === null) ? fallback : v;
    }

    function customOverrides() {
        return {
            primary: root.pluginDataValue("customPrimary", ""),
            error: root.pluginDataValue("customError", ""),
            success: root.pluginDataValue("customSuccess", "")
        };
    }

    function themeBasePalette() {
        return {
            primary: String(Theme.primary),
            secondary: String(Theme.secondary),
            surfaceText: String(Theme.surfaceText),
            surfaceVariantText: String(Theme.surfaceVariantText),
            error: String(Theme.error),
            success: String(Theme.success),
            warning: String(Theme.warning),
            outlineVariant: String(Theme.outlineVariant),
            surfaceContainer: String(Theme.surfaceContainer),
            surfaceContainerHigh: String(Theme.surfaceContainerHigh),
            surfaceContainerHighest: String(Theme.surfaceContainerHighest),
            onPrimary: String(Theme.onPrimary),
            onError: String(Theme.onError)
        };
    }

    // Theme.withAlpha takes a colour OBJECT and returns fully transparent for
    // anything whose .r is undefined -- which a hex string is. The palette
    // deals in strings (Palette.js does hex arithmetic on them), so every
    // withAlpha call on a palette colour would have silently produced
    // transparent rather than a tint: no error, no warning, just backgrounds
    // and hover states quietly disappearing. Parse it here instead.
    function tint(hex, a) {
        var c = ("" + hex).replace("#", "");
        if (c.length === 3)
            c = c.charAt(0) + c.charAt(0) + c.charAt(1) + c.charAt(1) + c.charAt(2) + c.charAt(2);
        if (c.length === 8)
            c = c.substring(2);
        var n = parseInt(c.substring(0, 6), 16);
        if (isNaN(n))
            return Qt.rgba(0, 0, 0, 0);
        return Qt.rgba(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
    }

    property string colourPreset: pluginData.colourPreset ?? "system"
    readonly property var roleColours: {
        var base = Palette.resolvePalette(root.colourPreset, root.themeBasePalette());
        return root.colourPreset === "custom" ? Palette.applyOverrides(base, root.customOverrides()) : base;
    }

    // Ids already announced by a rule. Separate from seenIds: an item can be
    // seen (counted, not new) long before a newly-added rule first matches it,
    // and conflating the two would either re-announce on every refresh or
    // silently swallow the first match.
    property var notifiedIds: []
    // sourceUrl -> epoch ms until which that feed's items stay hidden.
    // Lives in the state tier beside read/bookmark ids, and expired entries
    // are pruned on every refresh so a map of long-dead snoozes cannot
    // accumulate in the state file.
    property var snoozeMap: ({})
    // sourceUrl -> epoch ms of the last attempt, for per-feed intervals.
    // Only feeds that opt in (a positive intervalMinutes on the feed itself)
    // are ever throttled; everything else fetches on the global cycle exactly
    // as before, so the default behaviour is untouched.
    property var feedLastFetch: ({})

    // --- Interest ranking (stage 3d) ---
    //
    // Ships OFF, and stays off until it can actually work: it needs an
    // embedding model configured AND enough starred articles to learn from.
    // The backlog is explicit that a ranking which feels wrong is worse than
    // no ranking, so every gate below fails closed and says why rather than
    // quietly producing an arbitrary order.
    property bool rankingEnabled: pluginData.rankingEnabled ?? false
    property int rankingWeight: pluginData.rankingWeight ?? 50
    // Resolved through the same function the settings panel uses, so a user
    // who never typed an embedding model still gets the preset's default --
    // which is exactly the case that silently disabled ranking.
    property string aiEmbedModel: AiProvider.resolvePresetEmbedModel(root.aiPreset, pluginData.aiEmbedModel ?? "")

    // Vectors are held in memory and deliberately NOT persisted. A single
    // embedding is a few hundred floats; a few hundred items of them is
    // megabytes of JSON written into a state file shared with the rest of the
    // shell, to save one batch request that takes about a second. Recomputing
    // per session is the cheaper side of that trade by a wide margin.
    property var vectorMap: ({})
    property bool rankingBusy: false
    // Why ranking is not currently applied, shown to the user rather than
    // left as an unexplained ordering. Empty means it is working.
    property string rankingReason: ""
    property var rankedOrder: []

    readonly property bool rankingConfigured: root.rankingEnabled && root.aiEnabled && root.aiProvider.canEmbed({ model: root.aiEmbedModel })

    // Settings changes must re-rank, not wait for the next refresh. Turning
    // ranking on and seeing nothing happen for thirty minutes reads as broken.
    onRankingConfiguredChanged: root.refreshRanking()
    // Starring is the ONLY input the ranking learns from, so it has to react
    // to it. Without this the reason went stale: star five more articles,
    // nothing recomputes, and the widget keeps insisting you have not starred
    // enough -- indistinguishable from the feature being broken, and reported
    // as exactly that. Debounced, because starring several in a row is normal
    // and each one would otherwise queue an embedding pass.
    onBookmarkMapChanged: {
        if (root.rankingConfigured)
            rankingSettleTimer.restart();
    }

    Timer {
        id: rankingSettleTimer
        interval: 1200
        repeat: false
        onTriggered: root.refreshRanking()
    }
    onRankingWeightChanged: {
        if (root.rankingConfigured && root.rankedOrder.length > 0)
            root.applyRanking();
    }
    property string attachmentDir: pluginData.attachmentDir ?? "attachments"

    // --- AI summaries (stage 3b) ---
    //
    // All four are global rather than per-instance. The design doc asked for
    // the toggle to be per-instance so a small ticker could stay dumb while a
    // large widget summarises, but every setting in this plugin goes through
    // savePluginData(pluginId, ...), which is keyed by plugin and not by
    // instance. Per-instance would mean adopting the DMS plugin-variant
    // system, which this widget has never used, for one boolean. Recorded as
    // a deviation rather than done quietly.
    property bool aiEnabled: pluginData.aiEnabled ?? false
    // Resolved exactly as the settings panel resolves it, through the same
    // pure function -- a second copy of "what does empty mean" is how the two
    // sides drift apart and the widget disagrees with its own settings page.
    property string aiPreset: pluginData.aiPreset ?? "ollama"
    property string aiBaseUrl: AiProvider.resolveBaseUrl(root.aiPreset, pluginData.aiBaseUrl ?? "")
    property string aiModel: pluginData.aiModel ?? ""
    property string aiApiKey: pluginData.aiApiKey ?? ""

    readonly property var aiProvider: AiProvider.createAiProvider({
        baseUrl: root.aiBaseUrl,
        model: root.aiModel,
        apiKey: root.aiApiKey,
        embedModel: root.aiEmbedModel
    })

    // The single gate on every summary affordance. "Enabled but unconfigured"
    // must look exactly like "disabled": no button, no key, no error. An AI
    // feature that advertises itself while unusable is the failure mode the
    // design doc calls the most important behavioural requirement in the phase.
    readonly property bool aiReady: root.aiEnabled && root.aiProvider.isConfigured()

    readonly property var exportProvider: ExportProvider.createExportProvider({
        kind: root.exportKind,
        root: root.exportRoot,
        vault: root.exportVault,
        filenameTemplate: root.exportTemplate,
        tags: root.exportTags,
        exportOpenCommand: root.exportOpenCommand
    })

    // --- Backend provider interface ---
    // JS owns every backend-specific decision (URL, method, headers, body,
    // response parsing, capabilities); QML owns only the side effects
    // (running Proc, showing toasts, assigning properties).
    readonly property var backends: Backends.createBackends({
        FeedParser: FeedParser,
        ReaderState: ReaderState,
        GoogleReader: GoogleReader
    })
    readonly property var backend: root.backends[root.sourceMode] || root.backends.standard
    readonly property var backendConfig: ({
            feeds: root.feeds,
            minifluxUrl: root.minifluxUrl,
            minifluxToken: root.minifluxToken,
            greaderUrl: root.greaderUrl,
            greaderUsername: root.greaderUsername,
            greaderPassword: root.greaderPassword,
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
    // Google Reader session cache: { authToken, postToken }. Deliberately IN
    // MEMORY ONLY -- never written to plugin state, since it's re-derivable
    // with one ClientLogin and not worth the risk of a credential on disk.
    // Updated from the `session` field ChainRunner's results carry back.
    // Every backend but greader ignores it, but it is threaded through
    // positionally to all of them regardless -- all backends share one call
    // signature.
    property var backendSession: ({})
    property string filterMode: "all"  // "all", "unread" or "bookmarked"

    // Category filter. "" means every category, which is also the only state
    // reachable on a backend that cannot supply them -- the chip is hidden
    // rather than shown empty, so the feature is absent instead of broken on
    // the standard RSS backend, which has no such concept.
    property string categoryFilter: ""
    readonly property bool categoriesSupported: root.backend.capabilities.categories === true
    readonly property var availableCategories: root.categoriesSupported ? Backends.knownCategories(root.allItems) : []
    property string searchQuery: ""
    property bool searchActive: false   // whether the search field is revealed
    property int timeTick: 0           // bumped to re-evaluate relative-time bindings

    // Clicks anywhere in the row/controls must be ignored while the niri
    // overview is open -- otherwise clicking a thumbnail in the overview to
    // switch workspaces can land on this widget instead and silently open a
    // link or mark an item read. A plain "inOverview" check isn't enough:
    // the overview-close IPC event and the Wayland pointer delivery are
    // async, so NiriService.inOverview can already read false by the time
    // the stray click arrives. _overviewGuard stays true for
    // overviewReleaseTimer's window after overview close to absorb that
    // race. The typeof guards below are defense in depth, matching how this
    // file already treats ToastService/PluginService.
    property bool _overviewGuard: false

    function _clickFromOverview() {
        return (typeof CompositorService !== "undefined" && typeof NiriService !== "undefined" && CompositorService.isNiri) ? (NiriService.inOverview || root._overviewGuard) : false;
    }

    // Row actions, each defined once and invoked from BOTH onClicked and
    // Accessible.onPressAction.
    //
    // These used to be duplicated: the accessibility handler carried a
    // verbatim copy of the pointer handler's body. That is the shape that
    // rots, and it already had -- the mark-all pair had drifted to reading
    // its state through two different names. Assistive tech activates via the
    // press action rather than a synthesised click, so the two paths must
    // stay identical by construction, not by discipline.
    //
    // Every one of them keeps the overview guard: under Niri a click landing
    // while the overview is open must not act on the row underneath it.
    function rowToggleSelected(itemId) {
        if (root._clickFromOverview())
            return;
        root.toggleSelected(itemId);
    }

    function rowToggleRead(itemId, isRead) {
        if (root._clickFromOverview())
            return;
        root.toggleReadSynced(itemId, isRead);
    }

    function rowToggleBookmark(itemId) {
        if (root._clickFromOverview())
            return;
        root.toggleBookmark(itemId);
    }

    function rowViewItem(itemId, index) {
        if (root._clickFromOverview())
            return;
        root.viewItem(itemId, index);
    }

    function toggleSearch() {
        if (root.searchActive)
            root.closeSearch();
        else
            root.searchActive = true;
    }

    function toggleAllRead(currentlyAllRead) {
        root.setAllRead(!currentlyAllRead);
        if (root.filterMode === "unread")
            root.applyFilter();
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

    // DMS maps this onto WlrKeyboardFocus.OnDemand (surface-eligible, not
    // surface-focused) vs. None. Widening it to include pointer hover does
    // not reintroduce keybind-swallowing: OnDemand never grants focus on its
    // own, it only lets a click that lands on us claim it -- while the
    // pointer merely hovers, keys still go to niri untouched. This must
    // already be true before the click that opens search, or that very
    // click grants no focus and typing is a no-op until a second click.
    //
    // Hover alone was enough for search -- the pointer stays over the widget
    // while typing -- but keyboard list navigation breaks that assumption:
    // click a row, move the mouse away to read, and hovered goes false right
    // as the user starts pressing j/k. keyboardScope.activeFocus latches on
    // once a click grants focus, so the flag stays true while the user is
    // driving the list and only drops when the compositor focuses something
    // else -- it does not add any new way to grab focus, so the OnDemand
    // reasoning above still holds.
    property bool acceptsKeyboardFocus: root.searchActive || widgetHover.hovered || keyboardScope.activeFocus

    // Keyboard cursor over feedModel; -1 means no cursor (the state after
    // Esc, and the initial state -- so Enter on a freshly-clicked widget
    // cannot open an arbitrary item). Resolved purely by KeyMap.resolveKey;
    // this file only performs the action it names.
    property int keyboardIndex: -1

    // Pending "g" (first half of "g g") and when it was armed. KeyMap.js is
    // pure and has no clock of its own -- see its header comment -- so QML
    // stamps pendingAt with Date.now() whenever resolveKey reports a pending
    // state, and passes both back in on the next keystroke.
    property var pending: null
    property var pendingAt: 0

    // Bindings help overlay, toggled by "?" (KeyMap's "toggleHelp" action).
    property bool helpVisible: false

    // The keyboard bindings help overlay's row data. A plain array except
    // for "e", which is left out entirely when no export folder is
    // configured -- pressing "e" does nothing in that state (see
    // exportArticles()), so documenting it would be advertising a feature
    // that silently fails.
    readonly property var helpBindingsModel: {
        var rows = [
            {
                keys: ["j", "k"],
                desc: "Move cursor down / up"
            },
            {
                keys: ["o", "Enter"],
                desc: "Open item"
            },
            {
                keys: ["v"],
                desc: "View in reader window"
            },
            {
                keys: ["shift+j", "shift+k"],
                desc: "Next / previous article (in reader window)"
            },
            {
                keys: ["m"],
                desc: "Toggle read / unread (whole selection, if any)"
            },
            {
                keys: ["s"],
                desc: "Toggle star (whole selection, if any)"
            }
        ];
        if (root.exportRoot)
            rows.push({
                keys: ["e"],
                desc: "Export to notes (whole selection, if any)"
            });
        // Gated on aiReady for the same reason "e" is gated on exportRoot:
        // with no runtime configured "i" does nothing, and documenting a key
        // that silently fails is worse than not documenting it.
        if (root.aiReady)
            rows.push({
                keys: ["i"],
                desc: "Summarise (opens the reader on the summary)"
            });
        if (root.aiReady)
            rows.push({
                keys: ["d"],
                desc: "Digest of the last 24 hours"
            });
        rows.push({
            keys: ["Space"],
            desc: "Toggle selection"
        });
        rows.push({
            keys: ["g", "g"],
            desc: "Jump to first item"
        });
        rows.push({
            keys: ["G"],
            desc: "Jump to last item"
        });
        rows.push({
            keys: ["/"],
            desc: "Focus search"
        });
        rows.push({
            keys: ["Esc"],
            desc: "Close search, clear selection, or clear cursor"
        });
        rows.push({
            keys: ["r"],
            desc: "Refresh feeds"
        });
        rows.push({
            keys: ["z"],
            desc: "Snooze this feed for a day"
        });
        rows.push({
            keys: ["p"],
            desc: "Play this item's audio, if it has any"
        });
        rows.push({
            keys: ["Z"],
            desc: "Wake every snoozed feed"
        });
        rows.push({
            keys: ["A"],
            desc: "Mark all read / unread"
        });
        rows.push({
            keys: ["?"],
            desc: "Toggle this help"
        });
        return rows;
    }

    // Read tracking, keyed by stable item id. `readMap` is replaced (not mutated)
    // so QML property-change notification fires; `readOrder` keeps newest-first
    // insertion order so the persisted list can be bounded predictably.
    property var readMap: ({})
    property var readOrder: []

    // Bounded summary cache, persisted like readIds/bookmarkedIds. Capped far
    // lower than idHistoryCap because these store paragraphs rather than ids:
    // the whole map is rewritten on every change, so the cap is a write-cost
    // decision, not just a memory one.
    property var summaryMap: ({})
    property var summaryOrder: []
    // Discards a summary that arrives after the user moved on, so a 5s
    // response can never render against the article they are looking at now.
    // Same pattern as fetchGeneration, deliberately a separate counter: a
    // feed refresh must not invalidate an in-flight summary or vice versa.
    property int summaryGeneration: 0
    property var seenIds: []
    property bool readerStateLoaded: false

    // Bookmarks, same id-list shape as read state so they persist identically.
    property var bookmarkMap: ({})
    property var bookmarkOrder: []

    // Selection is TRANSIENT: never persisted, never bounded/capped like
    // readOrder/bookmarkOrder. Pruned only against root.allItems, so it
    // survives search/filter-chip changes and can include ids currently
    // hidden by the active filter -- not just what's on screen. Plain map
    // (not an id-order list) because membership is all that matters; order
    // is irrelevant.
    property var selectedMap: ({})
    readonly property int selectedCount: ReaderState.countSelected(root.selectedMap)

    // Mirrors markAllRect.allRead: drives the selection bar's mark-read
    // button flipping to "Mark unread" once every selected item is already
    // read, same as the header does for the whole feed.
    readonly property bool selectedAllRead: {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0)
            return false;
        for (var i = 0; i < ids.length; i++) {
            if (!root.readMap[ids[i]])
                return false;
        }
        return true;
    }

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
    readonly property int summaryCap: ReaderState.DEFAULT_SUMMARY_CAP

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

    readonly property string failedFeedSummary: {
        var names = [];
        for (var i = 0; i < root.feedStatuses.length; i++) {
            var st = root.feedStatuses[i];
            if (st.state === "error" || st.state === "timeout")
                names.push((st.name || st.url) + " — " + (st.lastError || "failed"));
        }
        return names.join("\n");
    }

    readonly property int activeFeedCount: ReaderState.activeFeeds(root.feeds).length

    property color resolvedBorderColor: {
        switch (borderColor) {
        case "secondary":
            return root.roleColours.secondary;
        case "surface":
            return root.roleColours.surfaceText;
        default:
            return root.roleColours.primary;
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

    // Do NOT declare `onPluginServiceChanged` here: DesktopPluginComponent
    // already handles it (to call loadPluginData()), and a derived handler
    // would REPLACE the base one, leaving pluginData permanently empty.
    // Reader state is loaded lazily instead -- see loadReaderState() callers.

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

    // Switching sourceMode must clear ONLY the per-mode view (feedModel/
    // allItems), never readMap/bookmarkMap -- those are shared, cross-mode
    // id lists keyed by "m:"/"g:"/"l:"/"h:"-prefixed stable ids. Clearing
    // them on every toggle would un-read/un-bookmark everything in BOTH
    // modes each time the user flips the settings switch.
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
            // leaving the default-true spinner running forever. A
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
    // The object injected as `pluginService` is NOT always the real
    // PluginService. A desktop-widget INSTANCE receives
    // instanceScopedPluginService from DesktopPluginWrapper.qml, which
    // implements only load/savePluginData -- it has NO load/savePluginState.
    // Calling those on it throws, and that exception used to abort
    // fetchAllFeeds() before a single feed was requested (stuck on "No items
    // loaded"). So: prefer the real singleton, feature-detect it, and never
    // let a persistence failure take the fetch path down with it.
    readonly property var stateService: ReaderState.resolveStateService(typeof PluginService !== "undefined" ? PluginService : null, root.pluginService)

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

        var summaries = root.readState("summaries", null);
        if (summaries && typeof summaries === "object" && Array.isArray(summaries.order)) {
            // Rebuilt through addSummary rather than trusted wholesale: a
            // state file hand-edited or written by an older build could carry
            // an order longer than the current cap, or ids with no entry.
            var rebuilt = { order: [], map: {} };
            for (var si = summaries.order.length - 1; si >= 0; si--) {
                var sid = summaries.order[si];
                if (typeof sid === "string" && typeof summaries.map[sid] === "string")
                    rebuilt = ReaderState.addSummary(rebuilt.order, rebuilt.map, sid, summaries.map[sid], root.summaryCap);
            }
            root.summaryOrder = rebuilt.order;
            root.summaryMap = rebuilt.map;
        }

        root.notifiedIds = ReaderState.boundIdList(root.readState("notifiedIds", []), root.idHistoryCap);

        var storedFetch = root.readState("feedLastFetch", {});
        root.feedLastFetch = (storedFetch && typeof storedFetch === "object") ? storedFetch : {};

        var stored = root.readState("snoozes", {});
        root.snoozeMap = ReaderState.pruneSnoozes((stored && typeof stored === "object") ? stored : {}, Date.now());

        root.readerStateLoaded = true;
    }

    // Drops cached summaries for items that have aged out of the feed.
    //
    // This lives on the refresh-completion path and NOWHERE else. It used to
    // sit in applyFilter() next to pruneSelected(), which was wrong twice
    // over. applyFilter() runs on every search keystroke and filter-chip
    // click, so the prune re-walked the whole dataset for a question that can
    // only change on a refresh. Worse, applyFilter() also runs immediately
    // after `allItems` is emptied -- when every feed is disabled or deleted
    // (see finalizeFetch's descriptors.length === 0 path) and on a
    // sourceMode switch -- and "prune against an empty dataset" means "delete
    // every summary", which was then persisted and unrecoverable. A summary
    // costs a GPU job; losing the lot because a feed was toggled off is not a
    // recoverable mistake.
    //
    // Hence both guards below. The empty check is the important one; the
    // length check merely avoids rewriting a map of paragraphs when nothing
    // actually changed.
    // Whether a feed is due, given its own interval.
    //
    // Opt-in by design: a feed with no intervalMinutes is always due and keeps
    // the global cycle, so adding this feature changes nothing for anyone who
    // does not configure it. Only an explicit positive interval throttles.
    function feedIsDue(feed, nowMs) {
        return ReaderState.isFeedDue(feed, root.feedLastFetch, nowMs);
    }

    function previousStatusFor(url) {
        for (var i = 0; i < root.feedStatuses.length; i++) {
            if (root.feedStatuses[i].url === url)
                return root.feedStatuses[i];
        }
        return null;
    }

    function pruneSummaryCache(items) {
        if (!items || items.length === 0)
            return;
        if (root.summaryOrder.length === 0)
            return;

        var pruned = ReaderState.pruneSummaries(root.summaryOrder, root.summaryMap, items);
        if (pruned.order.length === root.summaryOrder.length)
            return;

        root.summaryOrder = pruned.order;
        root.summaryMap = pruned.map;
        root.persistSummaries();
    }

    // One batch embedding call over whatever lacks a vector, then a profile
    // from the starred items and a ranked order for everything else.
    //
    // Called on refresh completion and when the ranking settings change --
    // never on scroll, never per item. One request for the whole set is the
    // difference between a second of GPU and a minute of it.
    function refreshRanking() {
        if (!root.rankingConfigured) {
            root.rankedOrder = [];
            // Only explain when the user has actually asked for ranking.
            // Off-and-silent is correct; on-and-silent is the bug.
            root.rankingReason = root.rankingEnabled
                ? (root.aiEnabled ? "Set an embedding model in settings to rank by interest." : "Enable AI in settings to rank by interest.")
                : "";
            return;
        }
        if (root.rankingBusy)
            return;

        var starred = [];
        var i;
        for (i = 0; i < root.allItems.length; i++) {
            if (ReaderState.isBookmarked(root.bookmarkMap, root.allItems[i].id))
                starred.push(root.allItems[i]);
        }

        if (starred.length < Ranking.MIN_STARRED_FOR_PROFILE) {
            root.rankedOrder = [];
            root.rankingReason = "Star at least " + Ranking.MIN_STARRED_FOR_PROFILE + " articles to teach it what you like (" + starred.length + " so far).";
            return;
        }

        var needed = [];
        var neededIds = [];
        for (i = 0; i < root.allItems.length; i++) {
            var it = root.allItems[i];
            if (!it.id || root.vectorMap[it.id])
                continue;
            needed.push(root.aiProvider.prepareEmbedText(it));
            neededIds.push(it.id);
        }

        if (needed.length === 0) {
            root.applyRanking();
            return;
        }

        var req = root.aiProvider.embedRequest(needed, { model: root.aiEmbedModel });
        if (!req) {
            root.rankingReason = "No embedding model configured.";
            return;
        }

        root.rankingBusy = true;
        root.runRequest(req, function (output, code) {
            root.rankingBusy = false;

            var parsed = (code === 0 || output) ? req.parse(output) : null;
            if (!parsed || parsed.error || !parsed.vectors) {
                root.rankedOrder = [];
                root.rankingReason = (parsed && parsed.error) ? parsed.error : "Could not reach the embedding model.";
                return;
            }

            // Index-matched to neededIds by position, which embedRequest's
            // parse guarantees by reindexing on the API's own index field.
            var next = {};
            for (var k in root.vectorMap) {
                if (Object.prototype.hasOwnProperty.call(root.vectorMap, k))
                    next[k] = root.vectorMap[k];
            }
            for (var v = 0; v < parsed.vectors.length && v < neededIds.length; v++)
                next[neededIds[v]] = parsed.vectors[v];
            root.vectorMap = next;

            root.applyRanking();
        });
    }

    function applyRanking() {
        // buildInterestProfile takes { vector, starredAt } OBJECTS, not raw
        // vectors -- passing the vectors themselves made every one of them
        // fail its validity check, so a user with eight starred articles was
        // told there were not enough, forever. The shapes are adjacent enough
        // to look right and different enough to fail silently, which is the
        // whole reason tests/ranking.test.js now pins this exact call.
        //
        // starredAt comes from the bookmark order, which is newest-first, so
        // position 0 is the most recent star. The module only uses it to
        // decide WHICH stars survive the cap when there are more than it
        // wants, and relative order is all that requires.
        var starredVectors = [];
        var order = root.bookmarkOrder || [];
        var i;
        for (i = 0; i < root.allItems.length; i++) {
            var id = root.allItems[i].id;
            if (!id || !root.vectorMap[id] || !ReaderState.isBookmarked(root.bookmarkMap, id))
                continue;
            var pos = order.indexOf(id);
            starredVectors.push({
                vector: root.vectorMap[id],
                starredAt: (pos < 0) ? 0 : (order.length - pos)
            });
        }

        var built = Ranking.buildInterestProfile(starredVectors);
        if (!built.profile) {
            root.rankedOrder = [];
            root.rankingReason = "Not enough starred articles with embeddings yet.";
            return;
        }

        var ranked = Ranking.rankItems(root.allItems, root.vectorMap, built.profile);
        // rankingWeight is a percentage in settings; the module takes 0..1.
        // 0 is an exact reverse-chronological short-circuit in the module, so
        // sliding all the way down really is "off", not "nearly off".
        var blended = Ranking.blendWithRecency(ranked, { weight: root.rankingWeight / 100 });

        var order = [];
        for (i = 0; i < blended.length; i++)
            order.push(blended[i].id);
        root.rankedOrder = order;
        root.rankingReason = "";
        root.applyFilter();
    }

    // --- Digest (stage 3c) ---
    //
    // One call over the last 24 hours of titles and descriptions, rendered in
    // the reading window. Cheaper per item than summarising each article, and
    // the only AI feature here that is about the feed rather than one entry.
    property int digestGeneration: 0
    readonly property int digestWindowMs: 24 * 60 * 60 * 1000
    // Well above any sane maxItems, well below anything that would strain a
    // local model's context.
    readonly property int digestPoolCap: 300
    property var digestPool: []

    function recentItemsForDigest() {
        var cutoff = Date.now() - root.digestWindowMs;
        var pool = (root.digestPool && root.digestPool.length > 0) ? root.digestPool : root.allItems;
        var out = [];
        for (var i = 0; i < pool.length; i++) {
            var it = pool[i];
            // timestamp 0 means the feed gave no usable date. Included rather
            // than dropped: an undated item is far more likely to be a feed
            // with sloppy dates than a genuinely ancient article, and
            // silently omitting it from "the last 24 hours" is the kind of
            // gap nobody notices until they miss something.
            if (!it.timestamp || it.timestamp >= cutoff)
                out.push(it);
        }
        return out;
    }

    function openDigest() {
        if (!root.aiReady)
            return;
        readerWindow.openDigest(root.recentItemsForDigest().length);
    }

    function generateDigest() {
        if (!root.aiReady)
            return;

        var items = root.recentItemsForDigest();
        if (items.length === 0) {
            readerWindow.digestLoading = false;
            readerWindow.digestError = "Nothing published in the last 24 hours.";
            return;
        }

        var req = root.aiProvider.digestRequest(items);
        if (!req)
            return;

        readerWindow.digestError = "";
        readerWindow.digestText = "";
        readerWindow.digestLoading = true;
        readerWindow.digestItemCount = items.length;

        root.digestGeneration++;
        var generation = root.digestGeneration;

        root.runRequest(req, function (output, code) {
            if (generation !== root.digestGeneration)
                return;
            readerWindow.digestLoading = false;

            if (code !== null && code !== 0) {
                var failure = output ? req.parse(output) : null;
                readerWindow.digestError = code === 124 ? "The model timed out." : ((failure && failure.error) ? failure.error : "Could not reach the AI runtime.");
                return;
            }

            var result = req.parse(output);
            if (result.error) {
                readerWindow.digestError = result.error;
                return;
            }
            if (!result.text) {
                readerWindow.digestError = "The model returned an empty digest.";
                return;
            }
            readerWindow.digestText = result.text;
        });
    }

    // Marks everything the cursor scrolled past, given the row now at the top.
    // The id bookkeeping lives in ReaderState so the "which ids" question is
    // testable; this only supplies the anchors and writes the result.
    property string _scrollTopId: ""

    function markScrolledPastRead(topIndex) {
        if (!root.markReadOnScroll || topIndex < 0 || topIndex >= feedModel.count)
            return;

        var orderedIds = [];
        for (var i = 0; i < feedModel.count; i++)
            orderedIds.push(feedModel.get(i).itemId);

        var topId = feedModel.get(topIndex).itemId;
        var previous = root._scrollTopId;
        root._scrollTopId = topId;
        if (!previous || previous === topId)
            return;

        // visibleIds[0] IS the new top anchor -- passing an empty array
        // makes the module return nothing, every time, silently.
        var passed = ReaderState.itemsScrolledPast([topId], previous, orderedIds);
        if (!passed || passed.length === 0)
            return;

        var order = root.readOrder;
        for (var j = 0; j < passed.length; j++) {
            if (root.readMap[passed[j]] !== true)
                order = ReaderState.addRead(order, passed[j], root.idHistoryCap);
        }
        if (order === root.readOrder)
            return;

        root.readOrder = ReaderState.boundIdList(order, root.idHistoryCap);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();
    }

    // --- Per-source snooze ---
    //
    // Hides one feed's items until a deadline, without disabling the feed:
    // a disabled feed stops being fetched at all and its items vanish from
    // history, whereas a snoozed one keeps syncing quietly and simply stops
    // shouting. They are different intentions and deserve different controls.
    function snoozeSource(sourceUrl, hours) {
        if (!sourceUrl)
            return;
        var until = Date.now() + Math.max(1, hours) * 3600000;
        root.snoozeMap = ReaderState.snoozeSource(root.snoozeMap, sourceUrl, until);
        root.writeState("snoozes", root.snoozeMap);
        root.applyFilter();
    }

    // "z" on a row snoozes the feed that row came from, for a day.
    //
    // Toasts, unlike the AI paths: this one hides content the user can no
    // longer see, so silence would be indistinguishable from the key having
    // done nothing -- and the toast is where "shift+z" gets taught, since a
    // snoozed feed leaves no row behind to discover it from.
    function snoozeFromRow(itemId) {
        var article = root.itemById(itemId);
        if (!article)
            return;
        var url = article.sourceUrl || "";
        if (!url) {
            root.toastError("That item's feed has no address to snooze");
            return;
        }
        root.snoozeSource(url, 24);
        if (typeof ToastService !== "undefined")
            ToastService.showInfo("Snoozed " + (article.source || "that feed") + " for a day", "Shift+Z wakes every snoozed feed");
    }

    property string audioPlayerCommand: pluginData.audioPlayerCommand ?? "mpv"

    // Hands a podcast episode to an external player.
    //
    // execDetached, not Proc.runCommand: a player is long-lived and
    // runCommand kills what it spawned when its timeout expires -- the same
    // reasoning the editor-open path already records.
    //
    // HONEST LIMITATION, worth stating because the backlog's goal was
    // specifically "so podcast feeds play through the DMS media widget":
    // that widget lists MPRIS players, and whether this episode appears there
    // depends entirely on whether the configured player publishes MPRIS. mpv
    // does NOT on its own -- it needs the separate mpv-mpris plugin, which is
    // not installed on this machine (checked). VLC publishes it natively.
    // So this plays the episode reliably; it appears in the media widget only
    // if the player was set up for that. The alternative -- the widget
    // registering itself as an MPRIS player -- would mean owning playback,
    // which is a different and much larger feature.
    function playEnclosure(itemId) {
        var article = root.itemById(itemId);
        if (!article)
            return;
        var url = article.audioUrl || "";
        if (!url) {
            root.toastError("That item has no audio to play");
            return;
        }
        var cmd = (root.audioPlayerCommand || "mpv").trim();
        if (!cmd)
            return;
        // Split on whitespace so a command with flags works, and never build
        // a shell string -- argv only, exactly as the editor-open path does.
        var argv = cmd.split(/\s+/);
        argv.push(url);
        Quickshell.execDetached(argv);
        if (typeof ToastService !== "undefined")
            ToastService.showInfo("Playing " + (article.title || "episode"));
    }

    // Steps "all folders" -> each category -> back to all. Wrapping matters:
    // with no way back the chip would be a one-way trip into a filter the
    // user has to guess how to leave.
    function cycleCategory() {
        var cats = root.availableCategories;
        if (cats.length === 0) {
            root.categoryFilter = "";
            return;
        }
        var at = cats.indexOf(root.categoryFilter);
        root.categoryFilter = (at < 0) ? cats[0] : ((at + 1 >= cats.length) ? "" : cats[at + 1]);
        root.applyFilter();
    }

    // Names the failing feeds. A toast rather than a panel: this is a thing
    // you glance at and then go fix in settings, not something to read in a
    // widget three inches wide.
    function showFeedErrors() {
        if (root.failedFeedCount === 0 || typeof ToastService === "undefined")
            return;
        ToastService.showWarning(
            root.failedFeedCount === 1 ? "1 feed failed to fetch" : root.failedFeedCount + " feeds failed to fetch",
            root.failedFeedSummary);
    }

    // Quickshell exposes no clipboard type and DMS's ClipboardService only
    // re-copies entries that are already in its history, so neither can take
    // arbitrary text. wl-copy can, it is present on this system, and "--"
    // plus argv (never a shell string) keeps an article body that happens to
    // contain quotes or a leading dash from being read as options.
    //
    // execDetached rather than runCommand: wl-copy deliberately stays alive to
    // serve the selection, and runCommand would kill it on timeout -- taking
    // the clipboard contents with it.
    function copyToClipboard(text) {
        if (!text)
            return;
        Quickshell.execDetached(["wl-copy", "--", text]);
        if (typeof ToastService !== "undefined")
            ToastService.showInfo("Copied to clipboard");
    }

    function unsnoozeAll() {
        var count = 0;
        for (var k in root.snoozeMap) {
            if (Object.prototype.hasOwnProperty.call(root.snoozeMap, k))
                count++;
        }
        if (count === 0)
            return;
        root.snoozeMap = {};
        root.writeState("snoozes", root.snoozeMap);
        root.applyFilter();
        if (typeof ToastService !== "undefined")
            ToastService.showInfo(count === 1 ? "Woke 1 snoozed feed" : "Woke " + count + " snoozed feeds");
    }

    function unsnoozeSource(sourceUrl) {
        if (!sourceUrl)
            return;
        root.snoozeMap = ReaderState.unsnoozeSource(root.snoozeMap, sourceUrl);
        root.writeState("snoozes", root.snoozeMap);
        root.applyFilter();
    }

    function persistSummaries() {
        root.writeState("summaries", {
            order: root.summaryOrder,
            map: root.summaryMap
        });
    }

    // Called by the reader window's "i" / Summarise button. Everything the
    // window needs comes back on its summary* properties -- it never sees the
    // provider, the cache or Proc.
    function requestSummary(itemId) {
        if (!root.aiReady || !itemId)
            return;

        var cached = ReaderState.getSummary(root.summaryMap, itemId);
        if (cached !== null) {
            readerWindow.summaryLoading = false;
            readerWindow.summaryError = "";
            readerWindow.summaryText = cached;
            return;
        }

        var article = root.itemById(itemId);
        if (!article)
            return;

        var req = root.aiProvider.summariseRequest(article);
        if (!req)
            return;

        readerWindow.summaryError = "";
        readerWindow.summaryText = "";
        readerWindow.summaryLoading = true;

        root.summaryGeneration++;
        var generation = root.summaryGeneration;

        root.runRequest(req, function (output, code) {
            readerWindow.summaryLoading = false;

            // Article identity, not generation, decides whether ANY of this
            // may be shown. summaryGeneration only advances when a new
            // summary is asked for, so navigating away without asking again
            // leaves it satisfied -- which used to let a failure from the
            // previous article render against the one now on screen.
            var stillOnThisArticle = readerWindow.itemId === itemId;
            var superseded = generation !== root.summaryGeneration;

            if (code !== null && code !== 0) {
                if (!superseded && stillOnThisArticle) {
                    // No toast, by design. The reader window shows this and
                    // nothing else does -- a local runtime that is simply not
                    // running is not an event worth interrupting anyone for.
                    //
                    // A nonzero exit is not automatically "unreachable".
                    // --fail-with-body makes an HTTP 4xx exit 22 while still
                    // returning the runtime's own error text, which is far
                    // more use than a guess -- "model not found" beats
                    // "could not reach" when the host answered perfectly
                    // well. So parse first and only fall back to the generic
                    // wording when the body tells us nothing.
                    var failure = output ? req.parse(output) : null;
                    if (code === 124)
                        readerWindow.summaryError = "The model timed out.";
                    else if (failure && failure.error)
                        readerWindow.summaryError = failure.error;
                    else
                        readerWindow.summaryError = "Could not reach the AI runtime.";
                }
                return;
            }

            var result = req.parse(output);
            if (result.error) {
                if (!superseded && stillOnThisArticle)
                    readerWindow.summaryError = result.error;
                return;
            }
            if (result.text === null || result.text === "") {
                if (!superseded && stillOnThisArticle)
                    readerWindow.summaryError = "The model returned an empty summary.";
                return;
            }

            // Cached unconditionally, BEFORE any supersede check. The summary
            // is keyed by item id, so a result that arrived too late to show
            // is still a correct answer for the article that asked -- and it
            // cost a real GPU job. Throwing it away meant asking again later
            // re-ran the model for an answer we had already paid for.
            var next = ReaderState.addSummary(root.summaryOrder, root.summaryMap, itemId, result.text, root.summaryCap);
            root.summaryOrder = next.order;
            root.summaryMap = next.map;
            root.persistSummaries();

            if (!superseded && stillOnThisArticle)
                readerWindow.summaryText = result.text;
        });
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
        // bookmarkMap/bookmarkOrder double as Miniflux's starred state -- no
        // separate starred map. An RSS id's "h:"/"g:"/"l:" prefix can never
        // collide with a Miniflux "m:" id, so switching sourceMode naturally
        // hides the other mode's bookmarks from view without deleting them.
        //
        // wasBookmarked MUST be read BEFORE the local toggle below: Google
        // Reader's edit-tag has no "set" endpoint, only explicit add/remove,
        // so toggleStarRequest needs the PRIOR starred state to pick a=/r=.
        // Reading it after the toggle would report the NEW state and send
        // the wrong one.
        var wasBookmarked = !!root.bookmarkMap[itemId];

        root.bookmarkOrder = ReaderState.toggleBookmark(root.bookmarkOrder, itemId, root.idHistoryCap);
        root.bookmarkMap = ReaderState.buildIdMap(root.bookmarkOrder);
        root.saveBookmarkState();

        // Asking the backend directly (instead of branching on sourceMode)
        // means this is a no-op for free on any backend without server-side
        // star state: StandardBackend.toggleStarRequest always returns null.
        var req = root.backend.toggleStarRequest(root.backendConfig, root.backendSession, root.backendItemId(itemId), wasBookmarked);
        root.runRequest(req, function (output, code) {
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

    // Shared by the row click and the "o"/Enter keyboard action so neither
    // path can drift from the other. Row click ALWAYS opens + marks read,
    // same as the mouse comment below explains; the overview-guard check
    // stays with the mouse handler since it only ever applies to a stray
    // pointer click, never a keypress.
    function openItem(itemId, link) {
        if (!itemId)
            return;
        root.markRead(itemId);
        // Opening an item syncs read state to the server only when the user
        // opted in via "Mark as read on open" -- unlike the explicit
        // mark-read button/key, which always syncs.
        if (root.syncReadOnOpen) {
            var numId = root.backendItemId(itemId);
            root.runRequest(root.backend.markReadRequest(root.backendConfig, root.backendSession, numId ? [numId] : []), function (output, code) {
                if (code !== null && code !== 0)
                    root.toastError("Failed to mark as read");
            });
        }
        if (root.openInBrowser && link) {
            // SECURITY: never hand an unsafe-scheme link (javascript:, file:,
            // data:, ...) to Qt.openUrlExternally -- surface it instead so
            // the user knows the feed gave a bad link, rather than silently
            // swallowing it.
            if (!FeedParser.isSafeUrl(link)) {
                ToastService.showWarning("Blocked unsafe link from feed", link);
            } else if (!Qt.openUrlExternally(link)) {
                ToastService.showError("Could not open link", link);
            }
        }
    }

    // Shared by the "v" keyboard action and the row's view button. Opening
    // the reader window IS reading the article -- the same read-marking half
    // of openItem() runs here -- but unlike openItem() it never opens the
    // link externally; that is the reader window's own "o" binding once it's
    // open.
    // index is the row's position in feedModel, when the caller has it (a
    // keyboard row action or a row's own view button always does) -- it
    // becomes the reader window's cursor, so shift+j/shift+k and the position
    // indicator have a list position to work from. Omit it (or pass < 0) to
    // leave keyboardIndex alone.
    function viewItem(itemId, index) {
        if (!itemId)
            return;
        if (typeof index === "number" && index >= 0)
            root.keyboardIndex = index;
        root.markRead(itemId);
        if (root.syncReadOnOpen) {
            var numId = root.backendItemId(itemId);
            root.runRequest(root.backend.markReadRequest(root.backendConfig, root.backendSession, numId ? [numId] : []), function (output, code) {
                if (code !== null && code !== 0)
                    root.toastError("Failed to mark as read");
            });
        }
        var article = root.itemById(itemId);
        if (article) {
            readerWindow.openArticle(article);
            // openArticle() clears the summary fields; put a cached one back
            // straight away so revisiting an article already summarised is
            // instant and never re-runs the model.
            var cached = root.aiReady ? ReaderState.getSummary(root.summaryMap, itemId) : null;
            if (cached !== null)
                readerWindow.summaryText = cached;
        }
    }

    // "i" from the list: open the reader on this row showing only the summary,
    // and ask for that summary immediately.
    //
    // Deliberately NOT routed through viewItem() the way the reader's own
    // navigation is, for one reason: viewItem() marks the article read, and
    // reading a summary is not reading the article. An item you skimmed and
    // passed over must still be there next time you filter to unread --
    // otherwise this feature quietly empties your unread list on your behalf.
    // That is also why the cursor still moves: you looked at this row, so the
    // cursor should be on it, but you have not consumed it.
    function summariseItem(itemId, index) {
        if (!root.aiReady || !itemId)
            return;
        // Key-repeat guard, matching the reader's own "i" handler. Without it,
        // holding "i" spawns one model run per keypress.
        if (readerWindow.summaryLoading && readerWindow.itemId === itemId)
            return;
        if (index !== undefined && index >= 0)
            root.keyboardIndex = index;

        var article = root.itemById(itemId);
        if (!article)
            return;

        readerWindow.openArticle(article, true);
        // requestSummary already serves from cache when it can, so there is
        // no second cache lookup here.
        root.requestSummary(itemId);
    }

    // Wired to the reader window's shift+j/shift+k (nextRequested/prevRequested).
    // Deliberately reuses viewItem() rather than calling
    // readerWindow.openArticle() straight from here -- opening an article
    // must always go through the same read-marking wrapper "v" and the row's
    // view button already use, not a second copy of it. No wraparound: past
    // either end of feedModel this is a no-op, same as "j"/"k" at rest.
    function readerAdvance(delta) {
        if (root.keyboardIndex < 0 || feedModel.count === 0)
            return;
        var newIndex = root.keyboardIndex + delta;
        if (newIndex < 0 || newIndex >= feedModel.count)
            return;
        feedListView.positionViewAtIndex(newIndex, ListView.Contain);
        var row = feedModel.get(newIndex);
        root.viewItem(row.itemId, newIndex);
    }

    // Shared by the mark-read button and the "m" keyboard action. An
    // explicit toggle here ALWAYS syncs to the server, regardless of
    // syncReadOnOpen (that setting only gates openItem's "open" path above).
    function toggleReadSynced(itemId, wasRead) {
        if (wasRead)
            root.markUnread(itemId);
        else
            root.markRead(itemId);
        var numId = root.backendItemId(itemId);
        var ids = numId ? [numId] : [];
        var req = wasRead ? root.backend.markUnreadRequest(root.backendConfig, root.backendSession, ids) : root.backend.markReadRequest(root.backendConfig, root.backendSession, ids);
        root.runRequest(req, function (output, code) {
            if (code !== null && code !== 0)
                root.toastError(wasRead ? "Failed to mark as unread" : "Failed to mark as read");
        });
    }

    // Shared by the search toggle button and the "Esc"/"/" keyboard actions.
    // Closing search must not leave an invisible query silently filtering
    // the list.
    function closeSearch() {
        root.searchActive = false;
        if (root.searchQuery !== "") {
            searchField.clear();
            root.searchQuery = "";
            root.applyFilter();
        }
    }

    // --- Keyboard navigation ---
    // KeyMap.resolveKey is pure; this is the only place its named actions
    // turn into side effects. Every action below reuses a function the mouse
    // path already calls -- see docs/plans/2026-09-10-phase2-keyboard-design.md.
    function buildKeyState() {
        return {
            index: root.keyboardIndex,
            count: feedModel.count,
            searchActive: root.searchActive,
            hasSelection: root.selectedCount > 0,
            pending: root.pending,
            pendingAt: root.pendingAt,
            now: Date.now()
        };
    }

    function handleKeyEvent(event) {
        // The help overlay is QML-only state that KeyMap knows nothing
        // about, so plain Esc closing it has to be handled here, ahead of
        // resolveKey's own search/selection/cursor layering. "?" itself
        // still reaches resolveKey below, since toggling it back closed is
        // just another "toggleHelp".
        if (root.helpVisible && event.key === KeyMap.Key_Escape) {
            root.helpVisible = false;
            event.accepted = true;
            return;
        }

        var result = KeyMap.resolveKey(event, root.buildKeyState());

        // resolveKey cannot stamp its own timestamp (see KeyMap.js's header
        // comment) -- QML records when a "g" pending state was armed so the
        // next keystroke can judge the 800ms timeout.
        root.pending = result.pending;
        if (result.pending)
            root.pendingAt = Date.now();

        if (result.action === null) {
            event.accepted = false;
            return;
        }

        event.accepted = true;

        switch (result.action) {
        case "move":
            root.keyboardIndex = result.index;
            // Keeps the cursor from ever leaving the viewport, same as
            // scrolling to a search hit would.
            feedListView.positionViewAtIndex(result.index, ListView.Contain);
            break;
        case "open":
            {
                var openRow = feedModel.get(result.index);
                root.openItem(openRow.itemId, openRow.link);
                break;
            }
        case "view":
            {
                var viewRow = feedModel.get(result.index);
                root.viewItem(viewRow.itemId, result.index);
                break;
            }
        case "digest":
            root.openDigest();
            break;
        case "snoozeSource":
            {
                var snoozeRow = feedModel.get(result.index);
                root.snoozeFromRow(snoozeRow.itemId);
                break;
            }
        case "unsnoozeAll":
            root.unsnoozeAll();
            break;
        case "playAudio":
            {
                var audioRow = feedModel.get(result.index);
                root.playEnclosure(audioRow.itemId);
                break;
            }
        case "summarise":
            {
                var sumRow = feedModel.get(result.index);
                root.summariseItem(sumRow.itemId, result.index);
                break;
            }
        case "toggleRead":
            {
                var readRow = feedModel.get(result.index);
                root.toggleReadSynced(readRow.itemId, root.readMap[readRow.itemId] === true);
                break;
            }
        case "markSelectedRead":
            // Mirrors markReadRect's own state-awareness: once every
            // selected item is already read, the action flips to unread,
            // same as the selection bar's button does.
            if (root.selectedAllRead)
                root.bulkMarkUnreadSelected();
            else
                root.bulkMarkReadSelected();
            break;
        case "toggleStar":
            {
                var starRow = feedModel.get(result.index);
                root.toggleBookmark(starRow.itemId);
                break;
            }
        case "saveSelected":
            root.bulkSaveSelected();
            break;
        case "exportSelected":
            root.exportSelected();
            break;
        case "exportItem":
            {
                // No affordance/error/prompt at all when nothing is
                // configured -- silently doing nothing here is the point,
                // not a shortcut.
                if (!root.exportRoot)
                    break;
                var exportRow = feedModel.get(result.index);
                var exportArticle = root.itemById(exportRow.itemId);
                if (exportArticle)
                    root.exportArticles([exportArticle]);
                break;
            }
        case "toggleSelect":
            {
                var selectRow = feedModel.get(result.index);
                root.toggleSelected(selectRow.itemId);
                break;
            }
        case "focusSearch":
            root.searchActive = true;
            break;
        case "closeSearch":
            root.closeSearch();
            break;
        case "clearSelection":
            root.clearSelection();
            break;
        case "clearCursor":
            root.keyboardIndex = -1;
            break;
        case "refresh":
            root.refreshNow();
            break;
        case "markAllRead":
            root.setAllRead(true);
            if (root.filterMode === "unread")
                root.applyFilter();
            break;
        case "toggleHelp":
            root.helpVisible = !root.helpVisible;
            break;
        }
    }

    function toggleSelected(itemId) {
        if (!itemId)
            return;
        root.selectedMap = ReaderState.toggleSelected(root.selectedMap, itemId);
    }

    function clearSelection() {
        root.selectedMap = ReaderState.clearSelection();
    }

    function bulkMarkReadSelected() {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0)
            return;
        root.readOrder = ReaderState.addAllRead(root.readOrder, ids, root.idHistoryCap);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();

        // Push to the server in one batched call rather than one per id
        // (Miniflux's PUT /v1/entries accepts an array of entry_ids).
        // Filtered to ids the active backend recognizes as a cheap
        // correctness guard -- only one source mode's items are ever in
        // allItems/selectedMap at a time, so this should never actually
        // drop anything in practice. markReadRequest is a no-op (null) on
        // any backend without server-side read state.
        var numIds = [];
        for (var i = 0; i < ids.length; i++) {
            var numId = root.backendItemId(ids[i]);
            if (numId)
                numIds.push(numId);
        }
        root.runRequest(root.backend.markReadRequest(root.backendConfig, root.backendSession, numIds), function (output, code) {
            if (code !== null && code !== 0)
                root.toastError("Failed to mark as read");
        });

        root.clearSelection();
        if (root.filterMode === "unread")
            root.applyFilter();
    }

    function bulkMarkUnreadSelected() {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0)
            return;
        root.readOrder = ReaderState.removeAllRead(root.readOrder, ids);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();

        // Same batched-push pattern as bulkMarkReadSelected, mirrored for
        // the unread direction.
        var numIds = [];
        for (var i = 0; i < ids.length; i++) {
            var numId = root.backendItemId(ids[i]);
            if (numId)
                numIds.push(numId);
        }
        root.runRequest(root.backend.markUnreadRequest(root.backendConfig, root.backendSession, numIds), function (output, code) {
            if (code !== null && code !== 0)
                root.toastError("Failed to mark as unread");
        });

        root.clearSelection();
        if (root.filterMode === "unread")
            root.applyFilter();
    }

    function bulkSaveSelected() {
        var ids = Object.keys(root.selectedMap);
        if (ids.length === 0)
            return;

        // Capture "already bookmarked" BEFORE the local additive update
        // below, since addAllBookmarked marks every selected id as
        // bookmarked regardless of prior state -- checking bookmarkMap AFTER
        // that update would see every id as bookmarked and could never tell
        // which ones were newly starred.
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
            // currentlyStarred is always false here: alreadyBookmarked
            // already filtered out anything starred before the loop began
            // (same "read before toggle" rule as toggleBookmark's
            // wasBookmarked).
            var numId = root.backendItemId(id);
            var req = root.backend.toggleStarRequest(root.backendConfig, root.backendSession, numId, false);
            root.runRequest(req, function (output, code) {
                if (code !== null && code !== 0)
                    root.toastError("Failed to toggle bookmark");
            });
        }

        root.clearSelection();
    }

    // --- Notes export ---
    //
    // One FileView per file being written, created fresh for that write and
    // destroyed when it finishes. A single shared FileView driven through a
    // queue (set path, setText(), wait for onSaved, advance) was tried first
    // and dropped: quickshell's own docs for FileView (fileview.hpp) say
    // `preload` defaults to true and `blockLoading` only makes text()/data()
    // *reads* block -- it does not make a `path` change itself synchronous.
    // So reusing one FileView across N paths starts a background load of
    // each new path while the previous write may still be in flight, and
    // the second write can race that load. Giving every write its own
    // FileView removes the shared `path`/`text` state those two operations
    // would otherwise race over -- there is nothing left to interleave.
    //
    // _exportResults is indexed by the original selection order (not
    // completion order, since writes now finish in parallel) so the
    // reported "first" failure always means first in the article list the
    // user selected, matching the old sequential behaviour exactly.
    property var _exportResults: []
    property int _exportPending: 0

    function itemById(id) {
        for (var i = 0; i < root.allItems.length; i++) {
            if (root.allItems[i].id === id)
                return root.allItems[i];
        }
        return null;
    }

    // Shared by the "e" keyboard action (with a selection) and the
    // selection bar's Export button.
    function exportSelected() {
        if (!root.exportRoot)
            return;
        var ids = Object.keys(root.selectedMap);
        var articles = [];
        for (var i = 0; i < ids.length; i++) {
            var article = root.itemById(ids[i]);
            if (article)
                articles.push(article);
        }
        root.exportArticles(articles);
        root.clearSelection();
    }

    // Shared entry point for both the "e" keyboard action and the selection
    // bar's Export button. `articles` is already the list of full article
    // objects to export -- callers resolve ids to root.allItems entries
    // before calling this.
    //
    // Path validation happens up front and does NOT depend on the article's
    // body text, so it runs before any network request -- a hostile or
    // misconfigured title is rejected without ever fetching that article's
    // page. Each surviving article then becomes one job; jobs that fetch
    // full text resolve asynchronously and out of order, but _exportPending
    // (shared with the write-completion path in _exportItemDone) still only
    // reaches zero once every job -- fetched or not -- has been written.
    function exportArticles(articles) {
        if (!root.exportRoot || articles.length === 0)
            return;
        // A batch is already running -- dropping a second trigger (a
        // double keypress, or the key firing while a click is still being
        // processed) rather than starting a second overlapping batch.
        if (root._exportPending > 0)
            return;

        var jobs = [];
        var firstBuildError = "";
        for (var i = 0; i < articles.length; i++) {
            var article = articles[i];
            var probe = root.exportProvider.buildNote(article, []);
            if (probe.error) {
                // Rule 1 of the design doc: buildNote refuses a path that
                // would escape the export root. Unreachable in practice --
                // if a user ever sees this, it is a bug report worth having.
                if (!firstBuildError)
                    firstBuildError = (article && article.title) || "an article";
                continue;
            }
            jobs.push({ article: article, title: (article && article.title) || "an article" });
        }

        if (firstBuildError)
            root.toastError("Could not export \"" + firstBuildError + "\": generated path escaped the export folder");

        if (jobs.length === 0)
            return;

        root._exportResults = new Array(jobs.length);
        root._exportPending = jobs.length;

        for (var j = 0; j < jobs.length; j++) {
            root._prepareExportJob(jobs[j].article, jobs[j].title, j);
        }
    }

    // Fetches the article's own page and extracts it, when the user has
    // opted into full-text export and the item actually has a link -- on
    // demand only, once per article being exported right now, never on a
    // feed refresh or a scroll. Falls through to the plain (no-extraction)
    // path when the toggle is off or there is no link, so the request is
    // never made unless it was asked for.
    function _prepareExportJob(article, title, index) {
        if (!root.exportFullText || !(article && article.link)) {
            root._fetchImagesForJob(article, title, index, null);
            return;
        }

        // Server-side extraction first, where the backend offers it: Miniflux
        // has already fetched and parsed the page, so asking it costs one
        // local API call instead of a round trip to the article's own site.
        //
        // Strictly an optimisation, never the only route -- the backlog is
        // explicit that a feature working on one backend and silently doing
        // nothing on another is the fragmentation the backend interface
        // exists to prevent. So every failure here falls through to the
        // local extractor rather than failing the note: no capability, no
        // id, a refusal, a malformed body, a timeout. The user cannot tell
        // which path produced their note, which is the point.
        if (root.backend.capabilities.fullText) {
            var backendId = root.backendItemId(article.id);
            var fastReq = backendId ? root.backend.fullTextRequest(root.backendConfig, backendId) : null;
            if (fastReq) {
                root.queueProc(fastReq.argv, fastReq.timeoutMs || undefined, function (out, code) {
                    var served = null;
                    if (code === 0 && out) {
                        var parsedFast = fastReq.parse(out);
                        if (!parsedFast.error && parsedFast.content) {
                            // Run the server's HTML through the SAME extractor
                            // the local route uses, rather than flattening it
                            // to text. Miniflux returns article HTML, and
                            // stripping it would cost every paragraph break,
                            // heading and link -- a worse note than the local
                            // path produces, which is the opposite of an
                            // optimisation. Sending it through extractArticle
                            // means both routes emit identical markdown and
                            // the only difference is who fetched the page.
                            var fastExtract = HtmlExtract.extractArticle(parsedFast.content, {
                                summary: ExportProvider.articleSummaryText(article),
                                baseUrl: article.link || ""
                            });
                            if (!fastExtract.usedFallback)
                                served = fastExtract;
                        }
                    }
                    if (served) {
                        root._fetchImagesForJob(article, title, index, served);
                        return;
                    }
                    root._prepareExportJobLocal(article, title, index);
                });
                return;
            }
        }

        root._prepareExportJobLocal(article, title, index);
    }

    // The original local route: fetch the article's own page and extract it.
    function _prepareExportJobLocal(article, title, index) {
        if (!root.exportFullText || !(article && article.link)) {
            root._fetchImagesForJob(article, title, index, null);
            return;
        }

        var req = ExportProvider.buildArticleFetchRequest(article.link);
        root.queueProc(req.argv, req.timeoutMs || undefined, function (out, code) {
            // A per-article fetch failure (bad host, 404, timeout, refused
            // connection) must not abort the batch -- fall back to the
            // summary for THIS note alone and keep going. `extracted` stays
            // null here exactly like the toggle-off path above, so buildNote
            // renders the honest "extracted: false" note either way.
            var extracted = null;
            if (code === 0 && out) {
                // baseUrl resolves the article's site-relative links. Without
                // it they emit as "/news/articles/x", which reads as a link
                // and goes nowhere in a markdown file.
                extracted = HtmlExtract.extractArticle(out, {
                    summary: ExportProvider.articleSummaryText(article),
                    baseUrl: article.link || ""
                });
            }
            root._fetchImagesForJob(article, title, index, extracted);
        });
    }

    // Downloads the note's images into the attachments folder, then hands on
    // to the write. Off by default, and skipped entirely when there is
    // nothing to fetch, so the common path is unchanged.
    //
    // The note path is needed BEFORE the images, because attachment names are
    // derived from it -- so the note is built once without images purely to
    // learn its relPath, then built again with the map once they land. That
    // double build is cheap (string assembly, no I/O) and is what keeps the
    // attachment names deterministic: re-exporting overwrites rather than
    // accumulating -1, -2, -3 copies of the same picture.
    //
    // A failed image is NOT a failed note. Each fetch reports into the same
    // tally and whatever succeeded gets rewritten to local paths; anything
    // that did not keeps its original remote URL, so the note degrades to
    // today's behaviour for that image alone rather than pointing at a file
    // that was never written.
    function _fetchImagesForJob(article, title, index, extracted) {
        if (!root.exportImages) {
            root._writeExportJob(article, title, index, extracted, null);
            return;
        }

        var probe = root.exportProvider.buildNote(article, [], extracted);
        if (probe.error) {
            root._writeExportJob(article, title, index, extracted, null);
            return;
        }

        var markdown = extracted && extracted.markdown ? extracted.markdown : ExportProvider.articleSummaryText(article);
        var urls = ExportProvider.collectImageUrls(markdown, article, FeedParser.isSafeUrl);
        if (!urls || urls.length === 0) {
            root._writeExportJob(article, title, index, extracted, null);
            return;
        }

        var baseName = probe.relPath.replace(/^.*[\/]/, "").replace(/\.md$/i, "");
        var root_ = root.exportRoot.replace(/[\/\\]+$/, "");
        var imageMap = {};
        var remaining = urls.length;

        var finish = function () {
            remaining--;
            if (remaining > 0)
                return;
            root._writeExportJob(article, title, index, extracted, imageMap);
        };

        for (var i = 0; i < urls.length; i++) {
            (function (url, at) {
                var rel = ExportProvider.attachmentPath(baseName, url, at, { attachmentDir: root.attachmentDir });
                var req = ExportProvider.buildImageFetchRequest(url, root_ + "/" + rel);
                root.queueProc(req.argv, req.timeoutMs || undefined, function (out, code) {
                    if (code === 0)
                        imageMap[url] = rel;
                    finish();
                });
            })(urls[i], i);
        }
    }

    // Builds the final note (now that extraction, if any, has resolved) and
    // hands it to the same one-FileView-per-write path as before.
    function _writeExportJob(article, title, index, extracted, imageMap) {
        var note = root.exportProvider.buildNote(article, [], extracted, imageMap || undefined);
        if (note.error) {
            // The path was already validated by the probe in exportArticles
            // before any fetch started, so this is unreachable in practice --
            // treated as a write failure so _exportPending still reaches
            // zero and the batch still finishes reporting.
            root._exportItemDone(index, false, title);
            return;
        }

        var view = exportFileViewComponent.createObject(root, {
            exportIndex: index,
            exportTitle: title,
            exportRelPath: note.relPath,
            path: root.exportRoot.replace(/[\/\\]+$/, "") + "/" + note.relPath
        });
        view.setText(note.content);
    }

    // Runs whatever the active preset's open command resolves to, once the
    // note it names has actually finished writing. `openRequest` returns
    // null for "no command configured" (write and stop) and for a template
    // that failed to parse -- both are silent no-ops here, not errors, since
    // the note itself was still written successfully either way.
    function _openAfterWrite(relPath) {
        var req = root.exportProvider.openRequest(relPath);
        if (!req) return;
        if (req.url) {
            // Obsidian is a URL handler, not an executable -- Qt.openUrlExternally
            // is the same mechanism this widget already uses for article links.
            Qt.openUrlExternally(req.url);
        } else if (req.argv) {
            // execDetached, NOT Proc.runCommand: an editor is a long-lived
            // process, and runCommand applies a default timeout and kills what
            // it spawned when that expires -- which closed the terminal a few
            // seconds after it opened. Fire and forget instead. Still argv
            // only, never a shell string (see buildOpenRequest's header).
            Quickshell.execDetached(req.argv);
        }
    }

    // Called once per write, in whatever order writes actually finish
    // (they run in parallel, one FileView each). Only the last one to
    // finish reports -- _exportResults is filled in article order first,
    // then walked in that order so "first failure" means first in the
    // user's selection, not first to complete.
    function _exportItemDone(index, success, title) {
        root._exportResults[index] = {
            success: success,
            title: title
        };
        root._exportPending--;
        if (root._exportPending > 0)
            return;

        var written = 0;
        var firstFailure = "";
        for (var i = 0; i < root._exportResults.length; i++) {
            var result = root._exportResults[i];
            if (result.success)
                written++;
            else if (!firstFailure)
                firstFailure = result.title;
        }

        if (firstFailure) {
            root.toastError(written + " note" + (written === 1 ? "" : "s") + " written, failed starting at \"" + firstFailure + "\"");
        } else if (written > 0) {
            if (typeof ToastService !== "undefined")
                ToastService.showInfo(written + " note" + (written === 1 ? "" : "s") + " written");
        }
    }

    // blockWrites/atomicWrites match DMS's own cache writer exactly (see
    // /usr/share/quickshell/dms/Common/CacheData.qml) -- no shell, no Proc,
    // and a half-written note is never visible to Obsidian's indexer.
    // preload is off since this FileView only ever writes -- it is never
    // read from, so there is no reason to load the file it is about to
    // overwrite.
    Component {
        id: exportFileViewComponent

        FileView {
            id: exportFileViewInstance
            property int exportIndex: -1
            property string exportTitle: ""
            property string exportRelPath: ""
            blockWrites: true
            atomicWrites: true
            preload: false

            onSaved: {
                root._exportItemDone(exportIndex, true, exportTitle);
                root._openAfterWrite(exportRelPath);
                exportFileViewInstance.destroy();
            }

            onSaveFailed: error => {
                root._exportItemDone(exportIndex, false, exportTitle);
                exportFileViewInstance.destroy();
            }
        }
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

        root.readOrder = read ? ReaderState.addAllRead(root.readOrder, ids, root.idHistoryCap) : ReaderState.removeAllRead(root.readOrder, ids);
        root.readMap = ReaderState.buildIdMap(root.readOrder);
        root.saveReadState();

        // Same batched-push pattern as bulkMarkReadSelected.
        var numIds = [];
        for (var i2 = 0; i2 < ids.length; i2++) {
            var numId = root.backendItemId(ids[i2]);
            if (numId)
                numIds.push(numId);
        }
        var req = read ? root.backend.markReadRequest(root.backendConfig, root.backendSession, numIds) : root.backend.markUnreadRequest(root.backendConfig, root.backendSession, numIds);
        root.runRequest(req, function (output, code) {
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

    // The ONLY place a request descriptor becomes a process. req.timeoutMs
    // must be honoured: Miniflux carries 30000 deliberately, longer than
    // curl's own 25s --max-time inside that descriptor's argv, so a
    // slow-but-fine request doesn't race Proc's default timeout and surface
    // a spurious failure toast. A null/absent request is a no-op for that
    // backend (e.g. StandardBackend's mark/star requests); report it via a
    // null exit code so callers can tell "nothing to do" apart from a real
    // failure.
    // --- Bounded process queue, for the export fan-out only ---
    //
    // Exporting a selection used to spawn everything at once: one curl per
    // article for full text, then one per image per article, all in the same
    // tick. "Select all" with thirty articles and a couple of pictures each is
    // over a hundred concurrent processes -- inside the shell's own process,
    // where a stall takes the bar and popups with it.
    //
    // Deliberately NOT applied to the AI or backend paths: those are single
    // requests, and queueing them behind an export batch would make a summary
    // wait on a hundred image fetches.
    readonly property int exportConcurrency: 4
    property var _procQueue: []
    property int _procActive: 0

    function queueProc(argv, timeoutMs, cb) {
        root._procQueue.push({
            argv: argv,
            timeoutMs: timeoutMs,
            cb: cb
        });
        root._pumpProcQueue();
    }

    function _pumpProcQueue() {
        while (root._procActive < root.exportConcurrency && root._procQueue.length > 0) {
            var job = root._procQueue.shift();
            root._procActive++;
            // IIFE: `job` is function-scoped, so without capturing it here
            // every callback in this loop would see the last job's closure.
            (function (j) {
                Proc.runCommand(null, j.argv, function (out, code) {
                    root._procActive--;
                    try {
                        j.cb(out, code);
                    } finally {
                        // Pump even if the callback threw, or one bad response
                        // would strand every job behind it forever.
                        root._pumpProcQueue();
                    }
                }, undefined, j.timeoutMs);
            })(job);
        }
    }

    function runRequest(req, cb) {
        if (!req) {
            cb(null, null);
            return;
        }
        // id is deliberately null on every call: Proc's debounce map
        // (_procDebouncers) keys entries by id and only cleans up entries
        // created with a falsy id. A fixed string id would be kept forever
        // and, worse, SHARED across overlapping calls (a manual refresh
        // firing while a periodic one is still in flight), so the second
        // call would clobber the first's callback before it exits. A null
        // id makes Proc generate a fresh id per call and self-clean.
        Proc.runCommand(null, req.argv, function (out, code) {
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

        // Invalidate any in-flight callbacks from a previous cycle. Without
        // this, two overlapping fetches would share one collector and one
        // pending counter, and the cycle would finalize early on a
        // half-filled result set. Incremented ABOVE the backend lookup below
        // so every backend shares one generation counter, even if sourceMode
        // is toggled mid-flight.
        root.fetchGeneration++;
        var gen = root.fetchGeneration;

        var backend = root.backend;
        var config = root.backendConfig;
        var requests = backend.fetchRequests(config, root.backendSession) || [];

        // Per-feed status rows: only a LOCAL (non-server-backed) backend has
        // a feed list of its own here -- a server-backed backend (Miniflux)
        // has no concept of it, just one logical stream. fetchRequests only
        // returns descriptors for ELIGIBLE feeds (enabled + url set); the
        // status rows for disabled/url-less feeds, which produce no
        // descriptor, are still QML's job.
        var statuses = [];
        var descriptors = [];
        var skippedUrls = [];
        var fetchStamps = {};
        var fetchNow = Date.now();

        if (!backend.capabilities.serverState) {
            // Keyed by meta.index (position in root.feeds), NOT by url: two
            // enabled feeds may share a url under different display names,
            // and keying on url would collapse them onto one descriptor so
            // one renders its items under the other's name.
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
                // Not due yet: no request, and crucially the PREVIOUS status
                // is carried forward rather than a fresh "loading" row that
                // nothing will ever resolve. Its articles are put back in
                // finalizeFetch from the retention pool.
                if (!root.feedIsDue(feed, fetchNow)) {
                    var prior = root.previousStatusFor(feed.url);
                    statuses.push(prior ? prior : {
                        url: feed.url,
                        name: name,
                        state: "ok",
                        lastFetched: 0,
                        lastSuccess: 0,
                        lastError: "",
                        itemCount: 0
                    });
                    skippedUrls.push(feed.url);
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
                if (matched) {
                    descriptors.push({
                        req: matched,
                        statusIndex: statuses.length - 1
                    });
                    fetchStamps[feed.url] = fetchNow;
                }
            }
        } else {
            // Server-backed backend: one synthetic status row per descriptor
            // (in practice at most one -- one server, one request). meta is
            // null (no per-feed identity to attribute), so fall back to a
            // generic label derived from the backend's own id.
            var label = root.backendLabel();
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
                descriptors.push({
                    req: req,
                    statusIndex: statuses.length - 1
                });
            }
        }

        root.feedStatuses = statuses;

        if (descriptors.length === 0) {
            // Nothing was requested. There are two very different reasons for
            // that and they must not share an outcome.
            //
            // If feeds were SKIPPED because none was due yet, the list is
            // still correct and must be left exactly as it is. Clearing it
            // here would empty the widget on any cycle where every feed was
            // inside its own interval -- articles vanishing for no visible
            // reason, which is the single failure this feature had to be
            // designed around.
            //
            // If nothing was skipped, there genuinely are no eligible feeds
            // (all disabled, or the last one deleted) and an empty list is the
            // honest answer.
            if (skippedUrls.length === 0)
                root.allItems = [];
            root.isLoading = false;
            root.feedStatuses = statuses;
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

        // Stamp the feeds we are actually asking for, so the next cycle can
        // tell what is due. Recorded on ATTEMPT rather than on success: a feed
        // that is failing should back off to its own interval too, instead of
        // being retried every global cycle.
        if (skippedUrls.length > 0 || Object.keys(fetchStamps).length > 0) {
            var stamps = {};
            for (var fk in root.feedLastFetch) {
                if (Object.prototype.hasOwnProperty.call(root.feedLastFetch, fk))
                    stamps[fk] = root.feedLastFetch[fk];
            }
            for (var nk in fetchStamps) {
                if (Object.prototype.hasOwnProperty.call(fetchStamps, nk))
                    stamps[nk] = fetchStamps[nk];
            }
            root.feedLastFetch = stamps;
            root.writeState("feedLastFetch", stamps);
        }

        var ctx = {
            gen: gen,
            pending: descriptors.length,
            collector: [],
            statuses: statuses,
            skipped: skippedUrls
        };

        for (var d = 0; d < descriptors.length; d++) {
            root.fetchDescriptor(descriptors[d].req, ctx.statuses[descriptors[d].statusIndex], ctx, hadItems);
        }
    }

    // Standard/Miniflux descriptors never set `nextRequest`, so ChainRunner
    // sees a single link and returns "done" (or "error") on the very first
    // step() call -- their path through runChainLink below is therefore
    // identical to the old single-shot fetchDescriptor in every observable
    // way. Google Reader's descriptor may chain through several requests
    // (ClientLogin -> token -> ids -> contents) before a step() call is
    // terminal.
    function fetchDescriptor(req, status, ctx, hadItems) {
        var chain = ChainRunner.createChain(req, ChainRunner.DEFAULT_MAX_LINKS);
        root.runChainLink(req, status, ctx, hadItems, chain);
    }

    // Runs one link of `chain` and hands its parse result to
    // ChainRunner.step(). THE PENDING COUNTER RULE: ctx.pending is
    // decremented exactly once per CHAIN, never once per request.
    // action === "next" recurses to run the following link and must NOT
    // touch ctx.pending; only "done" or "error" -- the chain's one terminal
    // result -- decrements it, right where the old single-request
    // fetchDescriptor used to.
    function runChainLink(req, status, ctx, hadItems, chain) {
        root.runRequest(req, function (output, exitCode) {
            // Stale callback from a superseded fetch cycle: drop the WHOLE
            // chain, not just this link -- there is no next-link recursion
            // and no pending decrement past this point.
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
                    var label0 = root.backendLabel();
                    root.toastError(label0 + " fetch failed: response too large");
                }
                ctx.pending--;
                if (ctx.pending <= 0)
                    root.finalizeFetch(ctx);
                return;
            }

            var parsed = {
                items: [],
                serverStatus: [],
                error: null
            };
            if (exitCode === 0 && output && output.trim().length > 0)
                parsed = req.parse(output);

            // ChainRunner.step() throws ONLY when called after its chain
            // already produced a terminal result -- deliberately, to
            // surface a caller bug loudly rather than silently
            // double-decrementing ctx.pending. That bug should be
            // structurally impossible here (this function calls step() once
            // per link and stops recursing once a terminal comes back), but
            // an uncaught exception in a running widget would leave
            // isLoading stuck true forever -- so catch it anyway, treat it
            // as a terminal error, and decrement exactly once like any other
            // chain error.
            var result;
            try {
                result = chain.step(parsed);
            } catch (e) {
                console.warn("DankRssWidget: ChainRunner.step() threw:", e && e.message);
                status.state = "error";
                status.lastError = "Internal chain error";
                ctx.pending--;
                if (ctx.pending <= 0)
                    root.finalizeFetch(ctx);
                return;
            }

            // Cache the session (authToken/postToken) as soon as ChainRunner
            // reports one -- on a "next" link as well as the terminal result
            // -- so a chain that dies partway through (e.g. an error on the
            // last link) still banks whatever it learned, rather than
            // forcing the next cycle to restart from ClientLogin. In memory
            // only -- see backendSession's own comment.
            if (result.session)
                root.backendSession = result.session;

            if (result.action === "next") {
                // Chain continues: ctx.pending is untouched here by design.
                root.runChainLink(result.request, status, ctx, hadItems, chain);
                return;
            }

            // action is "done" or "error" -- the chain's one terminal
            // result. Proc synthesizes exit code 124 on its own timeout,
            // which we surface separately from a generic failure.
            var verdict = ReaderState.classifyFetch(exitCode, output, result.items.length);
            status.state = verdict.state;
            status.lastError = result.error ? result.error : verdict.lastError;

            if (verdict.state === "ok") {
                status.lastSuccess = status.lastFetched;
                status.itemCount = result.items.length;
                for (var j = 0; j < result.items.length; j++)
                    ctx.collector.push(result.items[j]);

                // Server wins on fetch reconciliation: reconcile server
                // read/starred status into local readMap/bookmarkMap. This
                // is the ONLY place this runs -- never on a local action --
                // so a local push has already had a chance to reach the
                // server by the time this corrects any drift. A no-op
                // (identity) on any backend without server-side state.
                var reconciled = root.backend.reconcile({
                    readOrder: root.readOrder,
                    bookmarkOrder: root.bookmarkOrder,
                    cap: root.idHistoryCap
                }, result.serverStatus);
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
                var label = root.backendLabel();
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

        // Feeds that were not due this cycle produced no descriptor and so
        // contributed nothing to the collector. Their articles are put back
        // here, BEFORE the dedupe, so a skipped feed simply keeps what it had
        // rather than disappearing from the list -- which is the failure this
        // whole feature had to be designed around. dedupeItems then resolves
        // any overlap by stable id exactly as it does for a normal fetch.
        var collected = ctx.collector;
        if (ctx.skipped && ctx.skipped.length > 0) {
            var keep = {};
            for (var sk = 0; sk < ctx.skipped.length; sk++)
                keep[ctx.skipped[sk]] = true;
            var pool = root.digestPool && root.digestPool.length ? root.digestPool : root.allItems;
            for (var rp = 0; rp < pool.length; rp++) {
                if (keep[pool[rp].sourceUrl])
                    collected = collected.concat([pool[rp]]);
            }
        }

        var items = FeedParser.dedupeItems(collected);

        // Sorting lives in ReaderState so it can be tested: this used to be
        // three inline comparators here, and the "newest"/"oldest" ones broke
        // ties by timestamp alone. Feed items arrive in batches that share a
        // timestamp to the second, so equal-timestamp runs were free to come
        // back in a different order on every refresh -- the list quietly
        // reshuffled under the cursor. sortItems breaks ties on id.
        items = ReaderState.sortItems(items, root.sortMode, root.maxPerFeed, ReaderState.feedOrderMap(root.feeds));

        // Captured BEFORE the display cap below, which is the whole point and
        // was got wrong the first time: taking the slice afterwards made this
        // identical to allItems, so the digest still only ever saw maxItems
        // articles and the fix that was supposed to widen it did nothing.
        //
        // Also the retention pool for per-feed intervals: a feed that was not
        // due this cycle contributed nothing to the collector, and its
        // articles are recovered from here rather than vanishing.
        root.digestPool = items.slice(0, root.digestPoolCap);

        if (items.length > root.maxItems) {
            items = items.slice(0, root.maxItems);
        }

        // The digest reads from digestPool, NOT from allItems.
        //
        // allItems is capped at maxItems -- a *display* limit, typically 20 or
        // 30. Running the digest off it meant "the last 24 hours" was really
        // "the newest 30 articles", so with thirty feeds configured it silently
        // covered roughly one item per feed and looked like it was cherry
        // picking. It was not; it could not see the rest.
        //
        // Capped separately and much higher, because the constraint here is
        // the model's context rather than the widget's height, and a digest
        // over several hundred titles is still one cheap call.

        root.allItems = items;
        root.pruneSummaryCache(items);
        var prunedSnoozes = ReaderState.pruneSnoozes(root.snoozeMap, Date.now());
        if (Object.keys(prunedSnoozes).length !== Object.keys(root.snoozeMap).length) {
            root.snoozeMap = prunedSnoozes;
            root.writeState("snoozes", root.snoozeMap);
        }
        root.refreshRanking();
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

        // Rules first, and they REPLACE the plain count rather than adding to
        // it. The whole point of a rule is to be told about interesting items
        // instead of merely new ones; firing both would mean two toasts per
        // refresh, which is how a useful notification becomes one you learn to
        // dismiss without reading.
        if (!result.firstRun && root.notificationRules.length > 0) {
            var ruled = ReaderState.evaluateRules(items, root.notificationRules, root.notifiedIds);
            if (ruled.ids.length > 0) {
                root.notifiedIds = ReaderState.boundIdList(ruled.ids.concat(root.notifiedIds), root.idHistoryCap);
                root.writeState("notifiedIds", root.notifiedIds);
            }
            if (ruled.matched.length > 0 && root.notifyNewItems && typeof ToastService !== "undefined") {
                var lead = ruled.matched[0].title || "an item";
                ToastService.showInfo(ruled.matched.length === 1 ? lead : lead + " and " + (ruled.matched.length - 1) + " more match your rules");
            }
        } else if (!result.firstRun && root.notifyNewItems && result.newCount > 0 && typeof ToastService !== "undefined") {
            ToastService.showInfo(result.newCount + " new item" + (result.newCount > 1 ? "s" : "") + " in RSS Feeds");
        }

        root.seenIds = result.mergedSeen;
        root.saveSeenState();
    }

    // --- Server-backed source mode helpers ---

    function toastError(msg) {
        if (typeof ToastService !== "undefined")
            ToastService.showError(msg);
    }

    // Strips the backend-specific id prefix ("m:" for Miniflux, "r:" for
    // Google Reader) down to the raw id each backend's API expects. Returns
    // "" for anything with neither prefix: callers should already only
    // reach here with an id from the active backend, but a silent no-op on
    // a foreign-mode id is cheap insurance against read-state corruption
    // crossing between source modes. Only one source mode's items are ever
    // in allItems/selectedMap/bookmarkMap at a time, so checking the prefix
    // alone is enough -- no need to also check root.backend.id.
    function backendItemId(itemId) {
        if (typeof itemId !== "string")
            return "";
        if (itemId.indexOf("m:") === 0 || itemId.indexOf("r:") === 0)
            return itemId.slice(2);
        return "";
    }

    // Display name for a server-backed backend, used in status rows and error
    // toasts where there is no per-feed identity to show. Derived from the
    // backend's own id rather than a hardcoded string, so a new backend needs
    // no change here.
    function backendLabel() {
        var id = root.backend.id;
        return id.charAt(0).toUpperCase() + id.slice(1);
    }

    // minifluxApiCall, fetchMinifluxEntries, minifluxMarkRead,
    // minifluxMarkUnread and minifluxToggleStar are gone -- Backends.js's
    // MinifluxBackend now builds their argv/parse descriptors, and
    // runRequest/fetchAllFeeds/fetchDescriptor above run them uniformly with
    // StandardBackend's, whose equivalents are no-ops (null descriptors).

    // --- View model ---
    function applyFilter() {
        var visible = ReaderState.filterItems(root.allItems, {
            mode: root.filterMode,
            query: root.searchQuery,
            readMap: root.readMap,
            bookmarkMap: root.bookmarkMap
        });

        // Only honoured while the chip that sets it is actually on screen.
        // Otherwise switching to a backend with no categories -- or a folder
        // simply going away between refreshes -- would keep filtering against
        // something the user can no longer see or clear, and the list would
        // silently empty with no visible cause.
        if (root.categoryFilter !== "" && root.availableCategories.indexOf(root.categoryFilter) < 0)
            root.categoryFilter = "";

        if (root.categoryFilter !== "") {
            var wanted = root.categoryFilter;
            visible = visible.filter(function (it) {
                var cats = (it && it.categories) || [];
                for (var c = 0; c < cats.length; c++) {
                    if (cats[c] === wanted)
                        return true;
                }
                return false;
            });
        }

        // Snoozed sources drop out here rather than at fetch time, so their
        // items still arrive, still count as seen, and reappear intact the
        // moment the snooze lapses -- no gap in history to explain later.
        var nowMs = Date.now();
        var anySnoozed = false;
        for (var sk in root.snoozeMap) {
            if (Object.prototype.hasOwnProperty.call(root.snoozeMap, sk)) {
                anySnoozed = true;
                break;
            }
        }
        if (anySnoozed)
            visible = ReaderState.filterSnoozed(visible, root.snoozeMap, nowMs);

        // Ranking reorders what the filter chose; it never changes WHAT is
        // shown. Keeping the two separate matters: a ranking that also hid
        // things would be impossible to tell apart from a broken filter, and
        // the backlog's requirement is an obvious way back, which this gives
        // for free -- switch ranking off and the same rows are simply in
        // their old order. Items the ranking never scored keep their relative
        // position at the end rather than disappearing.
        if (root.rankingConfigured && root.rankedOrder.length > 0) {
            var rank = {};
            for (var r = 0; r < root.rankedOrder.length; r++)
                rank[root.rankedOrder[r]] = r;
            var unranked = root.rankedOrder.length;
            visible = visible.slice().sort(function (a, b) {
                var ra = (rank[a.id] === undefined) ? unranked : rank[a.id];
                var rb = (rank[b.id] === undefined) ? unranked : rank[b.id];
                if (ra !== rb)
                    return ra - rb;
                return (b.timestamp || 0) - (a.timestamp || 0);
            });
        }

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

        // Prune selection against the full dataset (root.allItems), not the
        // newly-rebuilt visible set -- selection must survive search and
        // filter-chip changes and only drop an id once it leaves the dataset
        // entirely (e.g. a refresh evicting an old item). selectedCount can
        // therefore exceed what's on screen; bulk actions already iterate
        // selectedMap rather than the visible model, so this is safe, and the
        // selection-bar label below surfaces the hidden portion explicitly.
        root.selectedMap = ReaderState.pruneSelected(root.selectedMap, root.allItems);

        root.visibleItems = visible;

        // feedModel was just rebuilt from scratch -- the cursor must never
        // point past its new end (search/filter changes can shrink the list
        // out from under it). Clamp to the new last row, or drop to -1 if
        // nothing is left.
        if (root.keyboardIndex >= feedModel.count)
            root.keyboardIndex = feedModel.count > 0 ? feedModel.count - 1 : -1;
    }

    onFilterModeChanged: root.applyFilter()

    ListModel {
        id: feedModel
    }

    // Reused by "v"/the row's view button. "e"/"s" pressed inside the window
    // are forwarded here rather than duplicated, so exporting or starring
    // from the reader behaves exactly like exporting or starring from the
    // list -- same functions, same settings, same toasts.
    ReaderWindow {
        id: readerWindow
        readerFontFamily: root.readerFontFamily
        // Bindings, not a one-time copy on open -- j/k/row-click can move
        // keyboardIndex, or filtering can resize feedModel, while the reader
        // is still open, and the position indicator/n/p must track that.
        positionIndex: root.keyboardIndex
        positionCount: feedModel.count
        onExportRequested: article => root.exportArticles([article])
        onStarRequested: itemId => root.toggleBookmark(itemId)
        onNextRequested: root.readerAdvance(1)
        onPrevRequested: root.readerAdvance(-1)
        colourPreset: root.colourPreset
        colourOverrides: ({
                customPrimary: root.pluginDataValue("customPrimary", ""),
                customError: root.pluginDataValue("customError", ""),
                customSuccess: root.pluginDataValue("customSuccess", "")
            })
        summaryAvailable: root.aiReady
        onSummaryRequested: itemId => root.requestSummary(itemId)
        onDigestRequested: root.generateDigest()
        onCopyRequested: text => root.copyToClipboard(text)

        // Closing this window cannot hand Wayland keyboard focus back to the
        // widget. forceActiveFocus() only sets Qt's own internal focus item,
        // not compositor keyboard focus -- under layer-shell OnDemand, focus
        // arrives on a click, and when a floating window closes niri hands
        // focus to a regular window, not a layer surface. There used to be a
        // forceActiveFocus() call here; it did not do anything useful, so it
        // is gone. The actual fix is "n"/"p" (readerAdvance above): moving to
        // the next/previous article without ever closing the window means
        // this focus boundary is never crossed. Closing via Esc still needs
        // a click before j/k work again, same as any other floating window
        // regaining focus.
    }

    // --- UI ---
    Rectangle {
        anchors.fill: parent
        radius: Theme.cornerRadius
        color: root.tint(root.roleColours.surfaceContainer, root.backgroundOpacity)
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

        // Grants keyboard focus on ANY click inside the widget -- clicking
        // the header, a filter chip, or empty space used to leave
        // keyboardScope unfocused, so "?" and "/" did nothing until a row
        // was clicked. A TapHandler (not a MouseArea) is used because it
        // observes clicks passing through child Items/MouseAreas rather than
        // competing with them for the event -- it fires for chip clicks, the
        // mark-all button, empty space, everything.
        //
        // MUST NOT steal focus from searchField. onTapped fires on release,
        // by which point a click that landed in searchField has already
        // granted it Qt focus on the preceding press (TextInput grabs focus
        // on press, not release) -- so checking searchField.activeFocus here
        // reliably tells us the click was search's, not a race. Skipping the
        // call in that case is what keeps typing in search from ever being
        // interrupted by this handler.
        TapHandler {
            id: focusGrantTap
            onTapped: {
                if (!searchField.activeFocus)
                    keyboardScope.forceActiveFocus();
            }
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
                        color: root.roleColours.primary
                    }

                    StyledText {
                        text: "RSS Feeds"
                        font.pixelSize: Theme.fontSizeMedium
                        font.weight: Font.Bold
                        color: root.roleColours.surfaceText
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    // Failed-feed indicator. It used to be inert: it told you
                    // something was wrong and offered no way to find out what,
                    // which for anyone who does not already know the detail
                    // lives in settings is just an anxiety light. It now names
                    // the feeds and their errors on click.
                    Rectangle {
                        visible: root.failedFeedCount > 0
                        implicitWidth: failedRow.implicitWidth + Theme.spacingXS * 2
                        implicitHeight: 20
                        radius: Theme.cornerRadius
                        color: failedArea.containsMouse ? root.tint(root.roleColours.error, 0.18) : "transparent"

                        Accessible.role: Accessible.Button
                        Accessible.name: root.failedFeedCount === 1 ? "1 feed failed, show why" : (root.failedFeedCount + " feeds failed, show why")
                        Accessible.onPressAction: root.showFeedErrors()

                        RowLayout {
                            id: failedRow
                            anchors.centerIn: parent
                            spacing: Theme.spacingXXS

                            DankIcon {
                                name: "error_outline"
                                size: 14
                                color: root.roleColours.error
                            }

                            StyledText {
                                text: root.failedFeedCount
                                font.pixelSize: root.fontSize - 2
                                color: root.roleColours.error
                            }
                        }

                        MouseArea {
                            id: failedArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.showFeedErrors()
                        }
                    }

                    DankSpinner {
                        visible: root.isLoading
                        running: root.isLoading
                        size: 14
                        color: root.roleColours.primary
                    }

                    DankActionButton {
                        // No Tab stops anywhere in this widget. Tab moves Qt
                        // focus outside keyboardScope, after which its
                        // Keys.onPressed receives nothing and j/k go dead with
                        // no way back but a click -- and DankActionButton
                        // additionally consumes Space/Return/Enter, the very
                        // keys that select and open. One cursor only: j/k
                        // moves it, "/" reaches search, Esc leaves.
                        activeFocusOnTab: false
                        visible: !root.isLoading
                        iconName: "refresh"
                        iconSize: 14
                        buttonSize: 22
                        enabled: !root.isLoading && root.activeFeedCount > 0
                        onClicked: root.refreshNow()

                        Accessible.role: Accessible.Button
                        Accessible.name: "Refresh feeds"
                        Accessible.onPressAction: root.refreshNow()
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
                    color: root.roleColours.surfaceVariantText
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    horizontalAlignment: Text.AlignHCenter
                }
            }

            // --- Separator ---
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: root.roleColours.outlineVariant
            }

            // Search toggle, shared by the actions bar and the selection bar
            // so the two copies cannot drift out of sync. Layout.* sizing
            // is set on the Loader that instantiates this, not here -- a
            // Component's root item isn't a direct RowLayout child, so
            // attached properties set inside it are ignored by the layout.
            Component {
                id: searchToggleComponent

                DankActionButton {
                    activeFocusOnTab: false
                    iconName: root.searchActive ? "search_off" : "search"
                    iconSize: 14
                    buttonSize: root.searchToggleSize
                    iconColor: (root.searchActive || root.searching) ? root.roleColours.primary : root.roleColours.surfaceVariantText
                    onClicked: root.toggleSearch()

                    Accessible.role: Accessible.Button
                    Accessible.name: root.searchActive ? "Close search" : "Search"
                    Accessible.onPressAction: root.toggleSearch()
                }
            }

            // Why ranking is not doing anything, when it is switched on and
            // is not doing anything.
            //
            // This existed as a property with six distinct messages and was
            // rendered nowhere, which is the worst of both: the code knew
            // exactly why it had declined to rank and told nobody. The
            // backlog's requirement was "a visible reason"; a reason that is
            // not visible does not meet it, and the symptom -- switching
            // ranking on and observing no change whatsoever -- is
            // indistinguishable from the feature being broken.
            StyledText {
                Layout.fillWidth: true
                visible: root.rankingEnabled && root.rankingReason !== ""
                text: root.rankingReason
                font.pixelSize: root.fontSize - 2
                color: root.roleColours.surfaceVariantText
                wrapMode: Text.WordWrap
            }

            // --- Actions bar: filter + mark all (normal mode) ---
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.spacingXS
                visible: root.allItems.length > 0 && root.selectedCount === 0

                Repeater {
                    model: [
                        {
                            key: "all",
                            label: "All"
                        },
                        {
                            key: "unread",
                            label: "Unread"
                        },
                        {
                            key: "bookmarked",
                            label: "Starred"
                        }
                    ]

                    delegate: Rectangle {
                        required property var modelData
                        readonly property bool active: root.filterMode === modelData.key

                        Layout.preferredWidth: filterLabel.implicitWidth + Theme.spacingS
                        height: 22
                        radius: Theme.cornerRadius
                        color: active ? root.tint(root.roleColours.primary, 0.18) : (filterArea.containsMouse ? root.tint(root.roleColours.primary, 0.08) : "transparent")

                        // filterLabel already gives this a name via ordinary
                        // Text -- only role/checked are needed to expose the
                        // segmented-toggle semantics.
                        Accessible.role: Accessible.Button
                        Accessible.checked: active

                        StyledText {
                            id: filterLabel
                            anchors.centerIn: parent
                            text: {
                                if (modelData.key === "unread")
                                    return "Unread (" + root.unreadCount + ")";
                                if (modelData.key === "bookmarked")
                                    return "Starred (" + root.bookmarkedCount + ")";
                                return modelData.label;
                            }
                            font.pixelSize: root.fontSize - 2
                            font.weight: parent.active ? Font.Medium : Font.Normal
                            color: parent.active ? root.roleColours.primary : root.roleColours.surfaceVariantText
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

                // One chip that cycles categories, rather than one chip per
                // category: this row has to stay readable in a widget a few
                // hundred pixels wide, and a Miniflux account with a dozen
                // folders would push everything else off the end. Hidden
                // entirely unless the backend supplies categories AND there is
                // more than nothing to choose between.
                Rectangle {
                    readonly property bool active: root.categoryFilter !== ""
                    visible: root.availableCategories.length > 0

                    Layout.preferredWidth: categoryLabel.implicitWidth + Theme.spacingS
                    height: 22
                    radius: Theme.cornerRadius
                    color: active ? root.tint(root.roleColours.primary, 0.18) : (categoryArea.containsMouse ? root.tint(root.roleColours.primary, 0.08) : "transparent")

                    Accessible.role: Accessible.Button
                    Accessible.checked: active
                    Accessible.name: root.categoryFilter === "" ? "Filter by category" : ("Category: " + root.categoryFilter + ", tap to change")
                    Accessible.onPressAction: root.cycleCategory()

                    StyledText {
                        id: categoryLabel
                        anchors.centerIn: parent
                        text: root.categoryFilter === "" ? "All folders" : root.categoryFilter
                        font.pixelSize: root.fontSize - 2
                        font.weight: parent.active ? Font.Medium : Font.Normal
                        color: parent.active ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        elide: Text.ElideRight
                        Layout.maximumWidth: 110
                    }

                    MouseArea {
                        id: categoryArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.cycleCategory()
                    }
                }

                Item {
                    Layout.fillWidth: true
                }

                // Search toggle. Search gets its own row when revealed so the
                // filter chips stay readable at narrow widget widths.
                Loader {
                    Layout.preferredWidth: root.searchToggleSize
                    Layout.preferredHeight: root.searchToggleSize
                    sourceComponent: searchToggleComponent
                }

                Rectangle {
                    id: markAllRect
                    readonly property bool allRead: root.allItems.length > 0 && root.unreadCount === 0

                    Layout.preferredWidth: allReadRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    visible: root.widgetWidth >= 160
                    height: 22
                    radius: Theme.cornerRadius
                    color: markAllArea.containsMouse ? root.tint(root.roleColours.primary, 0.15) : "transparent"

                    RowLayout {
                        id: allReadRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: markAllRect.allRead ? "remove_done" : "done_all"
                            size: 14
                            color: markAllArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }

                        // Label drops out on a narrow widget; the icon carries
                        // the action on its own.
                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: markAllRect.allRead ? "Mark all unread" : "Mark all read"
                            font.pixelSize: root.fontSize - 2
                            color: markAllArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: markAllArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.toggleAllRead(markAllRect.allRead)
                    }

                    Accessible.role: Accessible.Button
                    Accessible.name: markAllRect.allRead ? "Mark all unread" : "Mark all read"
                    Accessible.onPressAction: root.toggleAllRead(markAllRect.allRead)
                }
            }

            // --- Selection bar: replaces the row above while items are selected ---
            RowLayout {
                id: selectionActionsRow
                Layout.fillWidth: true
                spacing: Theme.spacingXS
                visible: root.selectedCount > 0

                // selectedCount can exceed what's visible (selection is
                // pruned only against allItems, not the active filter), so
                // the label must say so rather than silently undercounting.
                // Derived from root.visibleItems (the set applyFilter last
                // built) rather than re-running filterItems here, which
                // would double the scan and read root.searchQuery live --
                // racing ahead of the list during searchDebounce's 150ms
                // window.
                readonly property int hiddenSelected: root.selectedCount - ReaderState.countSelectedIn(root.selectedMap, root.visibleItems)

                StyledText {
                    text: root.selectedCount + " selected" + (selectionActionsRow.hiddenSelected > 0 ? " (" + selectionActionsRow.hiddenSelected + " hidden)" : "")
                    font.pixelSize: root.fontSize - 2
                    color: root.roleColours.surfaceVariantText
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }

                // Save (bulk bookmark) -- additive only, never un-saves.
                Rectangle {
                    Layout.preferredWidth: saveRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    height: 22
                    radius: Theme.cornerRadius
                    color: saveArea.containsMouse ? root.tint(root.roleColours.primary, 0.15) : "transparent"

                    RowLayout {
                        id: saveRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: "star"
                            size: 14
                            color: saveArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }

                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: "Save"
                            font.pixelSize: root.fontSize - 2
                            color: saveArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: saveArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.bulkSaveSelected()
                    }

                    Accessible.role: Accessible.Button
                    Accessible.name: "Star selected items"
                    Accessible.onPressAction: root.bulkSaveSelected()
                }

                // Export to notes -- only shown once a folder is configured
                // (Notes export section of settings). With nothing set there
                // must be no affordance at all, not a button that errors.
                Rectangle {
                    visible: root.exportRoot !== ""
                    Layout.preferredWidth: exportRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    height: 22
                    radius: Theme.cornerRadius
                    color: exportArea.containsMouse ? root.tint(root.roleColours.primary, 0.15) : "transparent"

                    RowLayout {
                        id: exportRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: "note_add"
                            size: 14
                            color: exportArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }

                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: "Export"
                            font.pixelSize: root.fontSize - 2
                            color: exportArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: exportArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.exportSelected()
                    }

                    Accessible.role: Accessible.Button
                    Accessible.name: "Export selected items"
                    Accessible.onPressAction: root.exportSelected()
                }

                // Mark read/unread -- flips label and action based on
                // whether every selected item is already read, same as
                // markAllRect does for the whole feed.
                Rectangle {
                    id: markReadRect

                    Layout.preferredWidth: markReadRow.implicitWidth + Theme.spacingS * 2
                    Layout.minimumWidth: 22 + Theme.spacingS * 2
                    height: 22
                    radius: Theme.cornerRadius
                    color: markReadArea.containsMouse ? root.tint(root.roleColours.primary, 0.15) : "transparent"

                    RowLayout {
                        id: markReadRow
                        anchors.centerIn: parent
                        spacing: Theme.spacingXS

                        DankIcon {
                            name: root.selectedAllRead ? "mark_email_unread" : "mark_email_read"
                            size: 14
                            color: markReadArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }

                        StyledText {
                            visible: root.widgetWidth >= 300
                            text: root.selectedAllRead ? "Mark unread" : "Mark read"
                            font.pixelSize: root.fontSize - 2
                            color: markReadArea.containsMouse ? root.roleColours.primary : root.roleColours.surfaceVariantText
                        }
                    }

                    MouseArea {
                        id: markReadArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selectedAllRead ? root.bulkMarkUnreadSelected() : root.bulkMarkReadSelected()
                    }

                    Accessible.role: Accessible.Button
                    Accessible.name: root.selectedAllRead ? "Mark selected unread" : "Mark selected read"
                    Accessible.onPressAction: root.selectedAllRead ? root.bulkMarkUnreadSelected() : root.bulkMarkReadSelected()
                }

                // The header's filter/search row is replaced by this bar
                // while items are selected, so search needs its own entry
                // point here too, sharing the header's exact behaviour via
                // searchToggleComponent.
                Loader {
                    Layout.preferredWidth: root.searchToggleSize
                    Layout.preferredHeight: root.searchToggleSize
                    sourceComponent: searchToggleComponent
                }

                // Clear selection — icon-only always (never needs a label; "X"
                // reads as "clear" without text at any width).
                DankActionButton {
                    activeFocusOnTab: false
                    iconName: "close"
                    iconSize: 14
                    buttonSize: 22
                    Layout.preferredWidth: 22
                    Layout.preferredHeight: 22
                    onClicked: root.clearSelection()

                    Accessible.role: Accessible.Button
                    Accessible.name: "Clear selection"
                    Accessible.onPressAction: root.clearSelection()
                }
            }

            // --- Search row (revealed by the header's search toggle) ---
            DankTextField {
                    activeFocusOnTab: false
                id: searchField
                Layout.fillWidth: true
                Layout.preferredHeight: 30
                visible: root.searchActive && root.allItems.length > 0
                placeholderText: "Search title, text, source"
                leftIconName: "search"
                leftIconSize: 14
                showClearButton: true
                font.pixelSize: root.fontSize

                // `text` is deliberately NOT bound to root.searchQuery:
                // `text` aliases the inner TextInput, so typing would break
                // the binding while this handler writes back to the same
                // property. The field owns the text; root.searchQuery
                // mirrors it.
                onTextChanged: {
                    if (root.searchQuery === text)
                        return;
                    root.searchQuery = text;
                    searchDebounce.restart();
                }

                onVisibleChanged: {
                    // Focus arrival is not synchronous with the click that
                    // revealed us (seat focus grant races Qt's internal
                    // focus item), so a single forceActiveFocus() can land
                    // before the surface is actually eligible. The deferred
                    // retry catches that case.
                    if (visible) {
                        forceActiveFocus();
                        Qt.callLater(forceActiveFocus);
                    }
                }

                // While this field has Qt focus, key events go to it, not to
                // keyboardScope's Keys.onPressed -- so KeyMap's Esc-while-
                // searching handling never gets the chance to run. Handle Esc
                // here instead, reusing the same closeSearch() the keyboard
                // path calls, and hand focus back so j/k work immediately
                // without another click.
                Keys.onEscapePressed: {
                    root.closeSearch();
                    keyboardScope.forceActiveFocus();
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
            // FocusScope, not a plain Item: it is the thing whose
            // activeFocus feeds acceptsKeyboardFocus above, and Keys.onPressed
            // needs an Item somewhere in the focus chain to receive events at
            // all. keyboardScope.forceActiveFocus() (row click, above) is
            // what actually puts focus here.
            FocusScope {
                id: keyboardScope
                Layout.fillWidth: true
                Layout.fillHeight: true

                Keys.onPressed: event => root.handleKeyEvent(event)

                ListView {
                    id: feedListView
                    anchors.fill: parent
                    clip: true
                    spacing: root.viewMode === "compact" ? 1 : Theme.spacingXS
                    model: feedModel
                    visible: feedModel.count > 0

                    // Mark-read-on-scroll, debounced rather than per-frame.
                    //
                    // The decision itself is ReaderState.itemsScrolledPast,
                    // which only marks on a SETTLED forward move -- and
                    // settled is this timer's job. Running it per frame would
                    // mark the whole list read on a fast fling to the bottom,
                    // which is the failure mode the module's semantics were
                    // chosen to avoid; the module can express "only when
                    // settled" but cannot enforce it, because it owns no
                    // timer.
                    onContentYChanged: {
                        if (root.markReadOnScroll)
                            scrollSettleTimer.restart();
                    }

                    Timer {
                        id: scrollSettleTimer
                        interval: 400
                        repeat: false
                        onTriggered: root.markScrolledPastRead(feedListView.indexAt(0, feedListView.contentY + 1))
                    }

                    delegate: Rectangle {
                        id: itemDelegate
                        readonly property bool isRead: root.readMap[model.itemId] === true
                        readonly property bool isBookmarked: ReaderState.isBookmarked(root.bookmarkMap, model.itemId)
                        readonly property bool isSelected: root.selectedMap[model.itemId] === true
                        // Keyboard cursor, keyed on index rather than any Qt
                        // focus state -- see acceptsKeyboardFocus's comment for
                        // why per-item activeFocus is the wrong model here.
                        readonly property bool isCursor: index === root.keyboardIndex

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
                        color: itemDelegate.isSelected ? root.tint(root.roleColours.primary, 0.12) : (rowHover.hovered ? root.tint(root.roleColours.primary, 0.08) : "transparent")
                        // Cursor indicator is a border, deliberately not another
                        // fill -- hover and selection are both background tints,
                        // and a third tint would be indistinguishable from them.
                        border.width: itemDelegate.isCursor ? 2 : 0
                        border.color: root.roleColours.primary

                        Behavior on color {
                            ColorAnimation {
                                duration: Theme.shortDuration
                            }
                        }
                        Behavior on opacity {
                            NumberAnimation {
                                duration: Theme.shortDuration
                            }
                        }

                        // Tracks hover across the WHOLE row, including the two
                        // trailing control buttons. The row MouseArea below is
                        // shrunk to exclude those buttons (so they can receive
                        // their own clicks), so its own containsMouse would go
                        // false the moment the pointer reaches a control --
                        // fading the controls out just as the user reaches for
                        // them. HoverHandler tracks hover independently of any
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
                            anchors.leftMargin: (root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS) + itemDelegate.leadingControlWidth
                            anchors.rightMargin: (root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS) + itemDelegate.controlsRowWidth
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                // A click that lands here while the niri
                                // overview is open is a stray overview-navigation
                                // click, not user intent to open/mark this item.
                                if (root._clickFromOverview())
                                    return;

                                // A click both grants keyboard focus to the list
                                // (see keyboardScope/acceptsKeyboardFocus) and
                                // moves the cursor to the row that was clicked,
                                // so j/k continue from where the mouse left off
                                // rather than jumping to the top of the list.
                                keyboardScope.forceActiveFocus();
                                root.keyboardIndex = index;

                                // Row click ALWAYS opens + marks read. Never
                                // un-reads -- that regressed link-opening once an
                                // item had been read before. None of the three
                                // controls (selection, mark-read, bookmark) ever
                                // open a link.
                                root.openItem(model.itemId, model.link);
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

                            // Leading: selection checkbox. Never opens a link,
                            // never touches read state.
                            DankActionButton {
                                iconName: itemDelegate.isSelected ? "check_box" : "check_box_outline_blank"
                                iconSize: 14
                                buttonSize: itemDelegate.controlSize
                                iconColor: itemDelegate.isSelected ? root.roleColours.primary : root.roleColours.surfaceVariantText
                                Layout.alignment: Qt.AlignVCenter
                                opacity: (rowHover.hovered || itemDelegate.isSelected) ? 1.0 : 0.45
                                enabled: true
                                // Tab must never land here -- see the
                                // activeFocusOnTab comment on the two
                                // trailing buttons below for why.
                                activeFocusOnTab: false
                                onClicked: root.rowToggleSelected(model.itemId)

                                // Checked state is a first-class AT property
                                // here, not folded into the name string --
                                // avoids a doubled "checked, Select X,
                                // checked" announcement.
                                Accessible.role: Accessible.CheckBox
                                Accessible.checked: itemDelegate.isSelected
                                Accessible.name: "Select " + (model.title || "item")
                                Accessible.onPressAction: root.rowToggleSelected(model.itemId)

                                Behavior on opacity {
                                    NumberAnimation {
                                        duration: Theme.shortDuration
                                    }
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
                                        text: model.title || ""
                                        font.pixelSize: root.fontSize
                                        font.weight: Font.Medium
                                        color: itemDelegate.isRead ? root.roleColours.surfaceVariantText : root.roleColours.primary
                                        Layout.fillWidth: true
                                        elide: Text.ElideRight
                                        maximumLineCount: 1
                                        wrapMode: Text.NoWrap
                                    }

                                    // Compact mode: inline date
                                    StyledText {
                                        visible: root.viewMode === "compact" && text !== ""
                                        // Source folded in beside the time so
                                        // the title owns the top line alone,
                                        // which is what the eye should land on.
                                        text: {
                                            root.timeTick;  // dependency: forces re-evaluation on the 60s tick
                                            var when = model.timestamp > 0 ? FeedParser.getRelativeTime(new Date(model.timestamp)) : "";
                                            var src = root.showFeedName ? (model.source || "") : "";
                                            return (when && src) ? (when + " · " + src) : (when || src);
                                        }
                                        font.pixelSize: root.fontSize - 2
                                        color: root.tint(root.roleColours.surfaceVariantText, 0.7)
                                    }
                                }

                                // Description (hidden in compact mode)
                                StyledText {
                                    visible: root.viewMode !== "compact" && (model.description || "") !== ""
                                    text: model.description || ""
                                    font.pixelSize: root.fontSize
                                    color: root.roleColours.surfaceVariantText
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
                                        var when = model.timestamp > 0 ? FeedParser.getRelativeTime(new Date(model.timestamp)) : "";
                                        var src = root.showFeedName ? (model.source || "") : "";
                                        return (when && src) ? (when + " · " + src) : (when || src);
                                    }
                                    font.pixelSize: root.fontSize - 2
                                    color: root.tint(root.roleColours.surfaceVariantText, 0.7)
                                }
                            }

                            // Thumbnail (hidden in compact mode). SECURITY:
                            // gated on FeedParser.isSafeUrl as defense in depth
                            // -- FeedParser already blanks unsafe imageUrl
                            // values at parse time, but a QML Image must never
                            // be pointed at an unvetted URL even if that first
                            // line of defense were somehow bypassed.
                            Rectangle {
                                id: thumbRect
                                visible: root.viewMode !== "compact" && root.showImages && FeedParser.isSafeUrl(model.imageUrl) && thumbImage.status !== Image.Error
                                Layout.preferredWidth: 48
                                Layout.preferredHeight: 48
                                Layout.alignment: Qt.AlignVCenter
                                radius: Theme.cornerRadius
                                color: root.roleColours.surfaceContainerHigh
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

                            // Trailing #1: mark-read toggle. Takes over the
                            // read-toggle behavior the checkbox used to have
                            // before selection was added, moved here with a
                            // distinct icon so it isn't confused with the
                            // leading selection checkbox. Always enabled, always
                            // hittable -- never disable the subtree via
                            // `enabled: <opacity expr>`, that's what broke the
                            // bookmark button before.
                            DankActionButton {
                                iconName: itemDelegate.isRead ? "mark_email_read" : "mark_email_unread"
                                iconSize: 14
                                buttonSize: itemDelegate.controlSize
                                iconColor: itemDelegate.isRead ? root.roleColours.primary : root.roleColours.surfaceVariantText
                                Layout.alignment: Qt.AlignVCenter
                                opacity: (rowHover.hovered || itemDelegate.isRead) ? 1.0 : 0.45
                                enabled: true
                                // activeFocusOnTab: false (here and on the
                                // other two row controls) is a deliberate
                                // fallback, not an oversight. DankActionButton
                                // defaults activeFocusOnTab to true and also
                                // consumes Space/Return/Enter itself
                                // (DankCommon/Widgets/DankActionButton.qml),
                                // so letting Tab land on these would create a
                                // second, DIFFERENT cursor concept from
                                // keyboardIndex/j-k -- and Tab's focus chain
                                // is not fenced by keyboardScope's FocusScope,
                                // so it can walk right out of the list into
                                // the header/filter controls. Once focus is
                                // out there, keyboardScope.Keys.onPressed
                                // receives nothing and j/k look dead with no
                                // way back in except another click. That
                                // can't be verified safe by reading alone, so
                                // rows keep exactly one cursor (keyboardIndex)
                                // and Tab simply skips over row controls
                                // entirely; they stay reachable by mouse and
                                // by their own key ("m"/"s"/Space) on the
                                // cursor row.
                                activeFocusOnTab: false
                                onClicked: root.rowToggleRead(model.itemId, itemDelegate.isRead)

                                // Names the action the press will perform
                                // (not the current state), matching the
                                // phrasing the bulk mark-read label already
                                // uses.
                                Accessible.role: Accessible.Button
                                Accessible.name: "Mark \"" + (model.title || "item") + "\" as " + (itemDelegate.isRead ? "unread" : "read")
                                Accessible.onPressAction: root.rowToggleRead(model.itemId, itemDelegate.isRead)

                                Behavior on opacity {
                                    NumberAnimation {
                                        duration: Theme.shortDuration
                                    }
                                }
                            }

                            // Bookmark toggle. `enabled` stays true always --
                            // binding it to the opacity expression disabled the
                            // whole subtree for input whenever idle, which is
                            // why it used to be unclickable without hovering
                            // first.
                            DankActionButton {
                                iconName: itemDelegate.isBookmarked ? "star" : "star_border"
                                iconSize: 14
                                buttonSize: itemDelegate.controlSize
                                iconColor: itemDelegate.isBookmarked ? root.roleColours.primary : root.roleColours.surfaceVariantText
                                Layout.alignment: Qt.AlignVCenter
                                opacity: (rowHover.hovered || itemDelegate.isBookmarked) ? 1.0 : 0.45
                                enabled: true
                                // See the mark-read button's comment above.
                                activeFocusOnTab: false
                                onClicked: root.rowToggleBookmark(model.itemId)

                                Accessible.role: Accessible.Button
                                Accessible.name: (itemDelegate.isBookmarked ? "Unstar \"" : "Star \"") + (model.title || "item") + "\""
                                Accessible.onPressAction: root.rowToggleBookmark(model.itemId)

                                Behavior on opacity {
                                    NumberAnimation {
                                        duration: Theme.shortDuration
                                    }
                                }
                            }

                            // Trailing #3: open in the reader window. Never
                            // touches read/bookmark state itself -- viewItem()
                            // does the read-marking, same as the "v" key.
                            DankActionButton {
                                iconName: "menu_book"
                                iconSize: 14
                                buttonSize: itemDelegate.controlSize
                                iconColor: root.roleColours.surfaceVariantText
                                Layout.alignment: Qt.AlignVCenter
                                opacity: rowHover.hovered ? 1.0 : 0.45
                                enabled: true
                                // See the mark-read button's comment above.
                                activeFocusOnTab: false
                                onClicked: root.rowViewItem(model.itemId, index)

                                Accessible.role: Accessible.Button
                                Accessible.name: "Open \"" + (model.title || "item") + "\" in reader"
                                Accessible.onPressAction: root.rowViewItem(model.itemId, index)

                                Behavior on opacity {
                                    NumberAnimation {
                                        duration: Theme.shortDuration
                                    }
                                }
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

                Item {
                    Layout.fillHeight: true
                }

                DankIcon {
                    name: {
                        // The widget asks the backend whether its config is
                        // usable, never which backend it is. `reason` is
                        // shared across backends ("unconfigured"/"empty"/
                        // null) but the user-facing wording differs, so
                        // capabilities.serverState picks between them below.
                        var cs = root.backend.configState(root.backendConfig);
                        if (!cs.ok)
                            return root.backend.capabilities.serverState ? "sync" : "rss_feed";
                        if (root.failedFeedCount > 0 && root.allItems.length === 0)
                            return "cloud_off";
                        if (root.allItems.length > 0 && root.searching)
                            return "search_off";
                        if (root.allItems.length > 0 && root.filterMode === "bookmarked")
                            return "star_border";
                        return root.backend.capabilities.serverState ? "sync" : "rss_feed";
                    }
                    size: Theme.iconSize * 2
                    color: root.tint(root.roleColours.surfaceVariantText, 0.4)
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: {
                        var cs = root.backend.configState(root.backendConfig);
                        if (!cs.ok) {
                            if (cs.reason === "unconfigured")
                                return root.backend.capabilities.serverState ? "Configure Miniflux in settings" : "No feeds configured";
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
                            return "No starred items";
                        if (root.allItems.length > 0 && root.filterMode === "unread")
                            return "All caught up";
                        return "No items loaded";
                    }
                    font.pixelSize: Theme.fontSizeMedium
                    color: root.roleColours.surfaceVariantText
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
                                return root.backend.capabilities.serverState ? "Enter your server URL and API token" : "Add feeds in the widget settings";
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
                    color: root.tint(root.roleColours.surfaceVariantText, 0.6)
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }

                Item {
                    Layout.fillHeight: true
                }
            }

            // --- Loading state ---
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                visible: feedModel.count === 0 && root.isLoading
                spacing: Theme.spacingS

                Item {
                    Layout.fillHeight: true
                }

                DankSpinner {
                    running: root.isLoading
                    size: 24
                    color: root.roleColours.primary
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: "Loading feeds..."
                    font.pixelSize: Theme.fontSizeMedium
                    color: root.roleColours.surfaceVariantText
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                    Layout.alignment: Qt.AlignHCenter
                }

                Item {
                    Layout.fillHeight: true
                }
            }
        }

        // --- Keyboard bindings help overlay ---
        // Discoverability only, for j/k/o/Enter/m/s/etc, none of which are
        // shown anywhere else in the UI. Toggled by KeyMap's "toggleHelp"
        // action ("?" or Shift+/); closing on plain Esc is handled directly
        // in handleKeyEvent since KeyMap's own Esc layering (search/
        // selection/cursor) knows nothing about this QML-only flag. Sits
        // on top of everything else but never takes focus -- keyboardScope
        // keeps activeFocus, so every other binding keeps working while
        // this is open.
        Rectangle {
            anchors.fill: parent
            visible: root.helpVisible
            color: root.tint(root.roleColours.surfaceContainer, 0.96)
            radius: Theme.cornerRadius
            z: 100

            MouseArea {
                // Absorbs clicks so they don't fall through to the list
                // underneath; does not take keyboard focus.
                anchors.fill: parent
                onClicked: root.helpVisible = false
            }

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacingM
                spacing: Theme.spacingS

                RowLayout {
                    Layout.fillWidth: true

                    StyledText {
                        text: "Keyboard shortcuts"
                        font.pixelSize: root.fontSize
                        font.bold: true
                        color: root.roleColours.surfaceText
                        Layout.fillWidth: true
                    }

                    DankActionButton {
                        activeFocusOnTab: false
                        iconName: "close"
                        iconSize: 14
                        buttonSize: 22
                        Layout.preferredWidth: 22
                        Layout.preferredHeight: 22
                        onClicked: root.helpVisible = false

                        Accessible.role: Accessible.Button
                        Accessible.name: "Close keyboard shortcuts"
                        Accessible.onPressAction: root.helpVisible = false
                    }
                }

                // Scrollable rather than relying on the overlay always
                // having room: a small widget height must not clip the
                // bottom rows off-screen with no way to reach them.
                Flickable {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    contentWidth: width
                    contentHeight: helpColumn.implicitHeight
                    boundsBehavior: Flickable.StopAtBounds

                    ColumnLayout {
                        id: helpColumn
                        width: parent.width
                        spacing: Theme.spacingXS

                        Repeater {
                            // The "e" row lives in root.helpBindingsModel
                            // rather than a literal here, so it can be left
                            // out entirely when no export folder is
                            // configured -- same "no affordance" rule as the
                            // selection bar's Export button.
                            model: root.helpBindingsModel

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacingXS

                                RowLayout {
                                    spacing: 2
                                    Layout.preferredWidth: 64

                                    Repeater {
                                        model: modelData.keys

                                        DankKeycap {
                                            text: modelData
                                        }
                                    }
                                }

                                StyledText {
                                    text: modelData.desc
                                    font.pixelSize: root.fontSize - 2
                                    color: root.roleColours.surfaceVariantText
                                    Layout.fillWidth: true
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
