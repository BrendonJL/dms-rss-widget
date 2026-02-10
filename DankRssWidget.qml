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

    // --- Internal state ---
    property var feedItems: []
    property bool isLoading: false
    property int pendingFetches: 0
    property var windowRef: null
    property int previousItemCount: 0
    property var readLinks: ({})  // track clicked links

    property color resolvedBorderColor: {
        switch (borderColor) {
            case "secondary": return Theme.secondary;
            case "surface": return Theme.surfaceText;
            default: return Theme.primary;
        }
    }

    // --- Lifecycle ---
    Component.onCompleted: {
        root.windowRef = Window.window ?? null;
        initialRunTimer.running = true;
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
        if (root.isRunnable()) {
            fetchAllFeeds();
            timer.restart();
        }
    }

    function handleVisibilityChange() {
        if (root.isRunnable()) {
            if (!timer.running && root.feeds.length > 0) {
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

    // --- Feed fetching ---
    function fetchAllFeeds() {
        if (!root.isRunnable()) return;
        if (root.feeds.length === 0) {
            root.feedItems = [];
            feedModel.clear();
            return;
        }

        root.isLoading = true;
        root.pendingFetches = root.feeds.length;
        var allItems = [];

        for (var i = 0; i < root.feeds.length; i++) {
            fetchFeed(i, allItems);
        }
    }

    function fetchFeed(index, collector) {
        var feed = root.feeds[index];
        var url = feed.url || "";
        var name = feed.name || url;

        if (!url) {
            root.pendingFetches--;
            if (root.pendingFetches <= 0) finalizeFetch(collector);
            return;
        }

        Proc.runCommand("rssFetch:" + index, ["curl", "-sS", "--connect-timeout", "5", "--max-time", "10", "-L", "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0", url], function(output, exitCode) {
            if (exitCode === 0 && output.trim().length > 0) {
                var items = parseFeed(output, name);
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

    function finalizeFetch(items) {
        // Sort based on sortMode
        if (root.sortMode === "oldest") {
            items.sort(function(a, b) { return a.timestamp - b.timestamp; });
        } else if (root.sortMode === "byFeed") {
            // Sort newest within each feed first, then apply per-feed cap
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
            var feedCounts = {};
            items = items.filter(function(item) {
                var src = item.source || "";
                feedCounts[src] = (feedCounts[src] || 0) + 1;
                return feedCounts[src] <= root.maxPerFeed;
            });
            // Then group by source name
            items.sort(function(a, b) {
                if (a.source < b.source) return -1;
                if (a.source > b.source) return 1;
                return b.timestamp - a.timestamp;
            });
        } else {
            // "newest" — default
            items.sort(function(a, b) { return b.timestamp - a.timestamp; });
        }

        // Limit total items
        if (items.length > root.maxItems) {
            items = items.slice(0, root.maxItems);
        }

        // Notify on new items
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
        // Auto-detect: Atom feeds contain <feed, RSS feeds contain <rss or <channel
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

            // Atom links use href attribute
            var linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
            // Prefer alternate link
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

        // Try media:thumbnail (Reddit, many feeds)
        var m = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
        if (m) { url = m[1]; }

        // Try media:content with image type
        if (!url) {
            m = block.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
            if (m) url = m[1];
        }

        // Try media:content (any, often images)
        if (!url) {
            m = block.match(/<media:content[^>]*url=["']([^"']+)["']/i);
            if (m) url = m[1];
        }

        // Try enclosure with image type
        if (!url) {
            m = block.match(/<enclosure[^>]*type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i);
            if (m) url = m[1];
        }
        if (!url) {
            m = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
            if (m) url = m[1];
        }

        // Try <img> tag in content/description
        if (!url) {
            var decoded = content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
            m = decoded.match(/<img[^>]*src=["']([^"']+)["']/i);
            if (m) url = m[1];
        }

        // Decode HTML entities in the URL itself
        if (url) {
            url = url.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
        }

        return url;
    }

    function extractTag(xml, tagName) {
        // Match both regular content and CDATA sections
        var regex = new RegExp("<" + tagName + "[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/" + tagName + ">", "i");
        var match = xml.match(regex);
        if (match) {
            return (match[1] !== undefined ? match[1] : match[2]) || "";
        }
        return "";
    }

    function cleanText(text) {
        if (!text) return "";
        // Decode common HTML entities
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
        // Collapse whitespace
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
                }

                StyledText {
                    text: root.isLoading ? "Updating..." : feedModel.count + " items"
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

                // Mark all read / unread toggle
                Rectangle {
                    property bool allRead: {
                        if (feedModel.count === 0) return false;
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
                            name: parent.parent.allRead ? "remove_done" : "done_all"
                            size: 14
                            color: markAllArea.containsMouse ? Theme.primary : Theme.surfaceVariantText
                        }

                        StyledText {
                            text: parent.parent.allRead ? "Mark all unread" : "Mark all read"
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
                            if (parent.allRead) {
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
                    property bool isRead: root.readLinks[model.link] === true

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

                            // Source + Title row
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
                                    text: "\u00b7"
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

                                // Compact mode: inline date
                                StyledText {
                                    visible: root.viewMode === "compact" && (model.relativeTime || "") !== ""
                                    text: model.relativeTime || ""
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
                                visible: root.viewMode !== "compact" && (model.relativeTime || "") !== ""
                                text: model.relativeTime || ""
                                font.pixelSize: root.fontSize - 2
                                color: Theme.withAlpha(Theme.surfaceVariantText, 0.7)
                            }
                        }

                        // Thumbnail (hidden in compact mode)
                        Rectangle {
                            id: thumbRect
                            visible: root.viewMode !== "compact" && root.showImages && (model.imageUrl || "") !== "" && thumbImage.status !== Image.Error
                            Layout.preferredWidth: 48
                            Layout.preferredHeight: 48
                            Layout.alignment: Qt.AlignVCenter
                            radius: Theme.cornerRadius
                            color: Theme.surfaceContainerHigh
                            clip: true

                            Image {
                                id: thumbImage
                                anchors.fill: parent
                                source: (root.showImages && (model.imageUrl || "") !== "") ? model.imageUrl : ""
                                fillMode: Image.PreserveAspectCrop
                                asynchronous: true
                                cache: true
                            }
                        }
                    }

                    MouseArea {
                        id: itemMouseArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
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
                                    Quickshell.execDetached(["xdg-open", model.link]);
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

                Item { Layout.fillHeight: true }

                DankIcon {
                    name: "rss_feed"
                    size: Theme.iconSize * 2
                    color: Theme.withAlpha(Theme.surfaceVariantText, 0.4)
                    Layout.alignment: Qt.AlignHCenter
                }

                StyledText {
                    text: root.feeds.length === 0 ? "No feeds configured" : "No items loaded"
                    font.pixelSize: Theme.fontSizeMedium
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    horizontalAlignment: Text.AlignHCenter
                }

                StyledText {
                    visible: root.feeds.length === 0
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
