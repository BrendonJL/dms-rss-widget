import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import qs.Common
import qs.Services
import qs.Widgets
import qs.Modules.Plugins
import "FeedParser.js" as FeedParser
import "ReaderState.js" as ReaderState
import "Backends.js" as Backends
import "GoogleReader.js" as GoogleReader

PluginSettings {
    id: root
    pluginId: "dankRssWidget"

    property int editingIndex: -1
    property string urlError: ""
    property var feedStatuses: []
    property var minifluxFeedsList: []

    // null Proc id + curl hardening flags on every Miniflux call made from
    // settings, matching the widget's own request pattern -- a fixed id here
    // would clobber a callback if the user mashes the button twice before
    // the first call returns.
    function fetchMinifluxFeeds() {
        var url = root.loadValue("minifluxUrl", "").replace(/\/$/, "");
        var token = root.loadValue("minifluxToken", "");
        if (!url || !token)
            return;
        Proc.runCommand(null,
            ["curl", "-sS", "--fail",
             "--connect-timeout", "5", "--max-time", "25",
             "--proto", "=http,https",
             "--proto-redir", "=http,https",
             "--max-redirs", "5",
             "--max-filesize", "5000000",
             "-H", "X-Auth-Token: " + token,
             url + "/v1/feeds"],
            function(output, exitCode) {
                if (exitCode !== 0)
                    return;
                if (output && output.length > 5000000)
                    return;
                try {
                    var data = JSON.parse(output);
                    root.minifluxFeedsList = Array.isArray(data) ? data : [];
                } catch (e) {
                    // leave the previous list in place on a bad response
                }
            }, undefined, 30000
        );
    }

    // ClientLogin succeeding only proves the server is reachable and the
    // request was well-formed -- it says nothing about whether the
    // username/password are actually valid Google Reader integration
    // credentials, since Miniflux's own ClientLogin implementation accepts
    // and rejects those independently of the /reader/api/0/* endpoints. So
    // this runs the real two-step chain: ClientLogin for an auth token, then
    // an authenticated user-info call, and only a 200 there counts as
    // success. Built from GoogleReader.js's own chain-link builder and curl
    // argv helper rather than a bare reachability ping, so a wrong password
    // fails here instead of surfacing as a silent empty feed list later.
    function testGreaderConnection(url, username, password) {
        if (!url || !username || !password) {
            if (typeof ToastService !== "undefined")
                ToastService.showError("Enter URL, username, and password first");
            return;
        }
        var config = { greaderUrl: url, greaderUsername: username, greaderPassword: password };
        var loginRequest = GoogleReader.buildClientLoginRequest(config, { linkIndex: 1, reauthAttempted: false }, FeedParser);
        if (!loginRequest) {
            if (typeof ToastService !== "undefined")
                ToastService.showError("Connection failed: could not build request");
            return;
        }
        Proc.runCommand(null, loginRequest.argv,
            function(output, exitCode) {
                var loginResult = loginRequest.parse(output || "");
                if (!loginResult || loginResult.error || !loginResult.session || !loginResult.session.authToken) {
                    // Never include the URL/password in this message -- describe
                    // the failure only (same rule as the Miniflux button above).
                    if (typeof ToastService !== "undefined")
                        ToastService.showError("Connection failed: check the Google Reader integration username and password (Miniflux Settings → Integrations, not your web login)");
                    return;
                }
                var userInfoArgv = GoogleReader.greaderCurlArgv("GET", url, "/reader/api/0/user-info", loginResult.session.authToken, null);
                Proc.runCommand(null, userInfoArgv,
                    function(userInfoOutput, userInfoExitCode) {
                        var split = GoogleReader.splitHttpStatus(userInfoOutput || "");
                        if (split.status === 200) {
                            if (typeof ToastService !== "undefined")
                                ToastService.showInfo("Google Reader connection successful!");
                        } else {
                            if (typeof ToastService !== "undefined")
                                ToastService.showError("Connection failed: server rejected the authenticated request");
                        }
                    }, undefined, 30000
                );
            }, undefined, 30000
        );
    }

    // The injected pluginService is NOT always the real PluginService: a
    // desktop-widget instance gets a reduced shim with no load/savePluginState.
    // Feature-detect and fall back rather than throwing (which would abort this
    // handler and leave the settings page half-initialised).
    readonly property var stateService: ReaderState.resolveStateService(
        typeof PluginService !== "undefined" ? PluginService : null,
        root.pluginService)

    // Asked, never string-matched, for every question that is really about
    // backend behaviour rather than which backend is selected -- see the
    // sourceModeSetting.value comparisons below. sourceMode is persisted, so
    // a stored mode from a build that predates a given backend (e.g. a user
    // who downgrades past "greader") must not bind this to undefined.
    readonly property var backends: Backends.createBackends({
        FeedParser: FeedParser, ReaderState: ReaderState, GoogleReader: GoogleReader
    })
    readonly property var currentBackend: backends[sourceModeSetting.value] || backends.standard

    function refreshFeedStatuses() {
        if (!root.stateService || !root.pluginId) {
            feedStatuses = [];
            return;
        }
        try {
            feedStatuses = root.stateService.loadPluginState(root.pluginId, "feedStatus", []) || [];
        } catch (e) {
            console.warn("DankRssWidget settings: could not read feed status", e);
            feedStatuses = [];
        }
    }

    function statusForUrl(url) {
        var list = root.feedStatuses || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].url === url) {
                return list[i];
            }
        }
        return null;
    }

    function validateFeedUrl(rawUrl) {
        var url = (rawUrl || "").trim();
        if (!url) {
            return { ok: false, error: "Feed URL is required", url: "" };
        }
        if (!/^https?:\/\//i.test(url)) {
            url = "https://" + url;
        }
        var looksValid = /^https?:\/\/[^\s]+\.[^\s]+/i.test(url) || /^https?:\/\/localhost(:\d+)?/i.test(url);
        if (!looksValid) {
            return { ok: false, error: "Enter a valid URL (starting with http:// or https://)", url: "" };
        }
        return { ok: true, error: "", url: url };
    }

    Component.onCompleted: {
        root.refreshFeedStatuses();
        if (root.loadValue("sourceMode", "standard") === "miniflux")
            root.fetchMinifluxFeeds();
    }
    onVisibleChanged: {
        if (root.visible) {
            root.refreshFeedStatuses();
        }
    }


    // The status list is a SNAPSHOT read from the state tier, and the widget
    // writes that tier from a different component whenever a fetch finalises.
    // Refreshing only on open meant a feed added while this panel was already
    // open kept reading "Not fetched yet" forever, even after the widget had
    // fetched it and recorded a real error -- the status row existed on disk,
    // this copy just never re-read it.
    //
    // Polling rather than reacting because the state tier offers no change
    // notification. Cheap: one small JSON read, and only while visible.
    Timer {
        id: statusPoll
        interval: 3000
        repeat: true
        running: root.visible
        onTriggered: root.refreshFeedStatuses()
    }

    // --- Header ---
    StyledText {
        width: parent.width
        text: "RSS Widget Settings"
        font.pixelSize: Theme.fontSizeLarge
        font.weight: Font.Bold
        color: Theme.surfaceText
    }

    StyledText {
        width: parent.width
        text: "Display RSS/Atom feeds directly, or sync with a Miniflux server."
        font.pixelSize: Theme.fontSizeMedium
        color: Theme.surfaceVariantText
        wrapMode: Text.WordWrap
    }

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
    }

    // ─── Source Mode ───

    StyledText {
        width: parent.width
        text: "Source Mode"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
    }

    SelectionSetting {
        id: sourceModeSetting
        settingKey: "sourceMode"
        label: "Source Mode"
        description: "Standard fetches RSS/Atom feeds directly. Miniflux and Google Reader sync with a server."
        options: [
            { label: "Standard", value: "standard" },
            { label: "Miniflux", value: "miniflux" },
            { label: "Google Reader", value: "greader" }
        ]
        defaultValue: "standard"
    }

    // ─── Miniflux Connection (miniflux mode only) ───

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
        visible: sourceModeSetting.value === "miniflux"
    }

    StyledText {
        width: parent.width
        text: "Miniflux Connection"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
        visible: sourceModeSetting.value === "miniflux"
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        visible: sourceModeSetting.value === "miniflux"

        StyledText {
            text: "Server URL"
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
        }

        DankTextField {
            id: minifluxUrlField
            width: parent.width
            placeholderText: "https://miniflux.example.com"
            text: root.loadValue("minifluxUrl", "")
            onTextChanged: root.saveValue("minifluxUrl", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(minifluxUrlField);
            }
        }
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        visible: sourceModeSetting.value === "miniflux"

        StyledText {
            text: "API Token"
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
        }

        // The token is never logged and never appears in a toast -- it is
        // only ever read back into a curl -H argv element.
        DankTextField {
            id: minifluxTokenField
            width: parent.width
            placeholderText: "Your Miniflux API token"
            text: root.loadValue("minifluxToken", "")
            onTextChanged: root.saveValue("minifluxToken", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(minifluxTokenField);
            }
        }
    }

    ToggleSetting {
        visible: sourceModeSetting.value === "miniflux"
        settingKey: "syncReadOnOpen"
        label: "Mark as read on open"
        description: "Mark entries as read on the server when you open them"
        defaultValue: true
    }

    ToggleSetting {
        visible: sourceModeSetting.value === "miniflux"
        settingKey: "showStarred"
        label: "Show starred entries"
        description: "Show only starred/bookmarked entries instead of unread entries"
        defaultValue: false
    }

    Row {
        visible: sourceModeSetting.value === "miniflux"
        spacing: Theme.spacingM

        DankButton {
            text: "Test Connection"
            iconName: "wifi_tethering"
            onClicked: {
                var url = minifluxUrlField.text.trim().replace(/\/$/, "");
                var token = minifluxTokenField.text.trim();
                if (!url || !token) {
                    if (typeof ToastService !== "undefined")
                        ToastService.showError("Enter URL and token first");
                    return;
                }
                Proc.runCommand(null,
                    ["curl", "-sS", "--fail",
                     "--connect-timeout", "5", "--max-time", "25",
                     "--proto", "=http,https",
                     "--proto-redir", "=http,https",
                     "--max-redirs", "5",
                     "--max-filesize", "5000000",
                     "-H", "X-Auth-Token: " + token,
                     url + "/v1/me"],
                    function(output, exitCode) {
                        if (exitCode === 0 && output && output.indexOf('"id"') !== -1) {
                            if (typeof ToastService !== "undefined")
                                ToastService.showInfo("Miniflux connection successful!");
                            root.fetchMinifluxFeeds();
                        } else {
                            // Never include the URL/token in this message --
                            // describe the failure only (same rule as above).
                            if (typeof ToastService !== "undefined")
                                ToastService.showError("Connection failed: check URL and token");
                        }
                    }, undefined, 30000
                );
            }
        }

        DankButton {
            text: "Force Refresh"
            iconName: "refresh"
            onClicked: root.saveValue("lastRefreshRequest", Date.now())
        }
    }

    // ─── Google Reader Connection (greader mode only) ───
    // Kept keyed on the mode string rather than a capability, deliberately:
    // a credential form is inherently backend-specific (Miniflux takes a
    // token, Google Reader takes a username and password), so there is
    // nothing generic to ask a capability flag here.

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
        visible: sourceModeSetting.value === "greader"
    }

    StyledText {
        width: parent.width
        text: "Google Reader Connection"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
        visible: sourceModeSetting.value === "greader"
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        visible: sourceModeSetting.value === "greader"

        StyledText {
            text: "Server URL"
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
        }

        DankTextField {
            id: greaderUrlField
            width: parent.width
            placeholderText: "https://miniflux.example.com"
            text: root.loadValue("greaderUrl", "")
            onTextChanged: root.saveValue("greaderUrl", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(greaderUrlField);
            }
        }
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        visible: sourceModeSetting.value === "greader"

        StyledText {
            text: "Username"
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
        }

        // On Miniflux this is NOT the web login: Google Reader integration
        // credentials are a separate username/password set under
        // Settings -> Integrations. Entering the web username here gets a
        // bare 401 from ClientLogin with nothing to explain why.
        StyledText {
            width: parent.width
            text: "Separate from your web login -- set under Settings → Integrations on Miniflux."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: Theme.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: greaderUsernameField
            width: parent.width
            placeholderText: "Google Reader integration username"
            text: root.loadValue("greaderUsername", "")
            onTextChanged: root.saveValue("greaderUsername", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(greaderUsernameField);
            }
        }
    }

    Column {
        width: parent.width
        spacing: Theme.spacingXS
        visible: sourceModeSetting.value === "greader"

        StyledText {
            text: "Password"
            font.pixelSize: Theme.fontSizeSmall
            color: Theme.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Also separate from your web password -- same Settings → Integrations page on Miniflux."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: Theme.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        // Never logged and never appears in a toast -- it is only ever read
        // back into a curl --data-urlencode argv element (see
        // testGreaderConnection below), matching the token's own handling.
        DankTextField {
            id: greaderPasswordField
            width: parent.width
            placeholderText: "Google Reader integration password"
            text: root.loadValue("greaderPassword", "")
            onTextChanged: root.saveValue("greaderPassword", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(greaderPasswordField);
            }
        }
    }

    Row {
        visible: sourceModeSetting.value === "greader"
        spacing: Theme.spacingM

        DankButton {
            text: "Test Connection"
            iconName: "wifi_tethering"
            onClicked: root.testGreaderConnection(
                greaderUrlField.text.trim().replace(/\/$/, ""),
                greaderUsernameField.text.trim(),
                greaderPasswordField.text.trim()
            )
        }
    }

    // ─── Subscription List (read-only) ───
    // Shown for any backend that keeps subscriptions on the server rather
    // than in this plugin's own settings -- there is nothing local to add,
    // edit, or reorder, only a snapshot of what the server already has.
    // The list itself is still populated only by fetchMinifluxFeeds()
    // (Miniflux's /v1/feeds); Google Reader shows this section empty until
    // it gets its own feed-listing call.

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
        visible: currentBackend.capabilities.serverState
    }

    StyledText {
        width: parent.width
        text: "Subscription List"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
        visible: currentBackend.capabilities.serverState
    }

    StyledRect {
        width: parent.width
        height: Math.max(80, minifluxFeedsColumn.implicitHeight + Theme.spacingL * 2)
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh
        visible: currentBackend.capabilities.serverState

        Column {
            id: minifluxFeedsColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingS

            Repeater {
                model: root.minifluxFeedsList

                delegate: RowLayout {
                    required property var modelData
                    width: minifluxFeedsColumn.width
                    spacing: Theme.spacingS

                    DankIcon {
                        name: "rss_feed"
                        size: 14
                        color: Theme.primary
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 1

                        StyledText {
                            text: modelData.title || ""
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.Medium
                            color: Theme.surfaceText
                            Layout.fillWidth: true
                            elide: Text.ElideRight
                        }

                        StyledText {
                            text: modelData.feed_url || modelData.site_url || ""
                            font.pixelSize: Theme.fontSizeSmall - 2
                            color: Theme.surfaceVariantText
                            Layout.fillWidth: true
                            elide: Text.ElideMiddle
                        }
                    }
                }
            }

            StyledText {
                text: root.minifluxFeedsList.length === 0
                    ? "No feeds loaded — test connection first"
                    : ""
                visible: root.minifluxFeedsList.length === 0
                font.pixelSize: Theme.fontSizeSmall
                color: Theme.surfaceVariantText
                width: parent.width
            }
        }
    }

    // ─── Refresh Settings (always visible) ───

    StyledText {
        width: parent.width
        text: "Refresh Settings"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
    }

    SliderSetting {
        settingKey: "updateInterval"
        label: "Refresh Interval"
        description: "How often feeds are fetched (in minutes)"
        defaultValue: 30
        minimum: 5
        maximum: 1440
        unit: "min"
        // Note: stored as minutes in settings, converted to seconds in widget
    }

    SliderSetting {
        settingKey: "maxItems"
        label: "Maximum Items"
        description: "Maximum number of feed items to display"
        defaultValue: 20
        minimum: 5
        maximum: 50
        unit: ""
    }

    SelectionSetting {
        id: sortModeSetting
        settingKey: "sortMode"
        label: "Sort Order"
        description: "How feed items are ordered in the widget"
        options: [
            { label: "Newest First", value: "newest" },
            { label: "Oldest First", value: "oldest" },
            { label: "Group by Feed", value: "byFeed" }
        ]
        defaultValue: "newest"
    }

    SliderSetting {
        visible: sortModeSetting.value === "byFeed"
        settingKey: "maxPerFeed"
        label: "Items per Feed"
        description: "Maximum items shown from each feed when grouping"
        defaultValue: 5
        minimum: 1
        maximum: 20
        unit: ""
    }

    SelectionSetting {
        settingKey: "viewMode"
        label: "View Mode"
        description: "Compact shows title-only rows; Expanded shows descriptions and thumbnails"
        options: [
            { label: "Expanded", value: "expanded" },
            { label: "Compact", value: "compact" }
        ]
        defaultValue: "expanded"
    }

    ToggleSetting {
        settingKey: "notifyNewItems"
        label: "New Item Notifications"
        description: "Show a toast notification when new items appear after a refresh"
        defaultValue: true
    }

    ToggleSetting {
        settingKey: "showFeedName"
        label: "Show Feed Source"
        description: "Display the feed name next to each item title"
        defaultValue: true
    }

    ToggleSetting {
        settingKey: "showImages"
        label: "Show Thumbnails"
        description: "Display thumbnail images when available in feed items"
        defaultValue: true
    }

    ToggleSetting {
        settingKey: "openInBrowser"
        label: "Open Links in Browser"
        description: "Click feed items to open them in your browser"
        defaultValue: true
    }

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
        visible: !currentBackend.capabilities.serverState
    }

    // ─── Feed Management ───
    // Only meaningful for a backend with no server-side subscription list of
    // its own -- adding, editing, and reordering feeds here is exactly what
    // a serverState backend's own subscription management already covers.

    StyledText {
        width: parent.width
        text: "Feed Management"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
        visible: !currentBackend.capabilities.serverState
    }

    StyledRect {
        width: parent.width
        height: addFeedColumn.implicitHeight + Theme.spacingL * 2
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh
        visible: !currentBackend.capabilities.serverState

        Column {
            id: addFeedColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingM

            StyledText {
                text: root.editingIndex === -1 ? "Add Feed" : "Edit Feed"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: Theme.surfaceText
            }

            Column {
                width: parent.width
                spacing: Theme.spacingXS

                StyledText {
                    text: "Feed Name"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                DankTextField {
                    id: nameField
                    width: parent.width
                    placeholderText: "e.g., Hacker News"
                    onFocusStateChanged: hasFocus => {
                        if (hasFocus) root.ensureItemVisible(nameField);
                    }
                }
            }

            Column {
                width: parent.width
                spacing: Theme.spacingXS

                StyledText {
                    text: "Feed URL *"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                }

                DankTextField {
                    id: urlField
                    width: parent.width
                    placeholderText: "e.g., https://hnrss.org/newest"
                    onFocusStateChanged: hasFocus => {
                        if (hasFocus) root.ensureItemVisible(urlField);
                    }
                    onTextChanged: root.urlError = ""
                }

                StyledText {
                    visible: root.urlError !== ""
                    width: parent.width
                    text: root.urlError
                    font.pixelSize: Theme.fontSizeSmall - 2
                    color: Theme.error
                    wrapMode: Text.WordWrap
                }
            }

            Row {
                spacing: Theme.spacingM

                DankButton {
                    text: root.editingIndex === -1 ? "Add Feed" : "Update Feed"
                    iconName: root.editingIndex === -1 ? "add" : "save"

                    onClicked: {
                        var validated = root.validateFeedUrl(urlField.text);
                        if (!validated.ok) {
                            root.urlError = validated.error;
                            return;
                        }
                        root.urlError = "";

                        var url = validated.url;
                        var name = nameField.text.trim() || url;

                        var currentFeeds = root.loadValue("feeds", []);
                        if (root.editingIndex === -1) {
                            currentFeeds = currentFeeds.concat([{ name: name, url: url, enabled: true, addedAt: Date.now() }]);
                        } else {
                            var existing = currentFeeds[root.editingIndex] || {};
                            currentFeeds[root.editingIndex] = {
                                name: name,
                                url: url,
                                enabled: existing.enabled !== false,
                                addedAt: existing.addedAt
                            };
                            root.editingIndex = -1;
                        }
                        root.saveValue("feeds", currentFeeds);

                        nameField.text = "";
                        urlField.text = "";
                    }
                }

                DankButton {
                    text: "Cancel"
                    iconName: "close"
                    visible: root.editingIndex !== -1
                    onClicked: {
                        root.editingIndex = -1;
                        root.urlError = "";
                        nameField.text = "";
                        urlField.text = "";
                    }
                }
            }
        }
    }

    StyledRect {
        width: parent.width
        height: Math.max(120, feedsListColumn.implicitHeight + Theme.spacingL * 2)
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh
        visible: !currentBackend.capabilities.serverState

        Column {
            id: feedsListColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingM

            StyledText {
                text: "Configured Feeds"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: Theme.surfaceText
            }

            ListView {
                id: feedsListView
                width: parent.width
                height: Math.max(60, contentHeight)
                clip: true
                spacing: Theme.spacingXS
                model: root.loadValue("feeds", [])

                delegate: StyledRect {
                    required property var modelData
                    required property int index

                    width: feedsListView.width
                    height: feedInfoRow.implicitHeight + Theme.spacingM * 2
                    radius: Theme.cornerRadius
                    color: feedItemMouse.containsMouse ? Theme.surfaceContainerHighest : Theme.surfaceContainer
                    opacity: modelData.enabled === false ? 0.55 : 1.0

                    RowLayout {
                        id: feedInfoRow
                        anchors.fill: parent
                        anchors.margins: Theme.spacingM
                        spacing: Theme.spacingM

                        DankIcon {
                            name: "rss_feed"
                            size: 16
                            color: Theme.primary
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2

                            StyledText {
                                text: modelData.name || ""
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.Medium
                                color: modelData.enabled === false ? Theme.surfaceVariantText : Theme.surfaceText
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                            }

                            StyledText {
                                text: modelData.url || ""
                                font.pixelSize: Theme.fontSizeSmall - 2
                                color: Theme.surfaceVariantText
                                Layout.fillWidth: true
                                elide: Text.ElideMiddle
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Theme.spacingXS

                                property var feedStatus: root.statusForUrl(modelData.url)

                                DankIcon {
                                    visible: parent.feedStatus !== null && parent.feedStatus.state === "ok"
                                    name: "check_circle"
                                    size: 12
                                    color: Theme.success
                                }

                                DankIcon {
                                    visible: parent.feedStatus !== null && (parent.feedStatus.state === "error" || parent.feedStatus.state === "timeout")
                                    name: "error"
                                    size: 12
                                    color: Theme.error
                                }

                                StyledText {
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight
                                    font.pixelSize: Theme.fontSizeSmall - 2
                                    text: {
                                        var st = root.statusForUrl(modelData.url);
                                        if (modelData.enabled === false) return "Disabled";
                                        if (!st) return "Not fetched yet";
                                        if (st.state === "ok") return (st.itemCount || 0) + " items";
                                        if (st.state === "error" || st.state === "timeout") return st.lastError || "Fetch failed";
                                        if (st.state === "disabled") return "Disabled";
                                        return "Not fetched yet";
                                    }
                                    color: {
                                        var st = root.statusForUrl(modelData.url);
                                        if (modelData.enabled === false) return Theme.surfaceVariantText;
                                        if (st && (st.state === "error" || st.state === "timeout")) return Theme.error;
                                        if (st && st.state === "ok") return Theme.success;
                                        return Theme.surfaceVariantText;
                                    }
                                }
                            }
                        }

                        DankToggle {
                            checked: modelData.enabled !== false
                            onToggled: isChecked => {
                                var currentFeeds = root.loadValue("feeds", []);
                                if (index >= 0 && index < currentFeeds.length) {
                                    currentFeeds[index].enabled = isChecked;
                                    root.saveValue("feeds", currentFeeds);
                                }
                            }
                        }

                        Rectangle {
                            id: moveUpButton
                            width: 32; height: 32; radius: 16
                            enabled: index > 0
                            opacity: enabled ? 1.0 : 0.35
                            color: enabled && moveUpArea.containsMouse ? Theme.primary : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "arrow_upward"
                                size: 16
                                color: moveUpButton.enabled && moveUpArea.containsMouse ? Theme.onPrimary : Theme.surfaceVariantText
                            }

                            MouseArea {
                                id: moveUpArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    var currentFeeds = root.loadValue("feeds", []);
                                    if (index > 0 && index < currentFeeds.length) {
                                        var t = currentFeeds[index - 1];
                                        currentFeeds[index - 1] = currentFeeds[index];
                                        currentFeeds[index] = t;
                                        root.editingIndex = -1;
                                        root.urlError = "";
                                        nameField.text = "";
                                        urlField.text = "";
                                        root.saveValue("feeds", currentFeeds);
                                    }
                                }
                            }
                        }

                        Rectangle {
                            id: moveDownButton
                            width: 32; height: 32; radius: 16
                            enabled: index < feedsListView.count - 1
                            opacity: enabled ? 1.0 : 0.35
                            color: enabled && moveDownArea.containsMouse ? Theme.primary : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "arrow_downward"
                                size: 16
                                color: moveDownButton.enabled && moveDownArea.containsMouse ? Theme.onPrimary : Theme.surfaceVariantText
                            }

                            MouseArea {
                                id: moveDownArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    var currentFeeds = root.loadValue("feeds", []);
                                    if (index >= 0 && index < currentFeeds.length - 1) {
                                        var t = currentFeeds[index + 1];
                                        currentFeeds[index + 1] = currentFeeds[index];
                                        currentFeeds[index] = t;
                                        root.editingIndex = -1;
                                        root.urlError = "";
                                        nameField.text = "";
                                        urlField.text = "";
                                        root.saveValue("feeds", currentFeeds);
                                    }
                                }
                            }
                        }

                        Rectangle {
                            width: 32; height: 32; radius: 16
                            color: editArea.containsMouse ? Theme.primary : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "edit"
                                size: 16
                                color: editArea.containsMouse ? Theme.onPrimary : Theme.surfaceVariantText
                            }

                            MouseArea {
                                id: editArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    root.editingIndex = index;
                                    root.urlError = "";
                                    var feed = root.loadValue("feeds", [])[index];
                                    nameField.text = feed.name || "";
                                    urlField.text = feed.url || "";
                                    root.ensureItemVisible(nameField);
                                }
                            }
                        }

                        Rectangle {
                            width: 32; height: 32; radius: 16
                            color: deleteArea.containsMouse ? Theme.error : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "delete"
                                size: 16
                                color: deleteArea.containsMouse ? Theme.onError : Theme.surfaceVariantText
                            }

                            MouseArea {
                                id: deleteArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    var currentFeeds = root.loadValue("feeds", []);
                                    currentFeeds = currentFeeds.filter(function(_, i) { return i !== index; });
                                    root.saveValue("feeds", currentFeeds);
                                    if (root.editingIndex === index) {
                                        root.editingIndex = -1;
                                        nameField.text = "";
                                        urlField.text = "";
                                    } else if (root.editingIndex > index) {
                                        root.editingIndex--;
                                    }
                                }
                            }
                        }
                    }

                    MouseArea {
                        id: feedItemMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        propagateComposedEvents: true
                        onClicked: function(mouse) { mouse.accepted = false; }
                        onPressed: function(mouse) { mouse.accepted = false; }
                        onReleased: function(mouse) { mouse.accepted = false; }
                    }
                }

                StyledText {
                    anchors.centerIn: parent
                    text: "No feeds configured yet"
                    font.pixelSize: Theme.fontSizeSmall
                    color: Theme.surfaceVariantText
                    visible: feedsListView.count === 0
                }
            }
        }
    }

    // OPML Import: feeds live locally only when the backend has no server
    // subscription list of its own to import into instead.
    StyledRect {
        width: parent.width
        height: opmlColumn.implicitHeight + Theme.spacingL * 2
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh
        visible: !currentBackend.capabilities.serverState

        Column {
            id: opmlColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingM

            StyledText {
                text: "Import from OPML"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: Theme.surfaceText
            }

            StyledText {
                width: parent.width
                text: "Paste OPML/XML content to import feeds from other RSS readers"
                font.pixelSize: Theme.fontSizeSmall
                color: Theme.surfaceVariantText
                wrapMode: Text.WordWrap
            }

            DankTextField {
                id: opmlField
                width: parent.width
                placeholderText: "Paste OPML XML here..."
                onFocusStateChanged: hasFocus => {
                    if (hasFocus) root.ensureItemVisible(opmlField);
                }
            }

            DankButton {
                text: "Import Feeds"
                iconName: "download"
                onClicked: {
                    var xml = opmlField.text.trim();
                    if (!xml) {
                        if (typeof ToastService !== "undefined")
                            ToastService.showError("Paste OPML content first");
                        return;
                    }
                    var imported = FeedParser.parseOpml(xml);
                    if (imported.length === 0) {
                        if (typeof ToastService !== "undefined")
                            ToastService.showError("No feeds found in OPML");
                        return;
                    }
                    var currentFeeds = root.loadValue("feeds", []);
                    var existingUrls = {};
                    for (var i = 0; i < currentFeeds.length; i++) {
                        existingUrls[currentFeeds[i].url] = true;
                    }
                    var added = 0;
                    for (var j = 0; j < imported.length; j++) {
                        if (!existingUrls[imported[j].url]) {
                            currentFeeds.push(imported[j]);
                            added++;
                        }
                    }
                    root.saveValue("feeds", currentFeeds);
                    opmlField.text = "";
                    if (typeof ToastService !== "undefined")
                        ToastService.showInfo("Imported " + added + " feed" + (added !== 1 ? "s" : "") + " (" + (imported.length - added) + " duplicates skipped)");
                }
            }
        }
    }

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
        visible: !currentBackend.capabilities.serverState
    }

    // ─── Preset Feeds (Quick Add) ───
    // Wrapped in one Column with a single `visible` binding rather than
    // repeating it on every child below -- there are a lot of them. Adding a
    // preset writes straight into local `feeds`, so it only makes sense for
    // a backend with no server-side subscription list of its own.
    Column {
        width: parent.width
        spacing: Theme.spacingM
        visible: !currentBackend.capabilities.serverState

    StyledText {
        width: parent.width
        text: "Quick Add"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
    }

    StyledText {
        width: parent.width
        text: "Quickly add popular feeds"
        font.pixelSize: Theme.fontSizeSmall
        color: Theme.surfaceVariantText
    }

    StyledText {
        width: parent.width
        text: "News — US"
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.Medium
        color: Theme.primary
    }

    Flow {
        width: parent.width
        spacing: Theme.spacingS

        DankButton {
            text: "AP News"
            iconName: "add"
            onClicked: addPresetFeed("AP News", "https://rsshub.app/apnews/topics/apf-topnews")
        }

        DankButton {
            text: "NPR"
            iconName: "add"
            onClicked: addPresetFeed("NPR", "https://feeds.npr.org/1001/rss.xml")
        }

        DankButton {
            text: "Reuters"
            iconName: "add"
            onClicked: addPresetFeed("Reuters", "https://rsshub.app/reuters/world")
        }
    }

    StyledText {
        width: parent.width
        text: "News — Global"
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.Medium
        color: Theme.primary
    }

    Flow {
        width: parent.width
        spacing: Theme.spacingS

        DankButton {
            text: "BBC World"
            iconName: "add"
            onClicked: addPresetFeed("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml")
        }

        DankButton {
            text: "Al Jazeera"
            iconName: "add"
            onClicked: addPresetFeed("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml")
        }

        DankButton {
            text: "The Guardian"
            iconName: "add"
            onClicked: addPresetFeed("The Guardian", "https://www.theguardian.com/world/rss")
        }
    }

    StyledText {
        width: parent.width
        text: "Tech"
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.Medium
        color: Theme.primary
    }

    Flow {
        width: parent.width
        spacing: Theme.spacingS

        DankButton {
            text: "Hacker News"
            iconName: "add"
            onClicked: addPresetFeed("Hacker News", "https://hnrss.org/newest")
        }

        DankButton {
            text: "Ars Technica"
            iconName: "add"
            onClicked: addPresetFeed("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index")
        }

        DankButton {
            text: "The Verge"
            iconName: "add"
            onClicked: addPresetFeed("The Verge", "https://www.theverge.com/rss/index.xml")
        }
    }

    StyledText {
        width: parent.width
        text: "Reddit"
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.Medium
        color: Theme.primary
    }

    Flow {
        width: parent.width
        spacing: Theme.spacingS

        DankButton {
            text: "r/linux"
            iconName: "add"
            onClicked: addPresetFeed("r/linux", "https://www.reddit.com/r/linux/.rss")
        }

        DankButton {
            text: "r/niri"
            iconName: "add"
            onClicked: addPresetFeed("r/niri", "https://www.reddit.com/r/niri/.rss")
        }

        DankButton {
            text: "r/hyprland"
            iconName: "add"
            onClicked: addPresetFeed("r/hyprland", "https://www.reddit.com/r/hyprland/.rss")
        }

        DankButton {
            text: "r/fedora"
            iconName: "add"
            onClicked: addPresetFeed("r/fedora", "https://www.reddit.com/r/fedora/.rss")
        }

        DankButton {
            text: "r/archlinux"
            iconName: "add"
            onClicked: addPresetFeed("r/archlinux", "https://www.reddit.com/r/archlinux/.rss")
        }

        DankButton {
            text: "r/NixOS"
            iconName: "add"
            onClicked: addPresetFeed("r/NixOS", "https://www.reddit.com/r/NixOS/.rss")
        }

        DankButton {
            text: "r/Ubuntu"
            iconName: "add"
            onClicked: addPresetFeed("r/Ubuntu", "https://www.reddit.com/r/Ubuntu/.rss")
        }
    }

    } // end Quick Add Column

    function addPresetFeed(name, url) {
        var currentFeeds = root.loadValue("feeds", []);
        for (var i = 0; i < currentFeeds.length; i++) {
            if (currentFeeds[i].url === url) {
                if (typeof ToastService !== "undefined") {
                    ToastService.showError("Feed already added");
                }
                return;
            }
        }
        currentFeeds = currentFeeds.concat([{ name: name, url: url, enabled: true, addedAt: Date.now() }]);
        root.saveValue("feeds", currentFeeds);
        if (typeof ToastService !== "undefined") {
            ToastService.showInfo("Added " + name);
        }
    }

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
    }

    // ─── Appearance Settings ───

    StyledText {
        width: parent.width
        text: "Appearance"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
    }

    SliderSetting {
        settingKey: "fontSize"
        label: "Font Size"
        description: "Text size for feed items"
        defaultValue: Theme.fontSizeSmall
        minimum: 8
        maximum: 24
        unit: "px"
    }

    SliderSetting {
        settingKey: "backgroundOpacity"
        label: "Background Opacity"
        defaultValue: 60
        minimum: 0
        maximum: 100
        unit: "%"
    }

    ToggleSetting {
        id: borderToggle
        settingKey: "enableBorder"
        label: "Enable Border"
        defaultValue: false
    }

    SliderSetting {
        opacity: borderToggle.value ? 1.0 : 0.2
        enabled: borderToggle.value
        settingKey: "borderThickness"
        label: "Border Thickness"
        defaultValue: 1
        minimum: 1
        maximum: 10
        unit: "px"
    }

    SliderSetting {
        opacity: borderToggle.value ? 1.0 : 0.2
        enabled: borderToggle.value
        settingKey: "borderOpacity"
        label: "Border Opacity"
        defaultValue: 100
        minimum: 0
        maximum: 100
        unit: "%"
    }

    SelectionSetting {
        opacity: borderToggle.value ? 1.0 : 0.2
        enabled: borderToggle.value
        settingKey: "borderColor"
        label: "Border Color"
        options: [
            { label: "Primary", value: "primary" },
            { label: "Secondary", value: "secondary" },
            { label: "Surface", value: "surface" }
        ]
        defaultValue: "primary"
    }
}
