import QtQuick
import QtQuick.Layouts
import qs.Common
import qs.Widgets
import qs.Modules.Plugins

PluginSettings {
    id: root
    pluginId: "dankRssWidget"

    property int editingIndex: -1

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
        text: "Display RSS and Atom feeds on your desktop. Add feeds below and configure refresh intervals and appearance."
        font.pixelSize: Theme.fontSizeMedium
        color: Theme.surfaceVariantText
        wrapMode: Text.WordWrap
    }

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
    }

    // ─── Refresh Settings ───

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

    ToggleSetting {
        settingKey: "showFeedName"
        label: "Show Feed Source"
        description: "Display the feed name next to each item title"
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
    }

    // ─── Feed Management ───

    StyledText {
        width: parent.width
        text: "Feed Management"
        font.pixelSize: Theme.fontSizeMedium
        font.weight: Font.Medium
        color: Theme.surfaceText
    }

    // Add/Edit form
    StyledRect {
        width: parent.width
        height: addFeedColumn.implicitHeight + Theme.spacingL * 2
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh

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
                }
            }

            Row {
                spacing: Theme.spacingM

                DankButton {
                    text: root.editingIndex === -1 ? "Add Feed" : "Update Feed"
                    iconName: root.editingIndex === -1 ? "add" : "save"

                    onClicked: {
                        var url = urlField.text.trim();
                        if (!url) {
                            if (typeof ToastService !== "undefined") {
                                ToastService.showError("Please enter a feed URL");
                            }
                            return;
                        }

                        var name = nameField.text.trim() || url;
                        var feed = { name: name, url: url };

                        var currentFeeds = root.loadValue("feeds", []);
                        if (root.editingIndex === -1) {
                            currentFeeds = currentFeeds.concat([feed]);
                        } else {
                            currentFeeds[root.editingIndex] = feed;
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
                        nameField.text = "";
                        urlField.text = "";
                    }
                }
            }
        }
    }

    // Existing feeds list
    StyledRect {
        width: parent.width
        height: Math.max(120, feedsListColumn.implicitHeight + Theme.spacingL * 2)
        radius: Theme.cornerRadius
        color: Theme.surfaceContainerHigh

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
                                color: Theme.surfaceText
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
                        }

                        // Edit button
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
                                    var feed = root.loadValue("feeds", [])[index];
                                    nameField.text = feed.name || "";
                                    urlField.text = feed.url || "";
                                    root.ensureItemVisible(nameField);
                                }
                            }
                        }

                        // Delete button
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

                // Empty state
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

    StyledRect {
        width: parent.width
        height: 1
        color: Theme.outlineVariant
    }

    // ─── Preset Feeds ───

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

    Flow {
        width: parent.width
        spacing: Theme.spacingS

        DankButton {
            text: "Hacker News"
            iconName: "add"
            onClicked: addPresetFeed("Hacker News", "https://hnrss.org/newest")
        }

        DankButton {
            text: "Reddit r/linux"
            iconName: "add"
            onClicked: addPresetFeed("r/linux", "https://www.reddit.com/r/linux/.rss")
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

    function addPresetFeed(name, url) {
        var currentFeeds = root.loadValue("feeds", []);
        // Check for duplicate URL
        for (var i = 0; i < currentFeeds.length; i++) {
            if (currentFeeds[i].url === url) {
                if (typeof ToastService !== "undefined") {
                    ToastService.showError("Feed already added");
                }
                return;
            }
        }
        currentFeeds = currentFeeds.concat([{ name: name, url: url }]);
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
