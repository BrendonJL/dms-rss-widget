// A window that shows one article properly -- see
// docs/plans/2026-09-11-phase5-reader-app-design.md. There is no annotation
// here on purpose: highlighting happens in a real text editor, after "e"
// exports the note. This window only reads.
//
// Content comes from the exact same fetch-and-extract path the "e" export
// action uses (ExportProvider.buildArticleFetchRequest + Proc +
// HtmlExtract.extractArticle) -- not a second fetcher. Everything else here
// is typography: a capped, centred measure, larger type, real line height,
// and DMS's own theme colours.
pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import qs.Common
import qs.Services
import qs.Widgets
import "KeyMap.js" as KeyMap
import "ExportProvider.js" as ExportProvider
import "HtmlExtract.js" as HtmlExtract
import "FeedParser.js" as FeedParser

DankFloatingWindow {
    id: root

    // Fired for the two actions that touch state owned by the widget
    // (export queueing, bookmark persistence) rather than this window --
    // this window only ever displays and scrolls. The caller (the widget)
    // wires these to the exact same functions "e"/"s" already call from the
    // list, so an export or a star from in here behaves identically.
    signal exportRequested(var article)
    signal starRequested(string itemId)

    property string itemId: ""
    property string articleTitle: ""
    property string source: ""
    property string link: ""
    property real timestamp: 0

    // What's on screen right now: the feed's own summary until (if) a
    // full-text fetch replaces it. Never annotated markdown -- see the file
    // header.
    property string body: ""
    property bool loading: false
    // True once we know `body` is the summary rather than the extracted
    // article -- either extraction fell back/failed, or there was no link
    // to fetch in the first place. Drives the quiet notice, never a toast:
    // the design calls for saying so quietly, not interrupting.
    property bool usedFallback: false
    property string fallbackReason: ""

    property var _article: null
    // Guards a stale fetch callback from clobbering a newer article: opening
    // a second article while the first is still fetching must not let the
    // first one's response land after the second one's, same generation-
    // counter pattern the widget itself uses for feed fetches.
    property int _fetchGeneration: 0

    readonly property int bodyFontSize: Math.round(Theme.fontSizeLarge * 1.1)
    // The measure: 60-75 characters, converted from the body font's actual
    // average glyph width rather than a guessed pixel number, so it holds
    // at any font scale or font family the theme picks.
    readonly property real measureChars: 68
    readonly property real scrollStep: 64

    title: root.articleTitle || "Reader"
    minimumSize: Qt.size(420, 320)
    width: 700
    height: 780
    visible: false

    onClosed: root.visible = false

    function dismiss() {
        root.visible = false;
    }

    // Shared entry point: the "v" keyboard action and the row's view button
    // both call this with the same article object the list already has.
    function openArticle(article) {
        if (!article)
            return;

        root._article = article;
        root.itemId = article.id || "";
        root.articleTitle = article.title || "";
        root.source = article.source || "";
        root.link = article.link || "";
        root.timestamp = article.timestamp || 0;
        root.usedFallback = false;
        root.fallbackReason = "";

        var summary = ExportProvider.articleSummaryText(article);
        root.body = summary;
        root.visible = true;
        bodyFlickable.contentY = 0;

        if (!article.link) {
            root.loading = false;
            root.usedFallback = true;
            root.fallbackReason = "this item has no article link";
            return;
        }

        root.loading = true;
        root._fetchGeneration++;
        var generation = root._fetchGeneration;
        var req = ExportProvider.buildArticleFetchRequest(article.link);
        Proc.runCommand(null, req.argv, function (out, code) {
            // A newer openArticle() call superseded this fetch -- its own
            // result (or lack of a link at all) already owns the display.
            if (generation !== root._fetchGeneration)
                return;

            root.loading = false;
            if (code === 0 && out) {
                var extracted = HtmlExtract.extractArticle(out, {
                    summary: summary,
                    baseUrl: article.link || ""
                });
                if (!extracted.usedFallback) {
                    root.body = extracted.markdown;
                    return;
                }
                root.usedFallback = true;
                root.fallbackReason = extracted.reason;
            } else {
                root.usedFallback = true;
                root.fallbackReason = "could not fetch the article";
            }
            root.body = summary;
        }, undefined, req.timeoutMs || undefined);
    }

    function _openExternal() {
        if (!root.link)
            return;
        if (!FeedParser.isSafeUrl(root.link)) {
            if (typeof ToastService !== "undefined")
                ToastService.showWarning("Blocked unsafe link from feed", root.link);
            return;
        }
        if (!Qt.openUrlExternally(root.link) && typeof ToastService !== "undefined")
            ToastService.showError("Could not open link", root.link);
    }

    // Splits already-blank-line-separated markdown (exactly how
    // HtmlExtract.js's emitBlockChildren joins its blocks) back into blocks,
    // so each one can get its own Text item -- that's what lets paragraph
    // spacing be a Column `spacing`, independent of in-paragraph line
    // height. A blank line inside a fenced code block must not split it, so
    // fences are tracked line-by-line rather than splitting blindly on
    // "\n\n".
    function _splitBlocks(markdown) {
        if (!markdown)
            return [];
        var lines = markdown.split("\n");
        var blocks = [];
        var current = [];
        var inFence = false;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^\s*```/.test(line))
                inFence = !inFence;
            if (!inFence && line.trim() === "") {
                if (current.length > 0) {
                    blocks.push(current.join("\n"));
                    current = [];
                }
                continue;
            }
            current.push(line);
        }
        if (current.length > 0)
            blocks.push(current.join("\n"));
        return blocks;
    }

    readonly property var _bodyBlocks: root._splitBlocks(root.body)

    FontMetrics {
        id: bodyMetrics
        font.family: Theme.fontFamily
        font.pixelSize: root.bodyFontSize
    }

    FocusScope {
        id: contentScope
        anchors.fill: parent
        focus: true
        activeFocusOnTab: false

        Keys.onPressed: event => {
            switch (event.key) {
            case KeyMap.Key_Escape:
                root.dismiss();
                event.accepted = true;
                break;
            case KeyMap.Key_J:
                bodyFlickable.contentY = Math.min(bodyFlickable.contentY + root.scrollStep, Math.max(0, bodyFlickable.contentHeight - bodyFlickable.height));
                event.accepted = true;
                break;
            case KeyMap.Key_K:
                bodyFlickable.contentY = Math.max(bodyFlickable.contentY - root.scrollStep, 0);
                event.accepted = true;
                break;
            case KeyMap.Key_O:
                root._openExternal();
                event.accepted = true;
                break;
            case KeyMap.Key_E:
                if (root._article)
                    root.exportRequested(root._article);
                event.accepted = true;
                break;
            case KeyMap.Key_S:
                if (root.itemId)
                    root.starRequested(root.itemId);
                event.accepted = true;
                break;
            }
        }

        // Drags the window from its header, same as ChangelogModal's own
        // title bar.
        MouseArea {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            height: header.height
            onPressed: windowControls.tryStartMove()
            onDoubleClicked: windowControls.tryToggleMaximize()
        }

        ColumnLayout {
            id: header
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Theme.spacingM
            spacing: Theme.spacingXXS

            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.spacingXS

                StyledText {
                    text: root.source || ""
                    visible: text !== ""
                    font.pixelSize: Theme.fontSizeSmall
                    font.weight: Font.Medium
                    color: Theme.primary
                }

                StyledText {
                    text: "·"
                    visible: root.source !== "" && root.timestamp > 0
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                StyledText {
                    text: root.timestamp > 0 ? Qt.formatDateTime(new Date(root.timestamp), "MMMM d, yyyy") : ""
                    visible: text !== ""
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                Item {
                    Layout.fillWidth: true
                }

                DankActionButton {
                    activeFocusOnTab: false
                    visible: windowControls.canMaximize
                    iconName: root.maximized ? "fullscreen_exit" : "fullscreen"
                    iconSize: Theme.iconSize - 4
                    iconColor: Theme.surfaceText
                    onClicked: windowControls.tryToggleMaximize()
                }

                DankActionButton {
                    activeFocusOnTab: false
                    iconName: "close"
                    iconSize: Theme.iconSize - 4
                    iconColor: Theme.surfaceText
                    onClicked: root.dismiss()
                }
            }

            StyledText {
                text: root.articleTitle
                Layout.fillWidth: true
                font.pixelSize: Theme.fontSizeXLarge
                font.weight: Font.Bold
                color: Theme.surfaceText
                wrapMode: Text.WordWrap
            }
        }

        DankFlickable {
            id: bodyFlickable
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: header.bottom
            anchors.bottom: parent.bottom
            anchors.topMargin: Theme.spacingM
            clip: true
            contentWidth: width
            contentHeight: measureColumn.height + Theme.spacingXL * 2

            // The measure: capped at ~60-75 characters and centred, however
            // wide the window is dragged. Real margins on top of that so the
            // text never touches the flickable's own edges on a narrow
            // window.
            ColumnLayout {
                id: measureColumn
                anchors.horizontalCenter: parent.horizontalCenter
                y: Theme.spacingXL
                width: Math.max(280, Math.min(bodyMetrics.averageCharacterWidth * root.measureChars, bodyFlickable.width - Theme.spacingXL * 2))
                spacing: Theme.fontSizeLarge

                StyledText {
                    visible: root.loading
                    text: "Loading full article…"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                // Quiet, not a toast: extraction fell back to the feed
                // summary, or there was nothing to fetch at all.
                StyledText {
                    visible: !root.loading && root.usedFallback
                    text: "Showing the feed summary (" + root.fallbackReason + ")"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                    Layout.fillWidth: true
                    wrapMode: Text.WordWrap
                }

                Repeater {
                    model: root._bodyBlocks

                    Text {
                        required property string modelData

                        Layout.fillWidth: true
                        text: modelData
                        textFormat: Text.MarkdownText
                        wrapMode: Text.WordWrap
                        color: Theme.surfaceText
                        font.family: Theme.fontFamily
                        font.pixelSize: root.bodyFontSize
                        lineHeight: 1.5
                        lineHeightMode: Text.ProportionalHeight
                        onLinkActivated: link => Qt.openUrlExternally(link)
                    }
                }
            }
        }
    }

    FloatingWindowControls {
        id: windowControls
        targetWindow: root
    }
}
