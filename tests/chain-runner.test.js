const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createChain } = require("../ChainRunner.js");

// A stand-in "descriptor" -- ChainRunner never inspects it, so any value
// works for these tests. Kept distinct per test only for readability.
var HEAD = { argv: ["curl", "head"], meta: { step: "head" } };

function nextParsed(nextRequest, session) {
    return { items: [], serverStatus: [], error: null, nextRequest: nextRequest, session: session || null };
}

function doneParsed(items, serverStatus, session) {
    return { items: items || [], serverStatus: serverStatus || [], error: null, nextRequest: null, session: session || null };
}

function errorParsed(message, session) {
    return { items: [], serverStatus: [], error: message, nextRequest: null, session: session || null };
}

// ─── 1-link chain ───

describe("createChain: 1-link chain", () => {
    test("immediate done terminates on the first step", () => {
        var chain = createChain(HEAD, 5);
        var items = [{ id: "r:1" }];
        var status = [{ id: "r:1", status: "unread", starred: false }];
        var result = chain.step(doneParsed(items, status, { authToken: "a", postToken: "p" }));

        assert.equal(result.action, "done");
        assert.equal(result.request, null);
        assert.deepEqual(result.items, items);
        assert.deepEqual(result.serverStatus, status);
        assert.equal(result.error, null);
        assert.deepEqual(result.session, { authToken: "a", postToken: "p" });
    });

    test("immediate error terminates on the first step", () => {
        var chain = createChain(HEAD, 5);
        var result = chain.step(errorParsed("boom"));

        assert.equal(result.action, "error");
        assert.equal(result.error, "boom");
        assert.equal(result.request, null);
        assert.deepEqual(result.items, []);
    });
});

// ─── 4-link chain (Google Reader's cold start) ───

describe("createChain: 4-link chain (cold start shape)", () => {
    test("ClientLogin -> token -> ids -> contents, one next per link then done", () => {
        var chain = createChain(HEAD, 5);

        var r1 = chain.step(nextParsed({ meta: { step: "token" } }, { authToken: "a", postToken: null }));
        assert.equal(r1.action, "next");
        assert.deepEqual(r1.request, { meta: { step: "token" } });
        assert.deepEqual(r1.session, { authToken: "a", postToken: null });

        var r2 = chain.step(nextParsed({ meta: { step: "itemsIds" } }, { authToken: "a", postToken: "p" }));
        assert.equal(r2.action, "next");
        assert.deepEqual(r2.request, { meta: { step: "itemsIds" } });

        var r3 = chain.step(nextParsed({ meta: { step: "itemsContents" } }, { authToken: "a", postToken: "p" }));
        assert.equal(r3.action, "next");
        assert.deepEqual(r3.request, { meta: { step: "itemsContents" } });

        var r4 = chain.step(doneParsed([{ id: "r:46" }], [], { authToken: "a", postToken: "p" }));
        assert.equal(r4.action, "done");
        assert.deepEqual(r4.items, [{ id: "r:46" }]);
        assert.deepEqual(r4.session, { authToken: "a", postToken: "p" });
    });
});

// ─── error mid-chain ───

describe("createChain: error mid-chain", () => {
    test("an error on a later link terminates the whole chain, not just that link", () => {
        var chain = createChain(HEAD, 5);

        var r1 = chain.step(nextParsed({ meta: { step: "token" } }, { authToken: "a", postToken: null }));
        assert.equal(r1.action, "next");

        var r2 = chain.step(errorParsed("GoogleReader: token request failed", { authToken: "a", postToken: null }));
        assert.equal(r2.action, "error");
        assert.equal(r2.error, "GoogleReader: token request failed");
        assert.deepEqual(r2.session, { authToken: "a", postToken: null });
    });

    test("error takes priority even if nextRequest is also (incorrectly) set", () => {
        var chain = createChain(HEAD, 5);
        var parsed = { items: [], serverStatus: [], error: "bad", nextRequest: { some: "req" }, session: null };
        var result = chain.step(parsed);

        assert.equal(result.action, "error");
        assert.equal(result.request, null);
    });
});

// ─── exceeding the cap ───

