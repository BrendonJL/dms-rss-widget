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
    // Fired by Shift+J / Shift+K. The widget owns navigation --
    // it advances its own list cursor and calls openArticle() again with the
    // new item -- because this window has no idea what list it came from or
    // what "next" even means beyond that. This is the actual fix for focus
    // getting lost when the window closes: staying inside the reader to move
    // between articles means the Wayland keyboard-focus boundary between
    // this window and the widget is never crossed in the first place.
    signal nextRequested
    signal prevRequested
    // Fired by "i" / the Summarise button. The widget owns the AI provider,
    // the bounded summary cache and the persistence tier, so this window
    // asks for a summary by id and renders whatever comes back on its
    // summary* properties -- exactly the split already used for export and
    // starring. It deliberately holds no AiProvider reference of its own.
    signal summaryRequested(string itemId)

    property string itemId: ""
    property string articleTitle: ""
    property string source: ""
    property string link: ""
    property real timestamp: 0

    // 0-based position of the open article within the widget's current
    // list, and that list's length -- bound by the widget to its own
    // keyboardIndex/feedModel.count, not copied in once and left to go
    // stale. positionCount of 0 means "no list context" (e.g. the article
    // isn't in the widget's current filter) and hides the indicator.
    property int positionIndex: -1
    property int positionCount: 0

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

    // --- AI summary (owned by the widget, displayed here) ---
    //
    // summaryAvailable gates the affordance entirely: with no runtime
    // configured, or the feature switched off, there is no button, no key
    // and no error row -- the design's hardest requirement is that an
    // unconfigured widget stays completely silent rather than advertising a
    // feature the user cannot use.
    // True when the window was opened by "i" from the list rather than by
    // "v": show the summary, and do NOT fetch the article's page. The body is
    // then something the reader asks for explicitly, because the point of
    // this mode is to decide whether the article is worth opening at all --
    // fetching it anyway would defeat the reason for the mode.
    property bool summaryOnly: false
    property bool summaryAvailable: false
    property string summaryText: ""
    property bool summaryLoading: false
    // Shown on this window and nowhere else. A failed summary never toasts:
    // a local model being unreachable is not worth interrupting someone for,
    // and on a laptop that only sometimes runs one it would fire constantly.
    property string summaryError: ""

    // Empty follows Theme.fontFamily -- this user's DMS font is a deliberate
    // choice, so the reader must default to it rather than to some other
    // "reading" font. A name that doesn't resolve just falls back to the
    // theme font, same as any other unresolvable QML font.family.
    property string readerFontFamily: ""
    readonly property string effectiveFontFamily: root.readerFontFamily !== "" ? root.readerFontFamily : Theme.fontFamily

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
    function openArticle(article, summaryOnly) {
        if (!article)
            return;

        root.summaryOnly = summaryOnly === true;

        root._article = article;
        root.itemId = article.id || "";
        root.articleTitle = article.title || "";
        root.source = article.source || "";
        root.link = article.link || "";
        root.timestamp = article.timestamp || 0;
        root.usedFallback = false;
        root.fallbackReason = "";
        // Cleared per article, then repopulated by the widget from its cache
        // if it already holds one for this id. Without this a summary would
        // linger visibly against the next article for as long as the widget
        // took to answer.
        root.summaryText = "";
        root.summaryError = "";
        root.summaryLoading = false;

        var summary = ExportProvider.articleSummaryText(article);
        // In summary-only mode the body starts empty rather than holding the
        // feed's own blurb: showing the feed summary above the AI summary is
        // two summaries of the same article stacked on each other, which
        // reads as a bug even though both are correct.
        root.body = root.summaryOnly ? "" : HtmlExtract.normalizeForReader(summary, root.articleTitle);
        root.visible = true;
        bodyFlickable.contentY = 0;

        if (root.summaryOnly) {
            root.loading = false;
            return;
        }

        if (!article.link) {
            root.loading = false;
            root.usedFallback = true;
            root.fallbackReason = "this item has no article link";
            return;
        }

        root.loadFullText();
    }

    // The fetch-and-extract half of openArticle(), split out so the "Load
    // full article" button in summary-only mode runs exactly the same path
    // rather than a second copy of it. Guarded by the same generation counter,
    // so a load started here and then superseded by opening another article
    // cannot land on the wrong one.
    function loadFullText() {
        var article = root._article;
        if (!article || !article.link || root.loading)
            return;

        root.summaryOnly = false;
        root.usedFallback = false;
        root.fallbackReason = "";

        var summary = ExportProvider.articleSummaryText(article);
        root.body = HtmlExtract.normalizeForReader(summary, root.articleTitle);
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
                    root.body = HtmlExtract.normalizeForReader(extracted.markdown, root.articleTitle);
                    return;
                }
                root.usedFallback = true;
                root.fallbackReason = extracted.reason;
            } else {
                root.usedFallback = true;
                root.fallbackReason = "could not fetch the article";
            }
            root.body = HtmlExtract.normalizeForReader(summary, root.articleTitle);
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

    // Text.MarkdownText is still the right tool for INLINE formatting inside
    // a block -- bold, italic, links, inline code -- but its own per-level
    // heading metrics don't follow lineHeight and don't move with
    // bodyFontSize, which is exactly what stage 5b's screenshot showed
    // (an h1 that scaled hard and wrapped over five lines). So every block
    // is classified here and given explicit size/weight/line-height instead
    // of letting Qt's markdown defaults choose.
    function _classifyBlock(block) {
        var text = String(block || "");
        var firstLine = text.split("\n")[0];
        if (/^\s*```/.test(text))
            return "code";
        var heading = /^(#{1,6})\s/.exec(firstLine);
        if (heading)
            return heading[1].length <= 2 ? "h2" : "h3";
        if (/^\s*>/.test(firstLine))
            return "blockquote";
        if (/^\s*(?:[-*]|\d+\.)\s/.test(firstLine))
            return "list";
        return "paragraph";
    }

    // Qt's own heading rendering inside Text.MarkdownText applies its own
    // built-in per-level size regardless of the item's own font.pixelSize --
    // that fixed scaling, not following bodyFontSize or lineHeight, is
    // exactly what the screenshot this design responds to showed. Stripping
    // the leading "#"s off a heading block before it reaches MarkdownText
    // stops that: the text is now plain, so our own font.pixelSize/weight on
    // the Text item are what decide its size, while MarkdownText still
    // parses whatever inline formatting (bold, a link) the heading contains.
    function _displayText(block, blockType) {
        var text = String(block || "");
        if (blockType === "h2" || blockType === "h3")
            return text.replace(/^#{1,6}\s+/, "");
        return text;
    }

    // Relative to bodyFontSize throughout, so the whole scale moves together
    // when the reader's font size changes -- nothing here is an absolute
    // pixel number.
    readonly property var _blockMetrics: ({
            h2: {
                size: root.bodyFontSize * 1.35,
                weight: Font.Medium,
                lineHeight: 1.3,
                italic: false,
                mono: false
            },
            h3: {
                size: root.bodyFontSize * 1.15,
                weight: Font.Medium,
                lineHeight: 1.3,
                italic: false,
                mono: false
            },
            paragraph: {
                size: root.bodyFontSize,
                weight: Font.Normal,
                lineHeight: 1.55,
                italic: false,
                mono: false
            },
            list: {
                size: root.bodyFontSize,
                weight: Font.Normal,
                lineHeight: 1.5,
                italic: false,
                mono: false
            },
            blockquote: {
                size: root.bodyFontSize,
                weight: Font.Normal,
                lineHeight: 1.5,
                italic: true,
                mono: false
            },
            code: {
                size: root.bodyFontSize * 0.9,
                weight: Font.Normal,
                lineHeight: 1.4,
                italic: false,
                mono: true
            }
        })

    FontMetrics {
        id: bodyMetrics
        font.family: root.effectiveFontFamily
        font.pixelSize: root.bodyFontSize
    }

    FocusScope {
        id: contentScope
        anchors.fill: parent
        focus: true
        activeFocusOnTab: false

        Keys.onPressed: event => {
            var shift = (event.modifiers & KeyMap.ShiftModifier) !== 0;
            switch (event.key) {
            case KeyMap.Key_Escape:
                root.dismiss();
                event.accepted = true;
                break;
            case KeyMap.Key_J:
                // Shift+J is "next article" -- j/k already mean move-by-one
                // in the list, so the shifted form carries the same muscle
                // memory over into the reader.
                if (shift)
                    root.nextRequested();
                else
                    bodyFlickable.contentY = Math.min(bodyFlickable.contentY + root.scrollStep, Math.max(0, bodyFlickable.contentHeight - bodyFlickable.height));
                event.accepted = true;
                break;
            case KeyMap.Key_K:
                if (shift)
                    root.prevRequested();
                else
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
            case KeyMap.Key_I:
                // Accepted only when the affordance exists, so "i" stays an
                // ordinary unhandled key on an unconfigured widget rather
                // than silently swallowing the keystroke.
                if (root.summaryAvailable && root.itemId && !root.summaryLoading) {
                    root.summaryRequested(root.itemId);
                    event.accepted = true;
                }
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

                StyledText {
                    text: "·"
                    visible: root.positionCount > 0 && (root.source !== "" || root.timestamp > 0)
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                // Where the open article sits in the widget's current list,
                // plus the keys that move through it without closing this
                // window -- see nextRequested/prevRequested above.
                StyledText {
                    text: (root.positionIndex + 1) + " of " + root.positionCount + "  ·  shift+j / shift+k to navigate"
                    visible: root.positionCount > 0
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                Item {
                    Layout.fillWidth: true
                }

                DankActionButton {
                    activeFocusOnTab: false
                    visible: root.summaryAvailable
                    enabled: !root.summaryLoading && root.itemId !== ""
                    iconName: root.summaryLoading ? "hourglass_top" : "auto_awesome"
                    iconSize: Theme.iconSize - 4
                    iconColor: root.summaryLoading ? Theme.surfaceVariantText : Theme.surfaceText
                    onClicked: root.summaryRequested(root.itemId)
                    // The name tracks the in-flight state because the icon
                    // does: a control that has visibly changed but reads out
                    // identically is worse than one that never changes.
                    Accessible.role: Accessible.Button
                    Accessible.name: root.summaryLoading ? "Summarising article" : "Summarise article"
                    Accessible.onPressAction: root.summaryRequested(root.itemId)
                }

                DankActionButton {
                    activeFocusOnTab: false
                    visible: windowControls.canMaximize
                    iconName: root.maximized ? "fullscreen_exit" : "fullscreen"
                    iconSize: Theme.iconSize - 4
                    iconColor: Theme.surfaceText
                    onClicked: windowControls.tryToggleMaximize()
                    Accessible.role: Accessible.Button
                    Accessible.name: root.maximized ? "Restore window" : "Maximize window"
                    Accessible.onPressAction: windowControls.tryToggleMaximize()
                }

                DankActionButton {
                    activeFocusOnTab: false
                    iconName: "close"
                    iconSize: Theme.iconSize - 4
                    iconColor: Theme.surfaceText
                    onClicked: root.dismiss()
                    Accessible.role: Accessible.Button
                    Accessible.name: "Close reader"
                    Accessible.onPressAction: root.dismiss()
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

                // The summary sits above the article, not below it: its
                // whole purpose is to help decide whether to read what
                // follows, which is no use underneath. Bounded by the same
                // measure column as the body so it reads as part of the
                // page rather than a floating panel.
                Rectangle {
                    Layout.fillWidth: true
                    visible: root.summaryLoading || root.summaryText !== "" || root.summaryError !== ""
                    implicitHeight: summaryColumn.implicitHeight + Theme.spacingM * 2
                    radius: Theme.cornerRadius
                    color: Theme.withAlpha(Theme.surfaceContainerHigh, 0.6)

                    ColumnLayout {
                        id: summaryColumn
                        x: Theme.spacingM
                        y: Theme.spacingM
                        width: parent.width - Theme.spacingM * 2
                        spacing: Theme.spacingXS

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Theme.spacingXS

                            DankIcon {
                                name: root.summaryError !== "" ? "error" : "auto_awesome"
                                size: 14
                                color: root.summaryError !== "" ? Theme.error : Theme.surfaceVariantText
                            }

                            StyledText {
                                Layout.fillWidth: true
                                text: {
                                    if (root.summaryError !== "")
                                        return "Summary failed";
                                    if (root.summaryLoading)
                                        return "Summarising…";
                                    return "Summary";
                                }
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.Medium
                                color: Theme.surfaceVariantText
                            }
                        }

                        StyledText {
                            Layout.fillWidth: true
                            visible: root.summaryError !== "" || root.summaryText !== ""
                            text: root.summaryError !== "" ? root.summaryError : root.summaryText
                            font.pixelSize: root.bodyFontSize - 2
                            font.family: root.effectiveFontFamily
                            color: root.summaryError !== "" ? Theme.error : Theme.surfaceText
                            wrapMode: Text.WordWrap
                        }
                    }
                }

                // Summary-only mode's way back to the article. Deliberately a
                // real control rather than an invisible keybinding: this mode
                // is reached from the list, so the reader arriving here has
                // not necessarily learned the reader's keys yet.
                Item {
                    Layout.fillWidth: true
                    visible: root.summaryOnly && root.link !== ""
                    implicitHeight: loadFullButton.implicitHeight + Theme.spacingM

                    DankButton {
                        id: loadFullButton
                        anchors.horizontalCenter: parent.horizontalCenter
                        y: Theme.spacingM
                        text: "Load full article"
                        iconName: "download"
                        onClicked: root.loadFullText()
                        Accessible.role: Accessible.Button
                        Accessible.name: "Load the full article text"
                        Accessible.onPressAction: root.loadFullText()
                    }
                }

                Repeater {
                    model: root._bodyBlocks

                    Text {
                        required property string modelData

                        readonly property string blockType: root._classifyBlock(modelData)
                        readonly property var metrics: root._blockMetrics[blockType]

                        Layout.fillWidth: true
                        text: root._displayText(modelData, blockType)
                        textFormat: Text.MarkdownText
                        wrapMode: Text.WordWrap
                        color: Theme.surfaceText
                        // Code is the one block that genuinely needs the
                        // monospace family regardless of what the reader
                        // font is set to -- everything else follows it.
                        font.family: metrics.mono ? Theme.monoFontFamily : root.effectiveFontFamily
                        font.pixelSize: metrics.size
                        font.weight: metrics.weight
                        font.italic: metrics.italic
                        lineHeight: metrics.lineHeight
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
