// Pure interest-ranking helpers for the Dank RSS Widget (backlog 3d).
//
// Shared with QML/Node like FeedParser.js and ReaderState.js — see
// docs/wiki/Architecture.md for the dual-load mechanism and the two rules
// that break it (no `.pragma library`, no `require()`ing a sibling module).
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now() reads
// (callers inject "now"), no randomness, no mutation of arguments.
//
// Design note (owner's words, docs/plans/BACKLOG.md 3d): "ranking that feels
// wrong is worse than no ranking, so it ships default-off with a visible
// reason and an obvious way back to reverse-chronological." Every threshold
// below exists to serve that sentence, not to squeeze out a better score.

// Minimum number of starred items before a profile is considered meaningful.
// Below this, cosine similarity to a 1-2 item centroid is mostly noise: a
// single star pins the "profile" to one article's idiosyncratic vocabulary,
// not a genuine interest. 5 is a defensible floor — enough that one outlier
// star cannot dominate the mean, small enough that an engaged-but-new reader
// reaches it in day one. Rejected alternative: scaling a "confidence" score
// continuously with star count instead of a hard cutoff — rejected because
// the backlog explicitly wants ranking OFF, not merely "ranking, but with an
// unreadable low-confidence label"; a hard gate is what "must not be offered
// at all" means as code.
var MIN_STARRED_FOR_PROFILE = 5;

// Cap on how many starred vectors feed the centroid. Without a cap, a reader
// who has starred 2,000 items would give recent taste shifts near-zero
// influence, since the centroid barely moves once averaged over that many
// items. 200 was chosen because it comfortably covers "a dedicated reader's
// starred backlog" while keeping the centroid responsive to the last few
// months of taste rather than years of it. Rejected alternative: no cap
// (simplest, but taste-drift-blind) and a tiny cap like 20 (too reactive to a
// short binge on one topic).
var MAX_STARRED_FOR_PROFILE = 200;

// Default recency half-life, in days, used only by buildInterestProfile's
// optional recency weighting and by blendWithRecency's decay. 14 days is a
// guess at "roughly two reading-cycles ago is half as relevant as today",
// picked because RSS reading is bursty (a reader away for a week should not
// have their whole profile treated as stale). Documented explicitly so a
// future reader can replace it with a measured value instead of re-deriving
// the guess.
var DEFAULT_HALF_LIFE_DAYS = 14;
var MS_PER_DAY = 24 * 60 * 60 * 1000;

// Default blend weight for blendWithRecency: how much similarity influences
// final order versus pure recency. 0 is the safe, always-available default
// (see rankItems/blendWithRecency below) — callers that want blending opt in
// explicitly. Kept here only as a named constant for anyone wiring a UI
// slider default; rankItems/blendWithRecency never assume it themselves.
var DEFAULT_BLEND_WEIGHT = 0.5;

// --- cosineSimilarity -------------------------------------------------

// Cosine similarity of two numeric vectors, in [-1, 1].
//
// Documented edge-case behaviour (all chosen to avoid NaN ever reaching a
// sort comparator — an NaN in a comparator silently corrupts the whole
// ordering, exactly the "feels wrong" failure this feature must avoid):
//   - empty arrays, non-array input, or mismatched lengths -> 0 (treated as
//     "no evidence of similarity", not "maximally dissimilar" -1, since a
//     length mismatch is a data problem, not a signal).
//   - either vector all-zero (no direction) -> 0, documented as "a zero
//     vector has no direction, so it is defined as orthogonal to everything"
//     rather than throwing or returning NaN from a 0/0 division.
//   - non-numeric entries (NaN, strings, null, undefined) -> that component
//     contributes 0 to every sum rather than poisoning the whole computation
//     with NaN.
function cosineSimilarity(a, b) {
    if (!isVector(a) || !isVector(b)) {
        return 0;
    }
    if (a.length === 0 || b.length === 0 || a.length !== b.length) {
        return 0;
    }

    var dot = 0;
    var magA = 0;
    var magB = 0;
    for (var i = 0; i < a.length; i++) {
        var av = numericOr0(a[i]);
        var bv = numericOr0(b[i]);
        dot += av * bv;
        magA += av * av;
        magB += bv * bv;
    }

    if (magA === 0 || magB === 0) {
        // A zero vector has no direction to compare — defined as orthogonal
        // (0), not undefined/NaN, so callers can sort on it safely.
        return 0;
    }

    var sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
    // Guard floating-point overshoot (e.g. 1.0000000000000002) so callers
    // never see a value outside the documented [-1, 1] contract.
    if (sim > 1) return 1;
    if (sim < -1) return -1;
    return sim;
}

function isVector(v) {
    return !!v && typeof v.length === "number";
}

function numericOr0(v) {
    return (typeof v === "number" && !isNaN(v)) ? v : 0;
}