describe("createChain: exceeding maxLinks", () => {
    test("a chain that keeps returning nextRequest past the cap ends in error, never next", () => {
        var chain = createChain(HEAD, 2);

        // link 1 (HEAD) -> link 2: still within cap.
        var r1 = chain.step(nextParsed({ id: "link2" }));
        assert.equal(r1.action, "next");

        // link 2 -> link 3: exceeds cap of 2.
        var r2 = chain.step(nextParsed({ id: "link3" }));
        assert.equal(r2.action, "error");
        assert.notEqual(r2.action, "next");
        assert.equal(r2.request, null);
    });

    test("default cap is 5 when maxLinks is omitted", () => {
        var chain = createChain(HEAD);
        var result = null;
        var lastAction = "next";
        for (var i = 0; i < 4 && lastAction === "next"; i++) {
            result = chain.step(nextParsed({ id: "link" + i }));
            lastAction = result.action;
        }
        // 4 more "next" steps after the head (link 1) reaches link 5 --
        // exactly the cap -- so all four must still succeed.
        assert.equal(lastAction, "next");

        var chain2 = createChain(HEAD);
        var results = [];
        for (var j = 0; j < 5; j++) {
            var r = chain2.step(nextParsed({ id: "over" + j }));
            results.push(r.action);
            if (r.action !== "next") break;
        }
        assert.ok(results.indexOf("error") !== -1, "a 5th nextRequest must exceed the default cap of 5");
    });
});

// ─── step after a terminal result ───

describe("createChain: step() after a terminal result", () => {
    test("calling step again after done throws rather than returning a second terminal result", () => {
        var chain = createChain(HEAD, 5);
        var done = chain.step(doneParsed([{ id: "r:1" }]));
        assert.equal(done.action, "done");

        assert.throws(() => chain.step(doneParsed([{ id: "r:2" }])));
    });

    test("calling step again after error throws rather than returning a second terminal result", () => {
        var chain = createChain(HEAD, 5);
        var err = chain.step(errorParsed("boom"));
        assert.equal(err.action, "error");

        assert.throws(() => chain.step(errorParsed("boom again")));
    });

    test("calling step again after the cap-exceeded error also throws", () => {
        var chain = createChain(HEAD, 1);
        var err = chain.step(nextParsed({ id: "too far" }));
        assert.equal(err.action, "error");

        assert.throws(() => chain.step(doneParsed([])));
    });
});

// ─── null / malformed parsed ───

describe("createChain: null/malformed parsed", () => {
    test("null parsed is an error, not a crash", () => {
        var chain = createChain(HEAD, 5);
        var result = chain.step(null);
        assert.equal(result.action, "error");
        assert.ok(typeof result.error === "string" && result.error.length > 0);
    });

    test("undefined parsed is an error, not a crash", () => {
        var chain = createChain(HEAD, 5);
        var result = chain.step(undefined);
        assert.equal(result.action, "error");
    });

    test("a string, number, or array in place of the parsed object is an error, not a crash", () => {
        [42, "oops", [1, 2, 3]].forEach((bad) => {
            var chain = createChain(HEAD, 5);
            var result = chain.step(bad);
            assert.equal(result.action, "error");
        });
    });

    test("an empty object (no error/nextRequest/items) resolves as done with empty items, not a crash", () => {
        var chain = createChain(HEAD, 5);
        var result = chain.step({});
        assert.equal(result.action, "done");
        assert.deepEqual(result.items, []);
        assert.deepEqual(result.serverStatus, []);
    });
});

// ─── property: no chain ever yields two terminal results ───

describe("createChain: no chain ever yields two terminal results", () => {
    var shapes = [
        {
            name: "1-link done",
            maxLinks: 5,
            parses: [doneParsed([{ id: "1" }])]
        },
        {
            name: "1-link error",
            maxLinks: 5,
            parses: [errorParsed("bad")]
        },
        {
            name: "4-link cold start",
            maxLinks: 5,
            parses: [
                nextParsed({ id: "2" }),
                nextParsed({ id: "3" }),
                nextParsed({ id: "4" }),
                doneParsed([{ id: "r:1" }])
            ]
        },
        {
            name: "error mid-chain",
            maxLinks: 5,
            parses: [
                nextParsed({ id: "2" }),
                errorParsed("stale session")
            ]
        },
        {
            name: "exceeds cap",
            maxLinks: 2,
            parses: [
                nextParsed({ id: "2" }),
                nextParsed({ id: "3" }),
                nextParsed({ id: "4" }) // never reached -- chain terminates before this
            ]
        },
        {
            name: "malformed parsed at the head",
            maxLinks: 5,
            parses: [null]
        }
    ];

    shapes.forEach((shape) => {
        test("shape: " + shape.name, () => {
            var chain = createChain(HEAD, shape.maxLinks);
            var terminalCount = 0;
            var sawTerminal = false;

            for (var i = 0; i < shape.parses.length; i++) {
                if (sawTerminal) {
                    // The chain already terminated (or hit the cap) on a
                    // prior step -- any further step() call must throw
                    // rather than silently returning a second terminal.
                    assert.throws(() => chain.step(shape.parses[i]));
                    continue;
                }

                var result = chain.step(shape.parses[i]);
                if (result.action === "done" || result.action === "error") {
                    terminalCount++;
                    sawTerminal = true;
                }
            }

            assert.ok(terminalCount <= 1, "chain '" + shape.name + "' yielded " + terminalCount + " terminal results");
        });
    });
});
