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
import "ExportProvider.js" as ExportProvider
import "AiProvider.js" as AiProvider
import "Palette.js" as Palette

PluginSettings {
    id: root
    pluginId: "dankRssWidget"

    property int editingIndex: -1
    property string urlError: ""
    property var feedStatuses: []
    property var minifluxFeedsList: []

    // Autodiscovery results (see the "Find Feed" button below). Cleared on
    // every new search so a stale result from a previous site can never be
    // mistaken for the current one.
    property var discoveredFeeds: []
    property bool discoverySearched: false

    // Repeatable list editor state for notification rules -- there is no
    // "editingIndex" like the feed form above because these are add/delete
    // only (see the contract: a full rule builder is explicitly out of scope).
    property string newRuleQuery: ""

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

    // The base URL actually in force: what was typed, else whatever the
    // chosen preset supplies. Resolved rather than stored, so a fresh install
    // that has never touched the dropdown still has a working endpoint --
    // see AiProvider.resolveBaseUrl for the bug that made this necessary.
    function effectiveAiBaseUrl() {
        return AiProvider.resolveBaseUrl(root.loadValue("aiPreset", "ollama"), root.loadValue("aiBaseUrl", ""));
    }

    // Declared on the ROOT, deliberately, even though every caller sits deep
    // inside the Feed Management section.
    //
    // QML resolves an unqualified name against the calling object and the
    // COMPONENT ROOT -- it does NOT walk intermediate ancestors. Moving this
    // onto the section object alongside its callers looked tidier and broke
    // all sixteen Quick Add buttons with "addPresetFeed is not defined",
    // silently, at click time. Verified against a real QML engine rather than
    // reasoned about: a function on an intermediate object is unreachable
    // from a nested child.
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

    // The ONE place a feed is actually written into the `feeds` array from
    // the Add/Edit form -- both the form's own "Add Feed"/"Update Feed"
    // button and the autodiscovery "Add" buttons below call this rather than
    // each carrying their own copy, so validation and the add-vs-edit branch
    // can never drift between the two entry points. Callers are expected to
    // have already set nameField.text/urlField.text (or left them as typed).
    function commitFeedForm() {
        var validated = root.validateFeedUrl(urlField.text);
        if (!validated.ok) {
            root.urlError = validated.error;
            return false;
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
        return true;
    }

    // Same "resolve, don't store" reasoning as effectiveAiBaseUrl above,
    // extended to the embedding model: a typed value always wins, otherwise
    // the chosen preset's suggested embedModel is offered, and "custom" (no
    // PRESETS entry) offers nothing because there is nothing to suggest.
    // Deliberately NOT wired through an onValueChanged handler on the preset
    // dropdown -- that is exactly the bug AiProvider.resolveBaseUrl's own
    // comment documents (it does not fire on a fresh install).
    function effectiveAiEmbedModel() {
        var typed = (root.loadValue("aiEmbedModel", "") || "").trim();
        if (typed)
            return typed;
        var preset = AiProvider.PRESETS[root.loadValue("aiPreset", "ollama")];
        return (preset && preset.embedModel) || "";
    }

    // Snapshot of Theme's current colours, in Palette.js's role shape, for
    // the colour-preset live preview below. Palette.js must never touch
    // Theme itself (see its header comment) -- this is the one place that
    // reads Theme and hands the values in. String(...) coerces Qt's `color`
    // type to the "#aarrggbb" text Palette.parseColour expects; a QColor
    // handed to it directly would fail isValidColour's typeof check.
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

    readonly property var roleColours: Palette.resolvePalette(root.loadValue("colourPreset", "system"), root.themeBasePalette())

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
        color: root.roleColours.surfaceText
    }

    StyledText {
        width: parent.width
        text: "Display RSS/Atom feeds directly, or sync with a Miniflux server."
        font.pixelSize: Theme.fontSizeMedium
        color: root.roleColours.surfaceVariantText
        wrapMode: Text.WordWrap
    }

    StyledRect {
        width: parent.width
        height: 1
        color: root.roleColours.outlineVariant
    }

    // ─── Source Mode ───

    StyledText {
        width: parent.width
        text: "Source Mode"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: root.roleColours.surfaceText
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
    // Whole section is gated on sourceMode, so the `visible:` that used to
    // sit on every single child here now sits once, on the section itself --
    // DankCollapsibleSection is a plain Column child at this level, so it
    // still needs its own `width: parent.width` (Layout.fillWidth does
    // nothing inside the outer plain Column PluginSettings reparents into).
    DankCollapsibleSection {
        width: parent.width
        visible: sourceModeSetting.value === "miniflux"
        title: "Miniflux Connection"
        expanded: false

        Column {
            Layout.fillWidth: true
            spacing: Theme.spacingXS

            StyledText {
                text: "Server URL"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
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
            Layout.fillWidth: true
            spacing: Theme.spacingXS

            StyledText {
                text: "API Token"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
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
            settingKey: "syncReadOnOpen"
            label: "Mark as read on open"
            description: "Mark entries as read on the server when you open them"
            defaultValue: true
        }

        ToggleSetting {
            settingKey: "showStarred"
            label: "Show starred entries"
            description: "Show only starred/bookmarked entries instead of unread entries"
            defaultValue: false
        }

        Row {
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
    }

    // ─── Google Reader Connection (greader mode only) ───
    // Kept keyed on the mode string rather than a capability, deliberately:
    // a credential form is inherently backend-specific (Miniflux takes a
    // token, Google Reader takes a username and password), so there is
    // nothing generic to ask a capability flag here. A separate section from
    // Miniflux Connection above rather than one merged section: sourceMode
    // makes the two mutually exclusive, so nothing is gained by combining
    // them, and keeping them apart avoids a section whose title would have
    // to describe two different credential forms at once.
    DankCollapsibleSection {
        width: parent.width
        visible: sourceModeSetting.value === "greader"
        title: "Google Reader Connection"
        expanded: false

        Column {
            Layout.fillWidth: true
            spacing: Theme.spacingXS

            StyledText {
                text: "Server URL"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
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
            Layout.fillWidth: true
            spacing: Theme.spacingXS

            StyledText {
                text: "Username"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
            }

            // On Miniflux this is NOT the web login: Google Reader integration
            // credentials are a separate username/password set under
            // Settings -> Integrations. Entering the web username here gets a
            // bare 401 from ClientLogin with nothing to explain why.
            StyledText {
                width: parent.width
                text: "Separate from your web login -- set under Settings → Integrations on Miniflux."
                font.pixelSize: Theme.fontSizeSmall - 2
                color: root.roleColours.surfaceVariantText
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
            Layout.fillWidth: true
            spacing: Theme.spacingXS

            StyledText {
                text: "Password"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
            }

            StyledText {
                width: parent.width
                text: "Also separate from your web password -- same Settings → Integrations page on Miniflux."
                font.pixelSize: Theme.fontSizeSmall - 2
                color: root.roleColours.surfaceVariantText
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
    }

    // ─── Notes Export ───
    // DesktopPluginWrapper.qml's loadPluginData reads the instance config
    // first and falls back to the global plugin-wide store; savePluginData
    // writes to the instance config only. So these are per-instance for an
    // instanced widget and global otherwise -- the same as every other
    // setting in this file. Not gated: unlike Miniflux/Google Reader above,
    // export is independent of sourceMode, so this section always shows
    // (its own fields stay individually gated on the export folder / preset,
    // per the comments below).
    DankCollapsibleSection {
        width: parent.width
        title: "Notes Export"
        // Left as content rather than folded into `description` -- it's
        // three sentences explaining an opt-in gate (no folder = no export
        // button), not a one-line summary, so squashing it into the
        // description property would either truncate or look cramped.
        expanded: false

        StyledText {
            Layout.fillWidth: true
            text: "Send an article to a local notes folder and, optionally, open it in an editor of your choice afterward. Leave the folder empty to disable this entirely -- no export button or shortcut appears until one is set."
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        // Stage 4d: editors used to each need their own hardcoded branch (see
        // ExportProvider.js's design doc). Now there's one open-command template
        // with `{path}` substituted, and "one more editor" is one more row in
        // EXPORT_OPEN_PRESETS rather than a new code path. Picking a preset below
        // fills the Command field; it stays editable afterward, and editing it
        // does not change which preset is shown selected here -- so tweaking a
        // preset's flags does not silently look like "Custom" was chosen instead.
        Column {
            id: exportPresetColumn
            Layout.fillWidth: true
            spacing: Theme.spacingS

        readonly property var presets: ExportProvider.EXPORT_OPEN_PRESETS
        // resolveExportConfig() tells "never saved" apart from "saved as
        // empty" by whether the `exportOpenCommand` KEY is present at all --
        // so this object must only carry that key when loadValue actually
        // found one, not whenever this binding happens to construct an
        // object literal (which would always have the key, undefined or
        // not, and make every legacy config look already-migrated).
        readonly property var resolved: {
            var saved = { exportKind: root.loadValue("exportKind") };
            var storedCommand = root.loadValue("exportOpenCommand");
            if (storedCommand !== undefined)
                saved.exportOpenCommand = storedCommand;
            return ExportProvider.resolveExportConfig(saved);
        }
        property string presetId: resolved.exportKind

        function labelForId(id) {
            for (var i = 0; i < presets.length; i++) {
                if (presets[i].id === id) return presets[i].label;
            }
            return id;
        }

        DankDropdown {
            width: parent.width
            text: "Open After Export"
            description: "Pick a starting point, then edit the Command field below to match your setup."
            currentValue: exportPresetColumn.labelForId(exportPresetColumn.presetId)
            options: exportPresetColumn.presets.map(p => p.label)
            onValueChanged: newLabel => {
                var preset = exportPresetColumn.presets.find(p => p.label === newLabel);
                if (!preset) return;
                exportPresetColumn.presetId = preset.id;
                root.saveValue("exportKind", preset.id);
                // Fills the command field from the preset -- this is the ONE
                // place that happens; editing the field afterward never
                // reaches back here to change presetId again.
                exportOpenCommandField.text = preset.template;
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        StyledText {
            text: "Folder"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Absolute path, or vault-relative for Obsidian."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: exportRootField
            width: parent.width
            placeholderText: "/home/you/notes  or  Inbox"
            text: root.loadValue("exportRoot", "")
            onTextChanged: root.saveValue("exportRoot", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(exportRootField);
            }
        }
    }

    // Vault name is Obsidian-specific identity, not a behavioural question --
    // every other preset's equivalent is baked into the command itself, so
    // this is gated on which preset is selected directly (same reasoning as
    // the Google Reader/Miniflux credential fields above, not a capability
    // check).
    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: exportPresetColumn.presetId === "obsidian"

        StyledText {
            text: "Vault Name"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Used only to build the obsidian://open callback after a note is written."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: exportVaultField
            width: parent.width
            placeholderText: "My Vault"
            text: root.loadValue("exportVault", "")
            onTextChanged: root.saveValue("exportVault", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(exportVaultField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        StyledText {
            text: "Command"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "{path} is substituted as its own argument, never pasted into a shell string, so a note's path is safe even if its title contained spaces, quotes or semicolons. The terminal-based presets assume kitty, because that is what this machine runs -- edit this if you use a different terminal. Leave empty to just write the file."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: exportOpenCommandField
            width: parent.width
            placeholderText: "code {path}"
            text: exportPresetColumn.resolved.exportOpenCommand
            onTextChanged: root.saveValue("exportOpenCommand", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(exportOpenCommandField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        StyledText {
            text: "Filename Template"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "{title}, {id} and {source} are substituted, then sanitised and disambiguated before writing -- see ExportProvider.js."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: exportTemplateField
            width: parent.width
            placeholderText: "{title}.md"
            text: root.loadValue("exportTemplate", "{title}.md")
            onTextChanged: root.saveValue("exportTemplate", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(exportTemplateField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        StyledText {
            text: "Tags"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Comma-separated. Applied to every exported note's frontmatter (and as wikilinks in the body, for Obsidian)."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: exportTagsField
            width: parent.width
            placeholderText: "reading, rss"
            text: (root.loadValue("exportTags", []) || []).join(", ")
            // Parse and save on commit only, not on every keystroke. The
            // field's `text:` above is a live binding to the saved value,
            // so saving on every character re-runs that binding mid-type;
            // a still-empty second tag ("news,") is dropped by the filter
            // below, and the rebind then overwrites the field with "news"
            // -- silently eating the comma the user just typed. Committing
            // only on editingFinished (Enter, or focus lost) means the
            // rebind never fires until the user is done typing.
            onEditingFinished: {
                var tags = text.split(",").map(function (t) {
                    return t.trim();
                }).filter(function (t) {
                    return t.length > 0;
                });
                root.saveValue("exportTags", tags);
            }
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(exportTagsField);
            }
        }
    }

    ToggleSetting {
        settingKey: "exportFullText"
        label: "Fetch full article text on export"
        description: "Fetches each exported item's own page and extracts the article body instead of using the feed's summary. Off by default -- this makes one outbound request per exported article to whatever site the feed links to, so it must be opt-in. A page that cannot be fetched, or that looks like a section front rather than an article, falls back to the summary automatically."
        defaultValue: false
    }

    // Gated on the export folder being set, same as the header comment above
    // already promises for this whole section ("no export button or
    // shortcut appears until one is set") -- an attachment folder is
    // meaningless with nowhere to export notes into in the first place.
    ToggleSetting {
        id: exportImagesSetting
        visible: exportRootField.text.trim() !== ""
        settingKey: "exportImages"
        label: "Download Images on Export"
        description: "Downloads each exported article's images into an attachments folder next to the notes, so they render locally in Obsidian and Neovim instead of depending on the original site staying up."
        defaultValue: false
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: exportRootField.text.trim() !== "" && exportImagesSetting.value

        StyledText {
            text: "Attachment Folder"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            // Spelled out because the default is a folder the user never
            // chose: images landing in a subfolder they did not ask for reads
            // as the setting being ignored, even though a subfolder is the
            // tidier answer and what most vaults expect.
            text: "Relative to the notes folder above. Defaults to \"attachments\"; clear it to keep images beside the notes instead."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: attachmentDirField
            width: parent.width
            placeholderText: "attachments"
            text: root.loadValue("attachmentDir", "attachments")
            onTextChanged: root.saveValue("attachmentDir", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(attachmentDirField);
            }
        }
    }
    } // end Notes Export DankCollapsibleSection

    // ─── Refresh Settings (always visible) ───
    DankCollapsibleSection {
        width: parent.width
        title: "Refresh Settings"
        expanded: false

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
        settingKey: "markReadOnScroll"
        label: "Mark Read on Scroll"
        description: "Mark items as read automatically as they scroll past, instead of only on click or open"
        defaultValue: false
    }

    ToggleSetting {
        settingKey: "openInBrowser"
        label: "Open Links in Browser"
        description: "Click feed items to open them in your browser"
        defaultValue: true
    }
    } // end Refresh Settings DankCollapsibleSection

    // ─── Feed Management ───
    // Covers BOTH the read-only server-side subscription snapshot (Miniflux,
    // Google Reader -- see the Subscription List comment below) and the
    // locally-editable list (add/edit form, autodiscovery, configured feeds,
    // OPML import/export, quick-add presets) -- only one half is ever
    // visible at a time, gated on currentBackend.capabilities.serverState,
    // but both are "managing your feeds" so they share one section rather
    // than the user having to find two.
    //
    // The only section that starts expanded, per the settings-panel
    // requirements: it's the section most people open this panel for.
    DankCollapsibleSection {
        width: parent.width
        title: "Feed Management"
        expanded: true

        // ─── Subscription List (read-only) ───
        // Shown for any backend that keeps subscriptions on the server rather
        // than in this plugin's own settings -- there is nothing local to add,
        // edit, or reorder, only a snapshot of what the server already has.
        // The list itself is still populated only by fetchMinifluxFeeds()
        // (Miniflux's /v1/feeds); Google Reader shows this section empty until
        // it gets its own feed-listing call.
        StyledText {
            Layout.fillWidth: true
            text: "Subscription List"
            font.pixelSize: Theme.fontSizeMedium
            font.weight: Font.Medium
            color: root.roleColours.surfaceText
            visible: currentBackend.capabilities.serverState
        }

        StyledRect {
            Layout.fillWidth: true
            height: Math.max(80, minifluxFeedsColumn.implicitHeight + Theme.spacingL * 2)
            radius: Theme.cornerRadius
            color: root.roleColours.surfaceContainerHigh
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
                            color: root.roleColours.primary
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1

                            StyledText {
                                text: modelData.title || ""
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.Medium
                                color: root.roleColours.surfaceText
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                            }

                            StyledText {
                                text: modelData.feed_url || modelData.site_url || ""
                                font.pixelSize: Theme.fontSizeSmall - 2
                                color: root.roleColours.surfaceVariantText
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
                    color: root.roleColours.surfaceVariantText
                    width: parent.width
                }
            }
        }

        // Only meaningful for a backend with no server-side subscription list
        // of its own -- adding, editing, and reordering feeds here is exactly
        // what a serverState backend's own subscription management (above)
        // already covers. The section title itself now says "Feed
        // Management" so this inner heading is dropped as redundant.
        StyledRect {
            Layout.fillWidth: true
            height: addFeedColumn.implicitHeight + Theme.spacingL * 2
            radius: Theme.cornerRadius
            color: root.roleColours.surfaceContainerHigh
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
                color: root.roleColours.surfaceText
            }

            Column {
                width: parent.width
                spacing: Theme.spacingXS

                StyledText {
                    text: "Feed Name"
                    font.pixelSize: Theme.fontSizeSmall
                    color: root.roleColours.surfaceVariantText
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
                    color: root.roleColours.surfaceVariantText
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
                    color: root.roleColours.error
                    wrapMode: Text.WordWrap
                }
            }

            Row {
                spacing: Theme.spacingM

                DankButton {
                    text: root.editingIndex === -1 ? "Add Feed" : "Update Feed"
                    iconName: root.editingIndex === -1 ? "add" : "save"

                    onClicked: root.commitFeedForm()
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

    // ─── Feed Autodiscovery ───
    // Finds a site's declared <link rel="alternate"> feed(s) the way a
    // browser's own "subscribe" button would, so a user with only a site's
    // homepage URL doesn't have to go hunting for the actual feed URL by
    // hand. Discovering feeds does not add them -- "Add" below reuses
    // commitFeedForm() (the exact same validate-and-save path the Add Feed
    // button above uses), so a discovered URL gets the same URL validation
    // and dedupe-on-edit behaviour as one typed in by hand.
    StyledRect {
        Layout.fillWidth: true
        height: discoveryColumn.implicitHeight + Theme.spacingL * 2
        radius: Theme.cornerRadius
        color: root.roleColours.surfaceContainerHigh
        visible: !currentBackend.capabilities.serverState

        Column {
            id: discoveryColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingM

            StyledText {
                text: "Find a Feed"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: root.roleColours.surfaceText
            }

            StyledText {
                width: parent.width
                text: "Enter a site's homepage and this looks for the feed it declares, instead of you having to find the feed URL yourself."
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
                wrapMode: Text.WordWrap
            }

            Row {
                width: parent.width
                spacing: Theme.spacingM

                DankTextField {
                    id: discoverySiteField
                    width: parent.width - findFeedButton.width - Theme.spacingM
                    placeholderText: "e.g., https://example.com"
                    onFocusStateChanged: hasFocus => {
                        if (hasFocus) root.ensureItemVisible(discoverySiteField);
                    }
                }

                DankButton {
                    id: findFeedButton
                    text: "Find Feed"
                    iconName: "search"
                    onClicked: {
                        var validated = root.validateFeedUrl(discoverySiteField.text);
                        if (!validated.ok) {
                            if (typeof ToastService !== "undefined")
                                ToastService.showError(validated.error);
                            return;
                        }
                        root.discoverySearched = false;
                        root.discoveredFeeds = [];
                        var req = FeedParser.buildDiscoveryRequest(validated.url);
                        // null Proc id -- see fetchMinifluxFeeds()'s comment
                        // above for why a fixed id would be wrong here too.
                        Proc.runCommand(null, req.argv,
                            function(out, code) {
                                root.discoveredFeeds = req.parse(out || "");
                                root.discoverySearched = true;
                            }, undefined, req.timeoutMs || 15000
                        );
                    }
                }
            }

            // No results is stated plainly in-line, not a toast -- a failed
            // discovery is an expected, common outcome (many sites declare no
            // feed at all), not an error worth interrupting with a popup.
            StyledText {
                visible: root.discoverySearched && root.discoveredFeeds.length === 0
                width: parent.width
                text: "No feed found on that page."
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
                wrapMode: Text.WordWrap
            }

            Column {
                width: parent.width
                spacing: Theme.spacingXS
                visible: root.discoveredFeeds.length > 0

                Repeater {
                    model: root.discoveredFeeds

                    delegate: RowLayout {
                        required property var modelData
                        width: discoveryColumn.width
                        spacing: Theme.spacingS

                        DankIcon {
                            name: "rss_feed"
                            size: 14
                            color: root.roleColours.primary
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1

                            StyledText {
                                text: modelData.title || modelData.url
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.Medium
                                color: root.roleColours.surfaceText
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                            }

                            StyledText {
                                text: modelData.url
                                font.pixelSize: Theme.fontSizeSmall - 2
                                color: root.roleColours.surfaceVariantText
                                Layout.fillWidth: true
                                elide: Text.ElideMiddle
                            }
                        }

                        DankButton {
                            text: "Add"
                            iconName: "add"
                            onClicked: {
                                nameField.text = modelData.title || modelData.url;
                                urlField.text = modelData.url;
                                if (root.commitFeedForm()) {
                                    if (typeof ToastService !== "undefined")
                                        ToastService.showInfo("Added " + (modelData.title || modelData.url));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    StyledRect {
        Layout.fillWidth: true
        height: Math.max(120, feedsListColumn.implicitHeight + Theme.spacingL * 2)
        radius: Theme.cornerRadius
        color: root.roleColours.surfaceContainerHigh
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
                color: root.roleColours.surfaceText
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
                    color: feedItemMouse.containsMouse ? root.roleColours.surfaceContainerHighest : root.roleColours.surfaceContainer
                    opacity: modelData.enabled === false ? 0.55 : 1.0

                    RowLayout {
                        id: feedInfoRow
                        anchors.fill: parent
                        anchors.margins: Theme.spacingM
                        spacing: Theme.spacingM

                        DankIcon {
                            name: "rss_feed"
                            size: 16
                            color: root.roleColours.primary
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2

                            StyledText {
                                text: modelData.name || ""
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.Medium
                                color: modelData.enabled === false ? root.roleColours.surfaceVariantText : root.roleColours.surfaceText
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                            }

                            StyledText {
                                text: modelData.url || ""
                                font.pixelSize: Theme.fontSizeSmall - 2
                                color: root.roleColours.surfaceVariantText
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
                                    color: root.roleColours.success
                                }

                                DankIcon {
                                    visible: parent.feedStatus !== null && (parent.feedStatus.state === "error" || parent.feedStatus.state === "timeout")
                                    name: "error"
                                    size: 12
                                    color: root.roleColours.error
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
                                        if (modelData.enabled === false) return root.roleColours.surfaceVariantText;
                                        if (st && (st.state === "error" || st.state === "timeout")) return root.roleColours.error;
                                        if (st && st.state === "ok") return root.roleColours.success;
                                        return root.roleColours.surfaceVariantText;
                                    }
                                }
                            }
                        }

                        DankToggle {
                            // State belongs in Accessible.checked, not folded
                            // into the name -- a screen reader announces
                            // checked state itself, so putting it in the name
                            // too reads it out twice.
                            Accessible.role: Accessible.CheckBox
                            Accessible.name: "Enable " + (modelData.name || "feed") + " feed"
                            Accessible.checked: modelData.enabled !== false
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
                            Accessible.role: Accessible.Button
                            Accessible.name: "Move " + (modelData.name || "feed") + " up"
                            Accessible.onPressAction: moveUpArea.clicked(null)
                            opacity: enabled ? 1.0 : 0.35
                            color: enabled && moveUpArea.containsMouse ? root.roleColours.primary : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "arrow_upward"
                                size: 16
                                color: moveUpButton.enabled && moveUpArea.containsMouse ? root.roleColours.onPrimary : root.roleColours.surfaceVariantText
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
                            Accessible.role: Accessible.Button
                            Accessible.name: "Move " + (modelData.name || "feed") + " down"
                            Accessible.onPressAction: moveDownArea.clicked(null)
                            opacity: enabled ? 1.0 : 0.35
                            color: enabled && moveDownArea.containsMouse ? root.roleColours.primary : "transparent"

                            DankIcon {
                                anchors.centerIn: parent
                                name: "arrow_downward"
                                size: 16
                                color: moveDownButton.enabled && moveDownArea.containsMouse ? root.roleColours.onPrimary : root.roleColours.surfaceVariantText
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
                            color: editArea.containsMouse ? root.roleColours.primary : "transparent"
                            Accessible.role: Accessible.Button
                            Accessible.name: "Edit " + (modelData.name || "feed")
                            Accessible.onPressAction: editArea.clicked(null)

                            DankIcon {
                                anchors.centerIn: parent
                                name: "edit"
                                size: 16
                                color: editArea.containsMouse ? root.roleColours.onPrimary : root.roleColours.surfaceVariantText
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
                            color: deleteArea.containsMouse ? root.roleColours.error : "transparent"
                            Accessible.role: Accessible.Button
                            Accessible.name: "Delete " + (modelData.name || "feed")
                            Accessible.onPressAction: deleteArea.clicked(null)

                            DankIcon {
                                anchors.centerIn: parent
                                name: "delete"
                                size: 16
                                color: deleteArea.containsMouse ? root.roleColours.onError : root.roleColours.surfaceVariantText
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
                    color: root.roleColours.surfaceVariantText
                    visible: feedsListView.count === 0
                }
            }
        }
    }

    // OPML Import: feeds live locally only when the backend has no server
    // subscription list of its own to import into instead.
    StyledRect {
        Layout.fillWidth: true
        height: opmlColumn.implicitHeight + Theme.spacingL * 2
        radius: Theme.cornerRadius
        color: root.roleColours.surfaceContainerHigh
        visible: !currentBackend.capabilities.serverState

        Column {
            id: opmlColumn
            anchors.fill: parent
            anchors.margins: Theme.spacingL
            spacing: Theme.spacingM

            StyledText {
                text: "Import / Export OPML"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: root.roleColours.surfaceText
            }

            StyledText {
                width: parent.width
                text: "Paste OPML/XML content to import feeds from other RSS readers"
                font.pixelSize: Theme.fontSizeSmall
                color: root.roleColours.surfaceVariantText
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

            StyledRect {
                width: parent.width
                height: 1
                color: root.roleColours.outlineVariant
            }

            StyledText {
                text: "Export Feeds to OPML"
                font.pixelSize: Theme.fontSizeMedium
                font.weight: Font.Medium
                color: root.roleColours.surfaceText
            }

            StyledText {
                width: parent.width
                // Written via a Quickshell FileView with atomicWrites, the
                // SAME mechanism DankRssWidget.qml's notes export uses (see
                // its "Notes export" section) -- no shell, no partial file
                // ever visible, and no dependency on the notes-export folder
                // being configured at all, since an OPML backup is a
                // different (and independent) thing to want.
                text: "Full path to write, including the filename (created or overwritten)."
                font.pixelSize: Theme.fontSizeSmall - 2
                color: root.roleColours.surfaceVariantText
                wrapMode: Text.WordWrap
            }

            DankTextField {
                id: opmlExportPathField
                width: parent.width
                placeholderText: "/home/you/notes/feeds.opml"
                text: root.loadValue("opmlExportPath", "")
                onTextChanged: root.saveValue("opmlExportPath", text)
                onFocusStateChanged: hasFocus => {
                    if (hasFocus) root.ensureItemVisible(opmlExportPathField);
                }
            }

            DankButton {
                text: "Export OPML"
                iconName: "upload"
                onClicked: {
                    var path = opmlExportPathField.text.trim();
                    if (!path) {
                        if (typeof ToastService !== "undefined")
                            ToastService.showError("Enter a destination path or folder first");
                        return;
                    }
                    // A folder is the obvious thing to type here, and typing
                    // one used to fail with "could not access" -- which reads
                    // as a permissions problem rather than "you gave me a
                    // directory". Anything with no file extension in its last
                    // segment is treated as a folder and gets a filename.
                    var last = path.replace(/\/+$/, "").split("/").pop();
                    if (path.charAt(path.length - 1) === "/" || last.indexOf(".") < 0)
                        path = path.replace(/\/+$/, "") + "/dank-rss-feeds.opml";

                    var xml = FeedParser.buildOpml(root.loadValue("feeds", []), { dateCreated: new Date().toUTCString() });
                    var view = opmlExportFileViewComponent.createObject(root, { path: path });
                    view.setText(xml);
                }
            }

            // One-shot FileView per export click, created fresh and destroyed
            // once it settles -- mirrors DankRssWidget.qml's per-write
            // exportFileViewComponent exactly (and its comment on why: a
            // shared FileView's path/text state races a second write started
            // before the first one's load/save settles). blockWrites +
            // atomicWrites match that same component too, so an interrupted
            // export never leaves a half-written OPML file behind. preload is
            // off since this is write-only.
            Component {
                id: opmlExportFileViewComponent

                FileView {
                    id: opmlExportFileViewInstance
                    blockWrites: true
                    atomicWrites: true
                    preload: false

                    onSaved: {
                        if (typeof ToastService !== "undefined")
                            ToastService.showInfo("Feeds exported to " + opmlExportFileViewInstance.path);
                        opmlExportFileViewInstance.destroy();
                    }

                    onSaveFailed: error => {
                        if (typeof ToastService !== "undefined")
                            ToastService.showError("Export failed: could not write " + opmlExportFileViewInstance.path);
                        opmlExportFileViewInstance.destroy();
                    }
                }
            }
        }
    }

    // ─── Preset Feeds (Quick Add) ───
    // Wrapped in one Column with a single `visible` binding rather than
    // repeating it on every child below -- there are a lot of them. Adding a
    // preset writes straight into local `feeds`, so it only makes sense for
    // a backend with no server-side subscription list of its own. The
    // divider that used to separate this from the OPML card above is
    // dropped -- redundant now that this whole group lives inside one
    // collapsible section.
    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingM
        visible: !currentBackend.capabilities.serverState

    StyledText {
        width: parent.width
        text: "Quick Add"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: root.roleColours.surfaceText
    }

    StyledText {
        width: parent.width
        text: "Quickly add popular feeds"
        font.pixelSize: Theme.fontSizeSmall
        color: root.roleColours.surfaceVariantText
    }

    StyledText {
        width: parent.width
        text: "News — US"
        font.pixelSize: Theme.fontSizeSmall
        font.weight: Font.Medium
        color: root.roleColours.primary
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
        color: root.roleColours.primary
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
        color: root.roleColours.primary
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
        color: root.roleColours.primary
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

    } // end Feed Management DankCollapsibleSection

    // ─── Appearance Settings ───
    DankCollapsibleSection {
        width: parent.width
        title: "Appearance"
        expanded: false

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
    } // end Appearance DankCollapsibleSection

    // ─── Reader ───
    DankCollapsibleSection {
        width: parent.width
        title: "Reader"
        expanded: false

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        StyledText {
            text: "Reader Font"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Leave empty to follow your DMS font."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: readerFontFamilyField
            activeFocusOnTab: false
            width: parent.width
            placeholderText: "Follows Theme.fontFamily"
            text: root.loadValue("readerFontFamily", "")
            onTextChanged: root.saveValue("readerFontFamily", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(readerFontFamilyField);
            }
        }
    }
    } // end Reader DankCollapsibleSection

    // ─── AI Summaries ───
    // The design doc wanted this toggle per-instance, but this plugin has
    // never adopted the DMS plugin-variant system -- every setting here goes
    // through root.loadValue/saveValue, which is savePluginData underneath
    // and keyed on pluginId only (see the Notes Export comment above). So
    // "AI Summaries" is a single global on/off for now, the same as every
    // other setting in this file, not a per-widget-instance choice. Not
    // gated on the section itself -- the toggle that enables it lives inside
    // and must stay visible even when AI Summaries is off, so every OTHER
    // field in here keeps its own visible: aiEnabledSetting.value instead.
    DankCollapsibleSection {
        width: parent.width
        title: "AI Summaries"
        expanded: false

    ToggleSetting {
        id: aiEnabledSetting
        settingKey: "aiEnabled"
        label: "AI Summaries"
        description: "Summarise articles on demand using a local OpenAI-compatible runtime (Ollama, vLLM, llama.cpp, LM Studio, ...). Nothing is sent anywhere until you ask for a summary -- this never runs automatically in the background."
        defaultValue: false
    }

    SelectionSetting {
        id: aiPresetSetting
        visible: aiEnabledSetting.value
        settingKey: "aiPreset"
        label: "Runtime"
        description: "Picking a preset fills the Base URL below. Choose Custom to point at any other OpenAI-compatible endpoint."
        options: [
            { label: AiProvider.PRESETS.ollama.label, value: "ollama" },
            { label: AiProvider.PRESETS.vllm.label, value: "vllm" },
            { label: AiProvider.PRESETS.llamacpp.label, value: "llamacpp" },
            { label: AiProvider.PRESETS.lmstudio.label, value: "lmstudio" },
            { label: AiProvider.PRESETS.custom.label, value: "custom" }
        ]
        defaultValue: "ollama"
        // Fills the Base URL field from the chosen preset -- this is the ONE
        // place that happens, mirroring the Notes Export preset dropdown
        // above. "custom" deliberately does nothing here so a URL the user
        // typed while Custom is selected is never clobbered by this handler
        // re-firing (e.g. on page reload, when this binding runs once with
        // the loaded value).
        onValueChanged: {
            if (aiPresetSetting.value === "custom")
                return;
            var preset = AiProvider.PRESETS[aiPresetSetting.value];
            if (preset)
                aiBaseUrlField.text = preset.baseUrl;
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: aiEnabledSetting.value

        StyledText {
            text: "Base URL"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        DankTextField {
            id: aiBaseUrlField
            width: parent.width
            // Seeded with the RESOLVED url, not a placeholder that merely
            // looks like one. A greyed-out placeholder is indistinguishable
            // from a real value at a glance, which is precisely how the
            // original bug hid: the form looked complete and was not.
            placeholderText: "Set by the runtime preset above"
            text: root.effectiveAiBaseUrl()
            onTextChanged: root.saveValue("aiBaseUrl", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(aiBaseUrlField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: aiEnabledSetting.value

        StyledText {
            text: "Model"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Prefer an instruct-tagged model over a -base one -- base models are not tuned to follow the summarise/digest instructions. If summaries feel slow, try a non-reasoning model; a reasoning model spends extra tokens thinking before it answers."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: aiModelField
            width: parent.width
            placeholderText: "e.g., qwen3:8b"
            text: root.loadValue("aiModel", "")
            onTextChanged: root.saveValue("aiModel", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(aiModelField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: aiEnabledSetting.value

        StyledText {
            text: "API Key"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        StyledText {
            width: parent.width
            text: "Most local runtimes need none -- leave this empty unless yours requires one."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        // Never logged and never appears in a toast, matching the Miniflux
        // token and Google Reader password fields above.
        DankTextField {
            id: aiApiKeyField
            width: parent.width
            placeholderText: "Optional"
            text: root.loadValue("aiApiKey", "")
            onTextChanged: root.saveValue("aiApiKey", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(aiApiKeyField);
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS
        visible: aiEnabledSetting.value

        StyledText {
            text: "Embedding Model"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
        }

        // A DIFFERENT model from "Model" above: that one answers chat
        // completions (summaries/digests), this one answers /embeddings, and
        // most chat models either don't serve that endpoint at all or serve
        // it badly (see AiProvider.resolveEmbedModel's comment -- there is
        // deliberately no fallback from one to the other). Only interest
        // ranking below reads this; summaries and digests never touch it.
        StyledText {
            width: parent.width
            text: "e.g., nomic-embed-text. Needed only if you turn on interest ranking below."
            font.pixelSize: Theme.fontSizeSmall - 2
            color: root.roleColours.surfaceVariantText
            wrapMode: Text.WordWrap
        }

        DankTextField {
            id: aiEmbedModelField
            width: parent.width
            // Seeded with the RESOLVED value (typed, else the preset's
            // suggested default) -- same "resolve, don't store" reasoning as
            // aiBaseUrlField above, via effectiveAiEmbedModel(). Never wired
            // to aiPresetSetting.onValueChanged: that handler does not fire
            // on a fresh install (see AiProvider.resolveBaseUrl's comment),
            // so a value populated only there would silently stay empty.
            placeholderText: "Set by the runtime preset above"
            text: root.effectiveAiEmbedModel()
            onTextChanged: root.saveValue("aiEmbedModel", text)
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(aiEmbedModelField);
            }
        }
    }

    Row {
        visible: aiEnabledSetting.value
        spacing: Theme.spacingM

        DankButton {
            text: "Test Connection"
            iconName: "wifi_tethering"
            onClicked: {
                var provider = AiProvider.createAiProvider({
                    baseUrl: root.effectiveAiBaseUrl(),
                    model: root.loadValue("aiModel", ""),
                    apiKey: root.loadValue("aiApiKey", "")
                });
                if (!provider.isConfigured()) {
                    if (typeof ToastService !== "undefined")
                        ToastService.showError("Enter a Model first (and a Base URL, if the runtime is Custom)");
                    return;
                }
                var req = provider.probeRequest();
                // req is only null when unconfigured, which isConfigured()
                // above already ruled out -- but AiProvider does no I/O of
                // its own, so nothing stops this from calling Proc directly.
                if (!req)
                    return;
                // Proc id is null, not a fixed string -- see
                // fetchMinifluxFeeds()'s comment above and the matching
                // reasoning at DankRssWidget.qml's Proc.runCommand calls: a
                // fixed id would clobber this callback if the button is
                // pressed again before the probe returns.
                Proc.runCommand(null, req.argv,
                    function(out, code) {
                        // A nonzero exit with no body is a dead socket, not a
                        // bad response. Parsing "" then reporting "Parse
                        // failed" told the user their JSON was malformed when
                        // in fact nothing had answered at all.
                        if (code !== 0 && !out) {
                            if (typeof ToastService !== "undefined")
                                ToastService.showError("Could not reach " + root.effectiveAiBaseUrl(),
                                    code === 124 ? "The request timed out." : "Is the runtime running?");
                            return;
                        }
                        var result = req.parse(out || "");
                        if (!result || !result.reachable) {
                            // AiProvider now sends --fail-with-body, so a
                            // 401/403 or a proxy's HTML error page comes back
                            // as a populated result.error instead of an empty
                            // .data array -- surface THAT instead of a blanket
                            // "could not reach", which used to make a wrong
                            // API key look identical to a dead host.
                            var reason = (result && result.error) || ("could not reach " + root.effectiveAiBaseUrl());
                            if (typeof ToastService !== "undefined")
                                ToastService.showError("Connection failed: " + reason);
                            return;
                        }
                        if (!result.hasModel) {
                            // Capped: ollama installations routinely hold
                            // dozens of models, and the point of this toast
                            // is "your model name is wrong, here is the
                            // shape of what is there", not a full inventory.
                            var all = result.models || [];
                            var available = all.length === 0 ? "none" : (all.slice(0, 5).join(", ") + (all.length > 5 ? " (+" + (all.length - 5) + " more)" : ""));
                            if (typeof ToastService !== "undefined")
                                ToastService.showWarning("Reachable, but model \"" + root.loadValue("aiModel", "") + "\" was not found. Available: " + available);
                            return;
                        }
                        if (typeof ToastService !== "undefined")
                            ToastService.showInfo("AI runtime connection successful!");
                    }, undefined, req.timeoutMs
                );
            }
        }
    }
    } // end AI Summaries DankCollapsibleSection

    // ─── Interest Ranking ───
    // Off by default, deliberately: this is the riskiest feature in the
    // project (see docs/plans/BACKLOG.md) -- it silently reorders the widget
    // away from a plain, predictable reverse-chronological feed. The backlog
    // asks for "a visible reason and an obvious way back" for exactly that
    // reason; the description text below IS that way back -- read it before
    // trimming it.
    DankCollapsibleSection {
        width: parent.width
        title: "Interest Ranking"
        expanded: false

    ToggleSetting {
        id: rankingEnabledSetting
        settingKey: "rankingEnabled"
        label: "Rank by Interest"
        description: "Reorders unread items by similarity to the articles you've starred, instead of showing them in plain reverse-chronological order. This needs starred articles to learn from (star a few things first) and an embedding model configured above -- with neither, ranking has nothing to work from and falls back to plain order. Off by default: turn it on to try it, and turn it back off any time to return to exactly the feed you had before."
        defaultValue: false
    }

    SliderSetting {
        visible: rankingEnabledSetting.value
        settingKey: "rankingWeight"
        label: "Ranking Weight"
        description: "0 is exactly reverse-chronological (ranking has no effect at all); 100 is pure similarity to your starred articles, ignoring recency entirely. Start low and raise it only if the ordering feels right."
        defaultValue: 50
        minimum: 0
        maximum: 100
        unit: "%"
    }
    } // end Interest Ranking DankCollapsibleSection

    // ─── Colour Theme ───
    // See Palette.js's header: the widget's owner has deuteranopia, and a
    // matugen-generated theme has no reason to preserve contrast on the
    // colours this widget uses to signal state (error/success). These
    // presets fix that. Deliberately does NOT restyle anything else in this
    // panel -- that is a separate, serialised pass (see the plan doc) and
    // this file only owns the one setting plus its own preview swatches.
    DankCollapsibleSection {
        width: parent.width
        title: "Colour Theme"
        expanded: false

    SelectionSetting {
        id: colourPresetSetting
        settingKey: "colourPreset"
        label: "Colour Theme"
        description: "System follows your DMS theme as-is. The first three are colour-vision-deficiency palettes (Okabe-Ito for deuteranopia and protanopia, Paul Tol's bright scheme for tritanopia), chosen so error and success stay apart for that condition. The rest are ordinary themes, offered because this widget never signals state by hue alone — feed status also changes icon shape and text, and read state uses opacity. The swatches below are the real thing: if two of them look the same to you, pick another."
        options: [
            { label: "System", value: "system" },
            { label: "Deuteranopia-safe", value: "deuteranopia" },
            { label: "Protanopia-safe", value: "protanopia" },
            { label: "Tritanopia-safe", value: "tritanopia" },
            { label: "Nord", value: "nord" },
            { label: "Gruvbox", value: "gruvbox" },
            { label: "Catppuccin Mocha", value: "catppuccin" },
            { label: "Dracula", value: "dracula" },
            { label: "Solarized", value: "solarized" }
        ]
        defaultValue: "system"
    }

    // Live preview: the three roles this feature actually exists to fix.
    // Recomputed whenever the preset changes; resolvePalette is pure (no
    // Theme access of its own), so themeBasePalette() supplies the "system"
    // colours it's resolved against.
    Row {
        id: colourPreviewRow
        Layout.fillWidth: true
        spacing: Theme.spacingL

        property var previewPalette: Palette.resolvePalette(colourPresetSetting.value, root.themeBasePalette())

        Repeater {
            model: [
                { role: "error", label: "Error" },
                { role: "success", label: "Success" },
                { role: "primary", label: "Primary" }
            ]

            delegate: Column {
                required property var modelData
                spacing: Theme.spacingXS

                Rectangle {
                    width: 48
                    height: 24
                    radius: Theme.cornerRadius
                    color: colourPreviewRow.previewPalette[modelData.role]
                }

                StyledText {
                    text: modelData.label
                    font.pixelSize: Theme.fontSizeSmall - 2
                    color: root.roleColours.surfaceVariantText
                }
            }
        }
    }
    } // end Colour Theme DankCollapsibleSection

    // ─── Notification Rules ───
    // Add/list/delete only -- a full rule builder is out of scope (see the
    // design doc). Each rule is { query, sources }; sources stays [] here
    // (meaning "all feeds") since a per-rule source picker is exactly the
    // kind of scope this section is deliberately not taking on.
    //
    // The whole point of reusing the search syntax rather than inventing a
    // separate rule language: whatever you already know from the widget's
    // own search box works here unchanged. That explanation is one line, so
    // it moved into `description` instead of staying a separate StyledText.
    DankCollapsibleSection {
        width: parent.width
        title: "Notification Rules"
        description: "Get notified when an item matches a query, using the SAME search syntax as the widget's search box."
        expanded: false

    Row {
        Layout.fillWidth: true
        spacing: Theme.spacingM

        DankTextField {
            id: newRuleQueryField
            width: parent.width - addRuleButton.width - Theme.spacingM
            placeholderText: "e.g., kernel OR security"
            onFocusStateChanged: hasFocus => {
                if (hasFocus) root.ensureItemVisible(newRuleQueryField);
            }
        }

        DankButton {
            id: addRuleButton
            text: "Add Rule"
            iconName: "add"
            onClicked: {
                var query = newRuleQueryField.text.trim();
                if (!query) {
                    if (typeof ToastService !== "undefined")
                        ToastService.showError("Enter a query first");
                    return;
                }
                var rules = root.loadValue("notificationRules", []);
                rules = rules.concat([{ query: query, sources: [] }]);
                root.saveValue("notificationRules", rules);
                newRuleQueryField.text = "";
            }
        }
    }

    Column {
        Layout.fillWidth: true
        spacing: Theme.spacingXS

        Repeater {
            model: root.loadValue("notificationRules", [])

            delegate: RowLayout {
                required property var modelData
                required property int index
                width: parent.width
                spacing: Theme.spacingS

                DankIcon {
                    name: "notifications"
                    size: 14
                    color: root.roleColours.primary
                }

                StyledText {
                    Layout.fillWidth: true
                    text: modelData.query || ""
                    font.pixelSize: Theme.fontSizeSmall
                    color: root.roleColours.surfaceText
                    elide: Text.ElideRight
                }

                Rectangle {
                    width: 28; height: 28; radius: 14
                    color: deleteRuleArea.containsMouse ? root.roleColours.error : "transparent"
                    Accessible.role: Accessible.Button
                    Accessible.name: "Delete notification rule " + (modelData.query || "")
                    Accessible.onPressAction: deleteRuleArea.clicked(null)

                    DankIcon {
                        anchors.centerIn: parent
                        name: "delete"
                        size: 14
                        color: deleteRuleArea.containsMouse ? root.roleColours.onError : root.roleColours.surfaceVariantText
                    }

                    MouseArea {
                        id: deleteRuleArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            var rules = root.loadValue("notificationRules", []);
                            rules = rules.filter(function(_, i) { return i !== index; });
                            root.saveValue("notificationRules", rules);
                        }
                    }
                }
            }
        }

        StyledText {
            text: "No notification rules yet"
            font.pixelSize: Theme.fontSizeSmall
            color: root.roleColours.surfaceVariantText
            visible: root.loadValue("notificationRules", []).length === 0
        }
    }
    } // end Notification Rules DankCollapsibleSection
}