// --- buildInterestProfile ----------------------------------------------

// Build the vector representing "what this user likes" from their starred
// items' embeddings.
//
// Approach: normalised centroid (mean of the starred vectors, then
// normalised to unit length) of the most recent MAX_STARRED_FOR_PROFILE
// stars. Normalising the centroid — rather than leaving its magnitude as a
// side effect of the star count — keeps cosineSimilarity(profile, item)
// comparable across users regardless of how many items they have starred.
//
// Rejected alternative: a weighted centroid that discounts older stars
// continuously (e.g. exponential decay by star age) as the *default*.
// Recency-weighting is offered as an opt-in (`options.recencyWeighted` with
// `starredAt` timestamps) rather than the default, because it adds a second
// silent judgement call (the half-life) on top of the cap, and the backlog
// explicitly asks for the simplest thing that is not obviously wrong first.
// The cap above already bounds staleness; full decay is left for a future
// iteration if the plain centroid proves to drift too slowly in practice.
//
// options:
//   - maxItems: override MAX_STARRED_FOR_PROFILE
//   - minItems: override MIN_STARRED_FOR_PROFILE (cold-start floor)
//   - recencyWeighted: boolean, opt-in decay weighting (default false)
//   - halfLifeDays: override DEFAULT_HALF_LIFE_DAYS
//   - now: inject "now" in epoch ms (required when recencyWeighted is true;
//     never read from a clock internally — pure-module rule)
//
// starredVectors: array of { vector: number[], starredAt?: epoch-ms }
//
// Returns { profile: number[] | null, reason: string, count: number }.
// `profile` is null below the cold-start floor so callers can detect it
// and must not offer ranking at all (per the backlog's "must not be offered
// at all" requirement) — the reason string says why.
function buildInterestProfile(starredVectors, options) {
    var opts = options || {};
    var minItems = (typeof opts.minItems === "number") ? opts.minItems : MIN_STARRED_FOR_PROFILE;
    var maxItems = (typeof opts.maxItems === "number") ? opts.maxItems : MAX_STARRED_FOR_PROFILE;

    var entries = (starredVectors && typeof starredVectors.length === "number") ? starredVectors : [];
    var valid = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e && isVector(e.vector) && e.vector.length > 0) {
            valid.push(e);
        }
    }

    if (valid.length < minItems) {
        return {
            profile: null,
            reason: "not_enough_starred",
            count: valid.length
        };
    }

    // Most recent first, then cap — "most recent N stars", not "first N
    // encountered", so the caller's array order does not matter.
    var ordered = valid.slice();
    ordered.sort(function (x, y) {
        return numericOr0(y.starredAt) - numericOr0(x.starredAt);
    });
    if (ordered.length > maxItems) {
        ordered = ordered.slice(0, maxItems);
    }

    var recencyWeighted = !!opts.recencyWeighted;
    var halfLifeDays = (typeof opts.halfLifeDays === "number") ? opts.halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
    var now = (typeof opts.now === "number") ? opts.now : null;

    var dims = ordered[0].vector.length;
    var sum = new Array(dims);
    for (var d = 0; d < dims; d++) sum[d] = 0;

    var totalWeight = 0;
    for (var j = 0; j < ordered.length; j++) {
        var vec = ordered[j].vector;
        var weight = 1;
        if (recencyWeighted && now !== null && typeof ordered[j].starredAt === "number") {
            var ageDays = (now - ordered[j].starredAt) / MS_PER_DAY;
            if (ageDays < 0) ageDays = 0;
            weight = Math.pow(0.5, ageDays / halfLifeDays);
        }
        totalWeight += weight;
        for (var k = 0; k < dims && k < vec.length; k++) {
            sum[k] += numericOr0(vec[k]) * weight;
        }
    }

    var mean = new Array(dims);
    for (var m = 0; m < dims; m++) {
        mean[m] = totalWeight > 0 ? sum[m] / totalWeight : 0;
    }

    // Normalise to unit length; a zero-magnitude mean (e.g. perfectly
    // cancelling vectors) is defensively left as the zero vector rather than
    // dividing by zero — cosineSimilarity already defines 0 as "no
    // direction" for that case, so downstream ranking degrades gracefully.
    var mag = 0;
    for (var n = 0; n < dims; n++) mag += mean[n] * mean[n];
    mag = Math.sqrt(mag);
    var profile = new Array(dims);
    for (var p = 0; p < dims; p++) {
        profile[p] = mag > 0 ? mean[p] / mag : 0;
    }

    return {
        profile: profile,
        reason: "ok",
        count: valid.length
    };
}

// --- rankItems -----------------------------------------------------------

