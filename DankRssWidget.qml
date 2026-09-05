import QtQuick
import QtQuick.Layouts
import QtQml
import Quickshell
import Quickshell.Io
import qs.Common
import qs.Services
import qs.Widgets
import qs.Modules.Plugins

DesktopPluginComponent {
    id: root

    // --- Standard settings from pluginData ---
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
    property int maxPerFeed: pluginData.maxPerFeed ?? 5
    property string viewMode: pluginData.viewMode ?? "expanded"  // "compact" or "expanded"
    property int fontSize: pluginData.fontSize ?? Theme.fontSizeSmall
    property bool notifyNewItems: pluginData.notifyNewItems ?? true

    // --- Miniflux settings ---
    property string sourceMode: pluginData.sourceMode ?? 'standard'
    property string minifluxUrl: (pluginData.minifluxUrl ?? '').replace(/\/$/, '')
    property string minifluxToken: pluginData.minifluxToken ?? ''
    property bool syncReadOnOpen: pluginData.syncReadOnOpen ?? true
    property bool showStarred: pluginData.showStarred ?? false
    property var entryStatusMap: ({})  // { entryId: { status, starred } }

    // --- Internal state ---
    // Unique per-instance tag: Proc is a shared singleton keyed by command id, so
    // the same id from two widget instances (e.g. one per monitor) would collide —
    // the second overwrites the first's callback and the first hangs forever.
    property string procTag: "i" + Math.floor(Math.random() * 1e9)
    property var feedItems: []
    property bool isLoading: true   // [patch:resize] start loading -> resize/recreate shows a spinner, not the empty placeholder
    property int pendingFetches: 0
    property int _fetchSeq: 0   // [patch:dedup] run token; results from a superseded fetch are dropped
    property var windowRef: null
    property int previousItemCount: 0
    property var readLinks: ({})

    // --- Computed ---
    property int unreadCount: {
        var _dep = root.entryStatusMap;
        var n = 0;
        for (var i = 0; i < feedModel.count; i++) {
            var eId = feedModel.get(i).entryId;
            if ((root.entryStatusMap[eId] ?? {}).status !== 'read') n++;
        }
        return n;
    }

    property color resolvedBorderColor: {
        switch (borderColor) {
            case "secondary": return Theme.secondary;
            case "surface": return Theme.surfaceText;
            default: return Theme.primary;
        }
    }

    // --- Manual refresh trigger from settings ---
    property var lastRefreshRequest: pluginData.lastRefreshRequest ?? 0
    onLastRefreshRequestChanged: {
        if (root.isRunnable()) fetchAllFeeds();
    }

    // --- Lifecycle ---
    Component.onCompleted: {
        root.windowRef = Window.window ?? null;
        initialRunTimer.running = true;
    }

    function isSafeUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u); }   // [patch:secure] scheme allowlist for open/Image/cache

    // In Niri's "overview" (all-workspaces preview), selecting a workspace delivers that click
    // to this background layer-shell surface; in the surface's own (unscaled) coords it can land
    // on an item -> spurious xdg-open. Ignore clicks while in overview, plus a short window after
    // it closes (the close event and the pointer delivery are async, so inOverview may already be
    // false at click time).
    property bool _overviewGuard: false
    function _clickFromOverview() { return NiriService.inOverview || root._overviewGuard; }
    Connections {
        target: NiriService
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

    onVisibleChanged: root.handleVisibilityChange()
    onWidgetWidthChanged: root.handleVisibilityChange()
    onWidgetHeightChanged: root.handleVisibilityChange()

    Component.onDestruction: {
        timer.running = false;
    }

    function isRunnable() {
        const win = root.windowRef;
        const winVisible = win === null ? true : !!win.visible;
        return root.visible && winVisible && root.widgetWidth > 0 && root.widgetHeight > 0;
    }

    onFeedsChanged: {
        if (root.isRunnable() && root.sourceMode === 'standard') {
            fetchAllFeeds();
            timer.restart();
        }
    }

    onSourceModeChanged: {
        if (root.isRunnable()) {
            feedModel.clear();
            root.entryStatusMap = ({});
            root.readLinks = ({});
            fetchAllFeeds();
            timer.restart();
        }
    }

    function handleVisibilityChange() {
        if (root.isRunnable()) {
            if (!timer.running) {
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
        interval: 150   // [patch:resize] was 1500 — re-fetch fast after a resize-triggered recreate
        repeat: false
        running: false
        onTriggered: root.handleVisibilityChange()
    }

    // --- Feed fetching: branching entry point ---
    function fetchAllFeeds() {
        if (!root.isRunnable()) return;

        if (root.sourceMode === 'miniflux') {
            fetchMinifluxEntries();
            return;
        }

        if (root.feeds.length === 0) {
            root.feedItems = [];
            feedModel.clear();
            return;
        }

        root.isLoading = true;
        var seq = ++root._fetchSeq;   // [patch:dedup] token for this run; older in-flight runs are dropped
        root.pendingFetches = root.feeds.length;
        var allItems = [];

        for (var i = 0; i < root.feeds.length; i++) {
            fetchFeed(i, allItems, seq);
        }
    }

    function fetchFeed(index, collector, seq) {
        var feed = root.feeds[index];
        var url = feed.url || "";
        var name = feed.name || url;

        if (!url) {
            if (seq === root._fetchSeq) {   // [patch:dedup] ignore stale runs
                root.pendingFetches--;
                if (root.pendingFetches <= 0) finalizeFetch(collector);
            }
            return;
        }

        // [patch:dedup] null id => a unique Proc per call. Reusing "rssFetch:"+index across
        // overlapping runs let the 2nd run mutate the shared, persistent debounce entry that the
        // 1st (already-launched) proc still referenced, so one feed's items got pushed twice.
        Proc.runCommand(null, ["curl", "-sS", "--connect-timeout", "5", "--max-time", "10", "-L", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-redirs", "5", "--max-filesize", "5000000", "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0", url], function(output, exitCode) {  // [patch:secure] http(s) only, bound redirects + size
            if (seq !== root._fetchSeq)   // [patch:dedup] a newer fetch started -> drop this stale result
                return;
            if (exitCode === 0 && output && output.trim().length > 0) {
                var body = (output.length > 5000000) ? output.slice(0, 5000000) : output;  // [patch:secure] bound XML size (ReDoS)
                var items = parseFeed(body, name);
                for (var j = 0; j < items.length; j++) {
                    collector.push(items[j]);
                }
            }

            root.pendingFetches--;
            if (root.pendingFetches <= 0) {
                finalizeFetch(collector);
            }
        });
    }

    function toastError(msg) {
        if (typeof ToastService !== "undefined") ToastService.showError(msg);
    }

    // Miniflux keeps the thumbnail in enclosures (mime image/*), not inline in
    // content; fall back to any <img> in the content only if there's no enclosure.
    function minifluxEntryImage(entry) {
        var enc = entry.enclosures || [];
        for (var k = 0; k < enc.length; k++) {
            var mt = enc[k].mime_type || "";
            if (mt.indexOf("image/") === 0 && enc[k].url) return enc[k].url;
        }
        return extractImageUrl("", entry.content || entry.summary || "");
    }

    // --- Miniflux API helper ---
    // curl --max-time must stay below the Proc timeoutMs below, otherwise DMS's
    // Proc singleton (default 10s) races curl's own limit and kills a slow-but-fine
    // request, surfacing a spurious "fetch failed" toast.
    function minifluxApiCall(method, endpoint, body, callId, callback) {
        // Config may still be settling on startup (pluginData populates async);
        // stay silent — the empty state already prompts to configure Miniflux.
        if (!root.minifluxUrl || !root.minifluxToken)
            return;
        var url = root.minifluxUrl + endpoint;
        var args = ["curl", "-sS", "--connect-timeout", "5", "--max-time", "25",
            "-X", method,
            "-H", "X-Auth-Token: " + root.minifluxToken];
        if (method !== "GET") {
            args.push("-H", "Content-Type: application/json");
            if (body) args.push("-d", body);
        }
        args.push(url);
        Proc.runCommand("miniflux:" + root.procTag + ":" + callId, args, callback, undefined, 30000);
    }

    // --- Miniflux: fetch entries ---
    function fetchMinifluxEntries() {
        // Skip quietly until config is ready; empty state prompts to configure.
        if (!root.minifluxUrl || !root.minifluxToken)
            return;
        root.isLoading = true;
        // Only nag on failure when there's nothing on screen; a transient blip
        // during a periodic refresh should keep the stale items silently.
        var hadItems = feedModel.count > 0;
        var endpoint = root.showStarred
            ? "/v1/entries?starred=true&limit=" + root.maxItems + "&order=published_at&direction=desc"
            : "/v1/entries?status=unread&limit=" + root.maxItems + "&order=published_at&direction=desc";

        minifluxApiCall("GET", endpoint, null, "fetchEntries", function(output, exitCode) {
            if (exitCode !== 0) {
                if (!hadItems) root.toastError("Miniflux fetch failed (curl exit " + exitCode + ")");
                root.isLoading = false;
                return;
            }
            var data;
            try { data = JSON.parse(output); } catch(e) {
                if (!hadItems) root.toastError("Miniflux: invalid response");
                root.isLoading = false;
                return;
            }
            if (data.error_message) {
                if (!hadItems) root.toastError("Miniflux: " + data.error_message);
                root.isLoading = false;
                return;
            }
            var entries = data.entries || [];
            var newStatusMap = {};
            var items = [];
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];
                newStatusMap[entry.id] = { status: entry.status, starred: entry.starred };
                items.push({
                    title: entry.title || "",
                    link: entry.url || "",
                    description: cleanText(stripHtml(entry.content || entry.summary || "")),
                    dateStr: entry.published_at || "",
                    timestamp: new Date(entry.published_at).getTime() || 0,
                    source: entry.feed ? entry.feed.title : "",
                    relativeTime: entry.published_at ? getRelativeTime(new Date(entry.published_at)) : "",
                    imageUrl: minifluxEntryImage(entry),
                    entryId: entry.id,
                    feedId: entry.feed_id,
                    status: entry.status,
                    starred: entry.starred
                });
            }
            root.entryStatusMap = newStatusMap;
            finalizeFetch(items);
        });
    }

    // --- Miniflux: read/unread sync ---
    function minifluxMarkRead(ids) {
        var body = JSON.stringify({ entry_ids: ids, status: "read" });
        minifluxApiCall("PUT", "/v1/entries", body, "markRead", function(output, exitCode) {
            if (exitCode !== 0) root.toastError("Failed to mark as read");
        });
    }

    function minifluxMarkUnread(ids) {
        var body = JSON.stringify({ entry_ids: ids, status: "unread" });
        minifluxApiCall("PUT", "/v1/entries", body, "markUnread", function(output, exitCode) {
            if (exitCode !== 0) root.toastError("Failed to mark as unread");
        });
    }

    function minifluxToggleStar(entryId) {
        minifluxApiCall("PUT", "/v1/entries/" + entryId + "/bookmark", null, "star:" + entryId, function(output, exitCode) {
            if (exitCode !== 0) {
                root.toastError("Failed to toggle bookmark");
                return;
            }
            var map = Object.assign({}, root.entryStatusMap);
            if (map[entryId]) {
                map[entryId] = { status: map[entryId].status, starred: !map[entryId].starred };
                root.entryStatusMap = map;
            }
        });
    }

    // --- finalizeFetch (shared) ---
    function finalizeFetch(items) {
        // [patch:dedup] de-duplicate by link (safety net against overlapping fetches or a feed repeating an item)
        var _seen = {};
        var _uniq = [];
        for (var d = 0; d < items.length; d++) {
            var _k = items[d].link || ("#" + d);
            if (!_seen[_k]) { _seen[_k] = true; _uniq.push(items[d]); }
        }
        items = _uniq;

        // Sort based on sortMode
        if (root.sortMode === "oldest") {
            items.sort(function(a, b) { return a.timestamp - b.timestamp; });
        } else if (root.sortMode === "byFeed") {
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
            var feedCounts = {};
            items = items.filter(function(item) {
                var src = item.source || "";
                feedCounts[src] = (feedCounts[src] || 0) + 1;
                return feedCounts[src] <= root.maxPerFeed;
            });
            items.sort(function(a, b) {
                if (a.source < b.source) return -1;
                if (a.source > b.source) return 1;
                return b.timestamp - a.timestamp;
            });
        } else {
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
        }

        if (items.length > root.maxItems) {
            items = items.slice(0, root.maxItems);
        }

        if (root.notifyNewItems && root.previousItemCount > 0 && items.length > root.previousItemCount) {
            var newCount = items.length - root.previousItemCount;
            if (typeof ToastService !== "undefined") {
                ToastService.showInfo(newCount + " new item" + (newCount > 1 ? "s" : "") + " in RSS Feeds");
            }
        }
        root.previousItemCount = items.length;

        root.feedItems = items;
        feedModel.clear();
        for (var i = 0; i < items.length; i++) {
            feedModel.append(items[i]);
        }
        root.isLoading = false;
    }

    // --- XML Parsing ---
    function parseFeed(xml, sourceName) {
        if (xml.indexOf("<feed") !== -1) {
            return parseAtomFeed(xml, sourceName);
        }
        return parseRssFeed(xml, sourceName);
    }

    function parseRssFeed(xml, sourceName) {
        var items = [];
        var itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
        var match;

        while ((match = itemRegex.exec(xml)) !== null) {
            var block = match[1];
            var title = extractTag(block, "title");
            var link = extractTag(block, "link");
            var description = extractTag(block, "description");
            var pubDate = extractTag(block, "pubDate");

            if (!title && !link) continue;

            items.push({
                title: cleanText(title || "Untitled"),
                link: link || "",
                description: cleanText(stripHtml(description || "")),
                dateStr: pubDate || "",
                timestamp: pubDate ? new Date(pubDate).getTime() || 0 : 0,
                source: sourceName,
                relativeTime: pubDate ? getRelativeTime(new Date(pubDate)) : "",
                imageUrl: extractImageUrl(block, description || "")
            });
        }
        return items;
    }

    function parseAtomFeed(xml, sourceName) {
        var items = [];
        var entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
        var match;

        while ((match = entryRegex.exec(xml)) !== null) {
            var block = match[1];
            var title = extractTag(block, "title");
            var summary = extractTag(block, "summary") || extractTag(block, "content");
            var updated = extractTag(block, "updated") || extractTag(block, "published");

            var linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
            var altLinkMatch = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
            var link = altLinkMatch ? altLinkMatch[1] : (linkMatch ? linkMatch[1] : "");

            if (!title && !link) continue;

            items.push({
                title: cleanText(title || "Untitled"),
                link: link,
                description: cleanText(stripHtml(summary || "")),
                dateStr: updated || "",
                timestamp: updated ? new Date(updated).getTime() || 0 : 0,
                source: sourceName,
                relativeTime: updated ? getRelativeTime(new Date(updated)) : "",
                imageUrl: extractImageUrl(block, summary || "")
            });
        }
        return items;
    }

    function extractImageUrl(block, content) {
        var url = "";

        var m = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
        if (m) { url = m[1]; }

        if (!url) {
            m = block.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
            if (m) url = m[1];
        }

        if (!url) {
            m = block.match(/<media:content[^>]*url=["']([^"']+)["']/i);
            if (m) url = m[1];
        }

        if (!url) {
            m = block.match(/<enclosure[^>]*type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i);
            if (m) url = m[1];
        }
        if (!url) {
            m = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
            if (m) url = m[1];
        }

        if (!url) {
            var decoded = content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
            m = decoded.match(/<img[^>]*src=["']([^"']+)["']/i);
            if (m) url = m[1];
        }

        if (url) {
            url = url.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
        }

        return url;
    }

    function extractTag(xml, tagName) {
        var regex = new RegExp("<" + tagName + "[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/" + tagName + ">", "i");
        var match = xml.match(regex);
        if (match) {
            return (match[1] !== undefined ? match[1] : match[2]) || "";
        }
        return "";
    }

    function cleanText(text) {
        if (!text) return "";
        text = text.replace(/&amp;/g, "&");
        text = text.replace(/&lt;/g, "<");
        text = text.replace(/&gt;/g, ">");
        text = text.replace(/&quot;/g, '"');
        text = text.replace(/&#39;/g, "'");
        text = text.replace(/&apos;/g, "'");
        text = text.replace(/&#x([0-9a-fA-F]+);/g, function(m, hex) {
            return String.fromCharCode(parseInt(hex, 16));
        });
        text = text.replace(/&#(\d+);/g, function(m, dec) {
            return String.fromCharCode(parseInt(dec, 10));
        });
        text = text.replace(/\s+/g, " ").trim();
        return text;
    }

    function stripHtml(text) {
        if (!text) return "";
        return text.replace(/<[^>]+>/g, "");
    }

    function getRelativeTime(date) {
        if (!date || isNaN(date.getTime())) return "";
        var now = new Date();
        var diff = Math.floor((now.getTime() - date.getTime()) / 1000);

        if (diff < 60) return "just now";
        if (diff < 3600) return Math.floor(diff / 60) + "m ago";
        if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
        if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
        return date.toLocaleDateString();
    }

    // --- Data model ---
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
                    spacing: Theme.spacingS

                    Item { Layout.fillWidth: true }

                    DankIcon {
                        name: "rss_feed"
                        size: Theme.iconSize
                        color: Theme.primary
                    }

                    StyledText {
                        text: "RSS Feeds"
                        font.pixelSize: Theme.fontSizeMedium
                        font.weight: Font.Bold
                        color: Theme.surfaceText
                    }

                    Item { Layout.fillWidth: true }

                    Rectangle {
                        width: 24; height: 24; radius: 12
                        color: refreshArea.containsMouse ? Theme.withAlpha(Theme.primary, 0.15) : "transparent"

                        DankIcon {
                            anchors.centerIn: parent
                            name: "refresh"
                            size: 16
                            color: root.isLoading
                                ? Theme.primary
                                : (refreshArea.containsMouse ? Theme.primary : Theme.surfaceVariantText)
                        }

                        MouseArea {
                            id: refreshArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            enabled: !root.isLoading
                            onClicked: root.fetchAllFeeds()
                        }
                    }
                }

                StyledText {
                    text: root.isLoading
                        ? "Updating..."
                        : (root.sourceMode === 'miniflux'
                            ? root.unreadCount + " unread"
                            : feedModel.count + " items")
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                }
            }

            // --- Separator ---
            Rectangle {
                Layout.fillWidth: true
                height: 1
                color: Theme.outlineVariant
            }

            // --- Actions bar ---
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.spacingXS
                visible: feedModel.count > 0

                Item { Layout.fillWidth: true }

                Rectangle {
                    id: markAllRect
                    property bool allRead: {
                        if (root.sourceMode === 'miniflux' || feedModel.count === 0) return false;
                        for (var i = 0; i < feedModel.count; i++) {
                            if (!root.readLinks[feedModel.get(i).link]) return false;
                        }
                        return true;
                    }

                    width: allReadRow.implicitWidth + Theme.spacingM * 2
                    height: 24; radius: Theme.cornerRadius
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

                        StyledText {
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
                            if (root.sourceMode === 'miniflux') {
                                var ids = [];
                                for (var i = 0; i < feedModel.count; i++) {
                                    var eId = feedModel.get(i).entryId;
                                    ids.push(eId);
                                }
                                if (ids.length > 0) {
                                    var map = Object.assign({}, root.entryStatusMap);
                                    for (var j = 0; j < ids.length; j++) {
                                        var prev = map[ids[j]] || {};
                                        map[ids[j]] = { status: 'read', starred: prev.starred || false };
                                    }
                                    root.entryStatusMap = map;
                                    root.minifluxMarkRead(ids);
                                }
                            } else {
                                if (markAllRect.allRead) {
                                    root.readLinks = ({});
                                } else {
                                    var newRead = Object.assign({}, root.readLinks);
                                    for (var i = 0; i < feedModel.count; i++) {
                                        var link = feedModel.get(i).link;
                                        if (link) newRead[link] = true;
                                    }
                                    root.readLinks = newRead;
                                }
                            }
                        }
                    }
                }
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
                    property bool isRead: root.sourceMode === 'miniflux'
                        ? (root.entryStatusMap[model.entryId] ?? {}).status === 'read'
                        : root.readLinks[model.link] === true

                    width: feedListView.width
                    height: itemColumn.implicitHeight + Theme.spacingS * 2
                    radius: root.viewMode === "compact" ? 0 : Theme.cornerRadius
                    opacity: isRead ? 0.5 : 1.0
                    color: itemMouseArea.containsMouse
                        ? Theme.withAlpha(Theme.primary, 0.08)
                        : "transparent"

                    Behavior on color {
                        ColorAnimation { duration: Theme.shortDuration }
                    }
                    Behavior on opacity {
                        NumberAnimation { duration: Theme.shortDuration }
                    }

                    RowLayout {
                        id: itemColumn
                        anchors.fill: parent
                        anchors.margins: root.viewMode === "compact" ? Theme.spacingXS : Theme.spacingS
                        spacing: Theme.spacingS

                        // Text content
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: root.viewMode === "compact" ? 0 : 2

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacingXS

                                StyledText {
                                    visible: root.showFeedName
                                    text: model.source || ""
                                    font.pixelSize: root.fontSize
                                    font.weight: Font.Medium
                                    color: isRead ? Theme.surfaceVariantText : Theme.primary
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
                                    color: isRead ? Theme.surfaceVariantText : Theme.surfaceText
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight
                                    maximumLineCount: 1
                                    wrapMode: Text.NoWrap
                                }

                                StyledText {
                                    visible: root.viewMode === "compact" && (model.relativeTime || "") !== ""
                                    text: model.relativeTime || ""
                                    font.pixelSize: root.fontSize - 2
                                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.7)
                                }
                            }

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

                            StyledText {
                                visible: root.viewMode !== "compact" && (model.relativeTime || "") !== ""
                                text: model.relativeTime || ""
                                font.pixelSize: root.fontSize - 2
                                color: Theme.withAlpha(Theme.surfaceVariantText, 0.7)
                            }
                        }

                        // Thumbnail (hidden in compact mode)
                        Rectangle {
                            id: thumbRect
                            visible: root.viewMode !== "compact" && root.showImages && root.isSafeUrl(model.imageUrl) && thumbImage.status !== Image.Error   // [patch:secure] http(s) only
                            Layout.preferredWidth: 48
                            Layout.preferredHeight: 48
                            Layout.alignment: Qt.AlignVCenter
                            radius: Theme.cornerRadius
                            color: Theme.surfaceContainerHigh
                            clip: true

                            Image {
                                id: thumbImage
                                anchors.fill: parent
                                source: (root.showImages && root.isSafeUrl(model.imageUrl)) ? model.imageUrl : ""   // [patch:secure] http(s) only
                                fillMode: Image.PreserveAspectCrop
                                asynchronous: true
                                cache: true
                            }
                        }

                        Item {
                            visible: root.sourceMode === 'miniflux'
                            Layout.preferredWidth: 28 + Theme.spacingS
                            Layout.preferredHeight: 1
                        }
                    }

                    // Click handler for the whole row
                    MouseArea {
                        id: itemMouseArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            if (root._clickFromOverview()) return;   // ignore overview-select clicks

                            if (root.sourceMode === 'miniflux') {
                                var st = root.entryStatusMap[model.entryId];
                                var currentStatus = st ? st.status : undefined;
                                var map = Object.assign({}, root.entryStatusMap);
                                var prevStarred = map[model.entryId] ? map[model.entryId].starred : false;
                                if (currentStatus === 'read') {
                                    map[model.entryId] = { status: 'unread', starred: prevStarred };
                                    root.entryStatusMap = map;
                                    root.minifluxMarkUnread([model.entryId]);
                                } else {
                                    map[model.entryId] = { status: 'read', starred: prevStarred };
                                    root.entryStatusMap = map;
                                    if (root.syncReadOnOpen) root.minifluxMarkRead([model.entryId]);
                                    if (root.openInBrowser && model.link) {
                                        if (root.isSafeUrl(model.link)) {   // [patch:secure] only open http(s) links
                                            Quickshell.execDetached(["xdg-open", model.link]);
                                        } else if (typeof ToastService !== "undefined") {
                                            ToastService.showError("Blocked a non-http(s) link");
                                        }
                                    }
                                }
                            } else {
                                if (!model.link) return;
                                var newRead = Object.assign({}, root.readLinks);

                                if (newRead[model.link]) {
                                    // Already read: toggle back to unread
                                    delete newRead[model.link];
                                    root.readLinks = newRead;
                                } else {
                                    // Unread: mark read + open link
                                    newRead[model.link] = true;
                                    root.readLinks = newRead;

                                    if (root.openInBrowser) {
                                        if (root.isSafeUrl(model.link)) {   // [patch:secure] only open http(s) links
                                            Quickshell.execDetached(["xdg-open", model.link]);
                                        } else if (typeof ToastService !== "undefined") {
                                            ToastService.showError("Blocked a non-http(s) link");
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Star button — rendered after itemMouseArea so it sits on top
                    Rectangle {
                        id: starButton
                        visible: root.sourceMode === 'miniflux'
                        width: 28; height: 28; radius: 14
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.rightMargin: Theme.spacingS
                        color: starArea.containsMouse
                            ? Theme.withAlpha(Theme.primary, 0.15)
                            : "transparent"

                        DankIcon {
                            anchors.centerIn: parent
                            name: (root.entryStatusMap[model.entryId] ?? {}).starred ? "star" : "star_border"
                            size: 16
                            color: (root.entryStatusMap[model.entryId] ?? {}).starred
                                ? Theme.primary
                                : Theme.surfaceVariantText
                        }

                        MouseArea {
                            id: starArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.minifluxToggleStar(model.entryId)
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
                    name: root.sourceMode === 'miniflux' ? "sync" : "rss_feed"
                    size: Theme.iconSize * 2
                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.4)
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: root.sourceMode === 'miniflux'
                        ? (root.minifluxUrl ? "No items found" : "Configure Miniflux in settings")
                        : (root.feeds.length === 0 ? "No feeds configured" : "No items loaded")
                    font.pixelSize: Theme.fontSizeMedium
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                }

                StyledText {
                    visible: root.sourceMode === 'standard' && root.feeds.length === 0
                    text: "Add feeds in the widget settings"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.6)
                    Layout.fillWidth: true
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
