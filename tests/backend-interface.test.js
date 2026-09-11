// Every backend is called POSITIONALLY by DankRssWidget.qml, which does not
// know which one it holds -- that is the entire point of Phase 0. So the
// signatures must not drift apart.
//
// This exists because they DID drift: GoogleReader needed a `session` and a
// `currentlyStarred`, and adding them only there left Miniflux's
// markReadRequest(config, ids) silently binding `session` to `ids`. Nothing
// would have thrown; mark-as-read would just have stopped working, which is
// exactly the class of bug this project already shipped once.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const FeedParser = require("../FeedParser.js");
const ReaderState = require("../ReaderState.js");
const GoogleReader = require("../GoogleReader.js");
const { createBackends } = require("../Backends.js");

const backends = createBackends({ FeedParser, ReaderState, GoogleReader });

// The contract every backend must satisfy, as { method: arity }.
const CONTRACT = {
    fetchRequests: 2,        // (config, session)
    markReadRequest: 3,      // (config, session, ids)
    markUnreadRequest: 3,    // (config, session, ids)
    toggleStarRequest: 4,    // (config, session, id, currentlyStarred)
    configState: 1,          // (config)
    reconcile: 2             // (localState, serverEntries)
};

describe("backend interface uniformity", () => {
    const ids = Object.keys(backends);

    test("every expected backend is registered", () => {
        assert.deepEqual(ids.sort(), ["greader", "miniflux", "standard"]);
    });

    ids.forEach((id) => {
        describe(id, () => {
            Object.keys(CONTRACT).forEach((method) => {
                test(`${method} exists and takes ${CONTRACT[method]} arguments`, () => {
                    const fn = backends[id][method];
                    assert.equal(typeof fn, "function", `${id}.${method} must exist`);
                    assert.equal(
                        fn.length, CONTRACT[method],
                        `${id}.${method} declares ${fn.length} params, contract says ` +
                        `${CONTRACT[method]}. A positional caller would bind the wrong ` +
                        `argument -- declare unused params rather than omitting them.`
                    );
                });
            });

            test("capabilities has exactly the expected flags", () => {
                assert.deepEqual(
                    Object.keys(backends[id].capabilities).sort(),
                    ["categories", "fullText", "serverState", "star", "subscribe"]
                );
            });

            test("id matches its registry key", () => {
                assert.equal(backends[id].id, id);
            });
        });
    });

    test("createBackends without GoogleReader still works, minus greader", () => {
        const two = createBackends({ FeedParser, ReaderState });
        assert.deepEqual(Object.keys(two).sort(), ["miniflux", "standard"]);
    });
});