// Rank items by similarity of their vector to the profile. Returns a NEW
// array; `items` is never mutated.
//
// Each output entry: { item, score, hasVector, id, timestamp }
//   - score is cosine similarity in [-1, 1], or null when the item has no
//     vector (see below).
//
// Items with no entry in vectorsById are NOT dropped (silently vanishing
// items is its own "feels wrong" failure — a reader would wonder where an
// article went). They are kept with score: null and sorted to the END of
// the ranked list, after every scored item, since "we have no evidence this
// is relevant" is a worse bet than any actual similarity score including a
// negative one.
//
// Deterministic tie-breaks (so a refresh with identical scores never
// reshuffles the visible order): score desc, then timestamp desc (newest
// first), then id ascending (stable final fallback since ids are unique).
//
// options:
//   - getId(item) -> string (default: item.id)
//   - getTimestamp(item) -> number, epoch ms (default: item.timestamp)
function rankItems(items, vectorsById, profile, options) {
    var opts = options || {};
    var getId = opts.getId || function (it) { return it && it.id; };
    var getTimestamp = opts.getTimestamp || function (it) { return numericOr0(it && it.timestamp); };

    var list = (items && typeof items.length === "number") ? items : [];
    var vmap = vectorsById || {};

    var ranked = [];
    for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var id = getId(item);
        var vector = (id !== undefined && id !== null) ? vmap[id] : undefined;
        var hasVector = isVector(vector) && vector.length > 0;
        var score = null;
        if (hasVector && profile) {
            score = cosineSimilarity(vector, profile);
        }
        ranked.push({
            item: item,
            score: score,
            hasVector: hasVector,
            id: id,
            timestamp: getTimestamp(item)
        });
    }

    ranked.sort(function (x, y) {
        // Unscored items sort after every scored item, regardless of score
        // sign — see doc comment above.
        var xScored = x.score !== null;
        var yScored = y.score !== null;
        if (xScored !== yScored) {
            return xScored ? -1 : 1;
        }
        if (xScored && yScored && x.score !== y.score) {
            return y.score - x.score;
        }
        if (x.timestamp !== y.timestamp) {
            return y.timestamp - x.timestamp;
        }
        var xid = x.id === undefined || x.id === null ? "" : String(x.id);
        var yid = y.id === undefined || y.id === null ? "" : String(y.id);
        if (xid < yid) return -1;
        if (xid > yid) return 1;
        return 0;
    });

    return ranked;
}

// --- explainRank ---------------------------------------------------------

// Facts behind why an item ranked where it did, for the UI to word however
// it likes (per the backlog's "visible reason" requirement). This module
// deals only in structured facts, never in pre-baked English, so wording
// changes never touch this file.
//
// rankedItem: one entry from rankItems' output ({ item, score, id, ... }).
// options:
//   - starredVectors: array of { id, vector, starredAt? } — the candidate
//     "nearest starred" pool.
//   - itemVector: the ranked item's own vector (pass explicitly; this
//     module never looks it up, to keep the function's inputs self-
//     contained and side-effect free).
//   - topN: how many nearest starred ids to return (default 3).
//
// Returns:
//   { score, nearest: [{ id, similarity }, ...] }
// sorted by similarity desc, deterministic tie-break on id ascending so a
// constructed unambiguous case always returns the same order.
// When itemVector or starredVectors is missing/empty, nearest is [].
function explainRank(rankedItem, options) {
    var opts = options || {};
    var topN = (typeof opts.topN === "number") ? opts.topN : 3;
    var itemVector = opts.itemVector;
    var starred = (opts.starredVectors && typeof opts.starredVectors.length === "number") ? opts.starredVectors : [];

    var score = (rankedItem && typeof rankedItem.score === "number") ? rankedItem.score : null;

    var nearest = [];
    if (isVector(itemVector) && itemVector.length > 0) {
        for (var i = 0; i < starred.length; i++) {
            var s = starred[i];
            if (!s || !isVector(s.vector) || s.vector.length === 0) continue;
            nearest.push({
                id: s.id,
                similarity: cosineSimilarity(itemVector, s.vector)
            });
        }
        nearest.sort(function (a, b) {
            if (a.similarity !== b.similarity) return b.similarity - a.similarity;
            var aid = a.id === undefined || a.id === null ? "" : String(a.id);
            var bid = b.id === undefined || b.id === null ? "" : String(b.id);
            if (aid < bid) return -1;
            if (aid > bid) return 1;
            return 0;
        });
        if (nearest.length > topN) {
            nearest = nearest.slice(0, topN);
        }
    }

    return {
        score: score,
        nearest: nearest
    };
}

// --- blendWithRecency ------------------------------------------------

