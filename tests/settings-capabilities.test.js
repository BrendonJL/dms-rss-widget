// Pins the capability -> section-visibility mapping that
// DankRssWidgetSettings.qml is supposed to implement (stage 1c). It cannot
// prove the QML actually reads `capabilities.serverState` correctly -- that
// needs a human clicking through all three modes -- but it does mean a
// future capability change (e.g. a fourth backend, or serverState flipping
// on an existing one) has to confront this table instead of silently
// drifting from what the settings panel shows.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const FeedParser = require("../FeedParser.js");
const ReaderState = require("../ReaderState.js");
const GoogleReader = require("../GoogleReader.js");
const { createBackends } = require("../Backends.js");

const backends = createBackends({ FeedParser, ReaderState, GoogleReader });

// Mirrors DankRssWidgetSettings.qml's own visibility rules:
//   Feed Management, OPML Import, Quick Add   -> !capabilities.serverState
//   Subscription list (read-only)             -> capabilities.serverState
function expectedVisibility(backendId) {
    const serverState = backends[backendId].capabilities.serverState;
    return {
        feedManagement: !serverState,
        opmlImport: !serverState,
        quickAdd: !serverState,
        subscriptionList: serverState
    };
}

describe("settings panel section visibility, derived from capabilities", () => {
    test("every registered backend is covered", () => {
        assert.deepEqual(Object.keys(backends).sort(), ["greader", "miniflux", "standard"]);
    });

    test("standard: local-feed sections shown, server subscription list hidden", () => {
        assert.deepEqual(expectedVisibility("standard"), {
            feedManagement: true,
            opmlImport: true,
            quickAdd: true,
            subscriptionList: false
        });
    });

    test("miniflux: server subscription list shown, local-feed sections hidden", () => {
        assert.deepEqual(expectedVisibility("miniflux"), {
            feedManagement: false,
            opmlImport: false,
            quickAdd: false,
            subscriptionList: true
        });
    });

    test("greader: same shape as miniflux -- both are serverState backends", () => {
        assert.deepEqual(expectedVisibility("greader"), expectedVisibility("miniflux"));
        assert.deepEqual(expectedVisibility("greader"), {
            feedManagement: false,
            opmlImport: false,
            quickAdd: false,
            subscriptionList: true
        });
    });
});
