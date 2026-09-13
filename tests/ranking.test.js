const { test, describe } = require("node:test");
const assert = require("node:assert");

const Rank = require("../Ranking.js");

describe("cosineSimilarity", () => {
    test("identical vectors score 1", () => {
        assert.equal(Rank.cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
    });

    test("opposite vectors score -1", () => {
        assert.equal(Rank.cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
    });

    test("orthogonal vectors score 0", () => {
        assert.equal(Rank.cosineSimilarity([1, 0], [0, 1]), 0);
    });

    test("a zero vector has no direction and scores 0, not NaN", () => {
        assert.equal(Rank.cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
        assert.equal(Rank.cosineSimilarity([0, 0], [0, 0]), 0);
    });

    test("mismatched length returns 0 rather than throwing", () => {
        assert.equal(Rank.cosineSimilarity([1, 2, 3], [1, 2]), 0);
    });

    test("non-numeric entries are treated as 0, never NaN", () => {
        var sim = Rank.cosineSimilarity([1, "x", null], [1, 2, 3]);
        assert.equal(Number.isNaN(sim), false);
        assert.equal(sim, Rank.cosineSimilarity([1, 0, 0], [1, 2, 3]));
    });

    test("empty arrays return 0", () => {
        assert.equal(Rank.cosineSimilarity([], []), 0);
    });

    test("non-array input returns 0 rather than throwing", () => {
        assert.equal(Rank.cosineSimilarity(null, [1, 2]), 0);
        assert.equal(Rank.cosineSimilarity(undefined, undefined), 0);
    });
});

describe("buildInterestProfile", () => {
    test("cold start below the minimum returns a detectable no-profile result", () => {
        var starred = [
            { vector: [1, 0] },
            { vector: [1, 0] }
        ];
        var result = Rank.buildInterestProfile(starred);
        assert.equal(result.profile, null);
        assert.equal(result.reason, "not_enough_starred");
        assert.equal(result.count, 2);
    });

    test("zero starred items also returns no profile, not a throw", () => {
        var result = Rank.buildInterestProfile([]);
        assert.equal(result.profile, null);
        assert.equal(result.reason, "not_enough_starred");
    });

    test("at the minimum count, returns a normalised centroid", () => {
        var starred = [
            { vector: [1, 0] },
            { vector: [1, 0] },
            { vector: [1, 0] },
            { vector: [1, 0] },
            { vector: [1, 0] }
        ];
        var result = Rank.buildInterestProfile(starred);
        assert.notEqual(result.profile, null);
        assert.equal(result.reason, "ok");
        // Unit-length centroid of identical [1,0] vectors is [1,0].
        assert.equal(result.profile[0], 1);
        assert.equal(result.profile[1], 0);
    });

    test("does not mutate the starredVectors input", () => {
        var starred = [
            { vector: [1, 0] },
            { vector: [0, 1] },
            { vector: [1, 1] },
            { vector: [1, 0] },
            { vector: [0, 1] }
        ];
        var copy = JSON.parse(JSON.stringify(starred));
        Rank.buildInterestProfile(starred);
        assert.deepEqual(starred, copy);
    });

    test("a custom minItems option lowers or raises the cold-start floor", () => {
        var starred = [{ vector: [1, 0] }, { vector: [1, 0] }];
        var result = Rank.buildInterestProfile(starred, { minItems: 2 });
        assert.notEqual(result.profile, null);
    });
});

describe("rankItems", () => {
    var profile = [1, 0];

    function item(id, timestamp) {
        return { id: id, timestamp: timestamp, title: "item " + id };
    }

    test("ranks by similarity, most similar first", () => {
        var items = [item("a", 100), item("b", 200), item("c", 300)];
        var vectors = {
            a: [0, 1],   // orthogonal -> 0
            b: [1, 0],   // identical -> 1
            c: [0.7, 0.7] // partial
        };
        var ranked = Rank.rankItems(items, vectors, profile);
        assert.deepEqual(ranked.map(function (r) { return r.id; }), ["b", "c", "a"]);
    });

    test("items lacking a vector are kept, not dropped, and sorted after all scored items", () => {
        var items = [item("a", 100), item("novec", 999), item("b", 200)];
        var vectors = {
            a: [1, 0],
            b: [0, 1]
        };
        var ranked = Rank.rankItems(items, vectors, profile);
        assert.equal(ranked.length, 3);
        var novecEntry = ranked.filter(function (r) { return r.id === "novec"; })[0];
        assert.equal(novecEntry.score, null);
        assert.equal(novecEntry.hasVector, false);
        // Unscored item must be last despite having the newest timestamp.
        assert.equal(ranked[ranked.length - 1].id, "novec");
    });

    test("deterministic tie-break falls back to timestamp then id", () => {
        var items = [item("z", 100), item("a", 100), item("m", 200)];
        var vectors = {
            z: [1, 0],
            a: [1, 0],
            m: [1, 0]
        };
        // All identical vectors -> identical scores; m has newest timestamp,
        // then z/a tie on timestamp and break on id ascending.
        var ranked = Rank.rankItems(items, vectors, profile);
        assert.deepEqual(ranked.map(function (r) { return r.id; }), ["m", "a", "z"]);
    });

    test("ranking is deterministic across repeated calls on equal scores", () => {
        var items = [item("z", 100), item("a", 100), item("b", 100)];
        var vectors = { z: [1, 0], a: [1, 0], b: [1, 0] };
        var first = Rank.rankItems(items, vectors, profile).map(function (r) { return r.id; });
        var second = Rank.rankItems(items, vectors, profile).map(function (r) { return r.id; });
        var third = Rank.rankItems(items, vectors, profile).map(function (r) { return r.id; });
        assert.deepEqual(first, second);
        assert.deepEqual(second, third);
    });

    test("does not mutate the items input array or its entries", () => {
        var items = [item("a", 100), item("b", 200)];
        var copy = JSON.parse(JSON.stringify(items));
        Rank.rankItems(items, { a: [1, 0], b: [0, 1] }, profile);
        assert.deepEqual(items, copy);
    });

    test("returns a new array, not the original items array", () => {
        var items = [item("a", 100)];
        var ranked = Rank.rankItems(items, { a: [1, 0] }, profile);
        assert.notEqual(ranked, items);
    });
});

describe("explainRank", () => {
    test("returns the nearest starred ids for an unambiguous constructed case", () => {
        var itemVector = [1, 0];
        var starredVectors = [
            { id: "s1", vector: [1, 0] },   // identical -> 1
            { id: "s2", vector: [0, 1] },   // orthogonal -> 0
            { id: "s3", vector: [-1, 0] }   // opposite -> -1
        ];
        var explanation = Rank.explainRank(
            { score: 1 },
            { itemVector: itemVector, starredVectors: starredVectors, topN: 2 }
        );
        assert.equal(explanation.score, 1);
        assert.equal(explanation.nearest.length, 2);
        assert.equal(explanation.nearest[0].id, "s1");
        assert.equal(explanation.nearest[0].similarity, 1);
        assert.equal(explanation.nearest[1].id, "s2");
    });

    test("returns empty nearest list when the item has no vector", () => {
        var explanation = Rank.explainRank(
            { score: null },
            { starredVectors: [{ id: "s1", vector: [1, 0] }] }
        );
        assert.deepEqual(explanation.nearest, []);
    });

    test("returns structured facts, not a pre-baked sentence", () => {
        var explanation = Rank.explainRank(
            { score: 0.5 },
            { itemVector: [1, 0], starredVectors: [{ id: "s1", vector: [1, 0] }] }
        );
        assert.equal(typeof explanation, "object");
        assert.equal(typeof explanation.nearest[0].id, "string");
        assert.equal(typeof explanation.nearest[0].similarity, "number");
    });
});

describe("blendWithRecency", () => {
    function ranked(id, score, timestamp) {
        return { item: { id: id }, score: score, hasVector: score !== null, id: id, timestamp: timestamp };
    }

    test("weight 0 exactly reproduces reverse-chronological order even when similarity disagrees", () => {
        // Construct a fixture where similarity ranking and recency ranking
        // disagree: "old" has the best similarity score but is the oldest
        // item, "new" has the worst similarity but is newest.
        var input = [
            ranked("old", 0.99, 1000),
            ranked("mid", 0.5, 2000),
            ranked("new", -0.9, 3000)
        ];
        var blended = Rank.blendWithRecency(input, { weight: 0 });
        assert.deepEqual(
            blended.map(function (r) { return r.id; }),
            ["new", "mid", "old"],
            "weight 0 must be pure reverse-chronological regardless of similarity"
        );
    });

    test("weight 0 tie-breaks by id ascending when timestamps are equal", () => {
        var input = [ranked("z", 0.9, 500), ranked("a", 0.1, 500)];
        var blended = Rank.blendWithRecency(input, { weight: 0 });
        assert.deepEqual(blended.map(function (r) { return r.id; }), ["a", "z"]);
    });

    test("a positive weight can surface a highly similar older item above a dissimilar newer one", () => {
        var input = [
            ranked("old", 1, 1000),
            ranked("new", -1, 100000)
        ];
        var blended = Rank.blendWithRecency(input, { weight: 1, now: 100000 });
        assert.equal(blended[0].id, "old");
    });

    test("items with no vector (null score) still participate, not dropped", () => {
        var input = [
            ranked("scored", 0.5, 1000),
            ranked("novec", null, 2000)
        ];
        var blended = Rank.blendWithRecency(input, { weight: 0.5, now: 2000 });
        assert.equal(blended.length, 2);
    });

    test("does not mutate the input ranked array or its entries", () => {
        var input = [ranked("a", 0.5, 1000), ranked("b", 0.1, 2000)];
        var copy = JSON.parse(JSON.stringify(input));
        Rank.blendWithRecency(input, { weight: 0.5 });
        assert.deepEqual(input, copy);
    });
});

describe("input immutability across the module", () => {
    test("cosineSimilarity never mutates its arguments", () => {
        var a = [1, 2, 3];
        var b = [4, 5, 6];
        Rank.cosineSimilarity(a, b);
        assert.deepEqual(a, [1, 2, 3]);
        assert.deepEqual(b, [4, 5, 6]);
    });
});

// ─── the shape the widget actually passes ───
//
// Regression cover for a silent interface mismatch. buildInterestProfile takes
// { vector, starredAt } objects; the widget passed the raw vectors. Every
// entry then failed `isVector(e.vector)`, valid.length came back 0, and a user
// with eight starred articles was told indefinitely that they had not starred
// enough. Both shapes are arrays of the right length, so nothing threw and
// nothing logged -- the only symptom was a feature that never turned on.
//
// These tests exercise the call exactly as DankRssWidget.applyRanking makes it.

describe("buildInterestProfile input shape (as the widget calls it)", () => {
    const R = require("../Ranking.js");
    const vec = (seed) => Array.from({ length: 8 }, (_, i) => Math.sin(seed + i));
    const asWidgetPasses = (n) => Array.from({ length: n }, (_, i) => ({
        vector: vec(i), starredAt: 1000 - i
    }));

    test("accepts { vector, starredAt } objects and builds a profile", () => {
        const built = R.buildInterestProfile(asWidgetPasses(8));
        assert.ok(built.profile, "profile should build from 8 starred: " + built.reason);
        assert.equal(built.count, 8);
    });

    test("RAW vectors are rejected -- the exact mistake that shipped", () => {
        const raw = Array.from({ length: 8 }, (_, i) => vec(i));
        const built = R.buildInterestProfile(raw);
        assert.equal(built.profile, null);
        assert.equal(built.count, 0,
            "raw vectors must be rejected; if this ever passes, the widget's wrapping is redundant");
    });

    test("the profile is a unit vector of the same dimensionality", () => {
        const built = R.buildInterestProfile(asWidgetPasses(6));
        assert.equal(built.profile.length, 8);
        const mag = Math.sqrt(built.profile.reduce((a, x) => a + x * x, 0));
        assert.ok(Math.abs(mag - 1) < 1e-9, "expected unit length, got " + mag);
    });

    test("one below the minimum still refuses, with the count reported", () => {
        const built = R.buildInterestProfile(asWidgetPasses(R.MIN_STARRED_FOR_PROFILE - 1));
        assert.equal(built.profile, null);
        assert.equal(built.reason, "not_enough_starred");
        assert.equal(built.count, R.MIN_STARRED_FOR_PROFILE - 1);
    });

    test("exactly the minimum succeeds -- the boundary is inclusive", () => {
        const built = R.buildInterestProfile(asWidgetPasses(R.MIN_STARRED_FOR_PROFILE));
        assert.ok(built.profile);
    });

    test("entries with a missing or malformed vector are skipped, not fatal", () => {
        const mixed = asWidgetPasses(6).concat([{ starredAt: 1 }, { vector: "nope", starredAt: 2 }, null]);
        const built = R.buildInterestProfile(mixed);
        assert.ok(built.profile);
        assert.equal(built.count, 6);
    });

    test("the profile feeds rankItems, which takes a plain id->vector map", () => {
        const built = R.buildInterestProfile(asWidgetPasses(6));
        const items = [{ id: "a", timestamp: 2 }, { id: "b", timestamp: 1 }];
        const ranked = R.rankItems(items, { a: vec(0), b: vec(3) }, built.profile);
        assert.equal(ranked.length, 2);
        assert.ok(ranked.every(r => r.hasVector), "both items should score");
        assert.ok(ranked.every(r => typeof r.score === "number" && !isNaN(r.score)));
    });
});