// Mix similarity score with recency so a highly-similar-but-stale item does
// not permanently bury fresh reverse-chronological reading.
//
// finalScore = weight * normalisedSimilarity + (1 - weight) * normalisedRecency
//
// where both components are normalised into [0, 1] before blending so
// `weight` has a consistent meaning regardless of the raw similarity range.
//
// weight is an explicit, required-to-reason-about parameter:
//   - weight: 0..1, default DEFAULT_BLEND_WEIGHT (0.5). 0.5 was picked as
//     "similarity and recency matter equally" — the least opinionated
//     default available, leaving the actual tuning to the UI's slider
//     rather than baking in an unverified preference here.
//
// **weight: 0 MUST exactly reproduce reverse-chronological order** — this is
// the backlog's "obvious way back" requirement made mechanical. Rather than
// relying on a 0-times-similarity term to vanish (fragile if similarity is
// ever NaN or unbounded), weight 0 short-circuits to sort purely by
// timestamp desc, id asc — bypassing the similarity/recency blend maths
// entirely so no floating-point term can leak through.
//
// Items with score: null (no vector) are treated the same way rankItems
// treats them: recency is still computed and used as their sole signal
// (never left as NaN/undefined), so they participate in the blend rather
// than being silently dropped.
//
// options:
//   - weight: 0..1 (default 0.5)
//   - now: epoch ms "now" for recency normalisation (default: newest
//     timestamp in the list, so recency is relative to the freshest item
//     rather than requiring a clock read)
//   - halfLifeDays: recency decay half-life (default DEFAULT_HALF_LIFE_DAYS)
function blendWithRecency(ranked, options) {
    var opts = options || {};
    var weight = (typeof opts.weight === "number") ? opts.weight : DEFAULT_BLEND_WEIGHT;
    var list = (ranked && typeof ranked.length === "number") ? ranked : [];

    // Copy defensively; never mutate the input array or its entries.
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        out.push({
            item: entry.item,
            score: entry.score,
            hasVector: entry.hasVector,
            id: entry.id,
            timestamp: entry.timestamp
        });
    }

    if (weight === 0) {
        // Short-circuit: pure reverse-chronological, byte-for-byte the same
        // tie-break rule as rankItems, so this is a genuine "no ranking"
        // fallback rather than an approximation of one.
        out.sort(function (x, y) {
            if (x.timestamp !== y.timestamp) return y.timestamp - x.timestamp;
            var xid = x.id === undefined || x.id === null ? "" : String(x.id);
            var yid = y.id === undefined || y.id === null ? "" : String(y.id);
            if (xid < yid) return -1;
            if (xid > yid) return 1;
            return 0;
        });
        for (var a = 0; a < out.length; a++) {
            out[a].blendedScore = null;
        }
        return out;
    }

    var halfLifeDays = (typeof opts.halfLifeDays === "number") ? opts.halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
    var now = (typeof opts.now === "number") ? opts.now : null;
    if (now === null) {
        var maxTs = null;
        for (var b = 0; b < out.length; b++) {
            if (maxTs === null || out[b].timestamp > maxTs) maxTs = out[b].timestamp;
        }
        now = maxTs === null ? 0 : maxTs;
    }

    for (var j = 0; j < out.length; j++) {
        var ageDays = (now - out[j].timestamp) / MS_PER_DAY;
        if (ageDays < 0) ageDays = 0;
        var recencyScore = Math.pow(0.5, ageDays / halfLifeDays); // in (0, 1]

        // Similarity is in [-1, 1]; normalise to [0, 1] so it blends with
        // recencyScore on the same scale. A null (no-vector) score is
        // treated as 0 similarity (neutral, not penalised further beyond
        // what the missing evidence already implies).
        var rawSim = (typeof out[j].score === "number") ? out[j].score : 0;
        var simScore = (rawSim + 1) / 2;

        out[j].blendedScore = weight * simScore + (1 - weight) * recencyScore;
    }

    out.sort(function (x, y) {
        if (x.blendedScore !== y.blendedScore) return y.blendedScore - x.blendedScore;
        if (x.timestamp !== y.timestamp) return y.timestamp - x.timestamp;
        var xid = x.id === undefined || x.id === null ? "" : String(x.id);
        var yid = y.id === undefined || y.id === null ? "" : String(y.id);
        if (xid < yid) return -1;
        if (xid > yid) return 1;
        return 0;
    });

    return out;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        MIN_STARRED_FOR_PROFILE: MIN_STARRED_FOR_PROFILE,
        MAX_STARRED_FOR_PROFILE: MAX_STARRED_FOR_PROFILE,
        DEFAULT_HALF_LIFE_DAYS: DEFAULT_HALF_LIFE_DAYS,
        DEFAULT_BLEND_WEIGHT: DEFAULT_BLEND_WEIGHT,
        cosineSimilarity: cosineSimilarity,
        buildInterestProfile: buildInterestProfile,
        rankItems: rankItems,
        explainRank: explainRank,
        blendWithRecency: blendWithRecency
    };
}
