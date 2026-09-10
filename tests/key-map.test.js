const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const KeyMap = require("../KeyMap.js");
const { resolveKey } = KeyMap;

// Base state for a widget with 5 rows, cursor unfocused, nothing pending.
function baseState(overrides) {
    var state = {
        index: -1,
        count: 5,
        searchActive: false,
        hasSelection: false,
        pending: null,
        pendingAt: 0,
        now: 0
    };
    for (var key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key))
            state[key] = overrides[key];
    }
    return state;
}

function evt(key, modifiers) {
    return { key: key, text: "", modifiers: modifiers || 0 };
}

// ─── j / k movement and clamping ───

describe("j/k movement", () => {
    test("j at rest (-1) moves to 0", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({ index: -1 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
    });

    test("j advances the cursor by one", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({ index: 1 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 2);
    });

    test("j clamps at the last index, does not wrap", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({ index: 4, count: 5 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 4);
    });

    test("k moves the cursor back by one", () => {
        var r = resolveKey(evt(KeyMap.Key_K), baseState({ index: 2 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 1);
    });

    test("k clamps at 0, does not wrap", () => {
        var r = resolveKey(evt(KeyMap.Key_K), baseState({ index: 0 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
    });

    test("k at rest (-1) is a no-op, unlike j", () => {
        var r = resolveKey(evt(KeyMap.Key_K), baseState({ index: -1 }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });

    test("j on an empty list is a no-op and stays at -1", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({ index: -1, count: 0 }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });

    test("k on an empty list is a no-op and stays at -1", () => {
        var r = resolveKey(evt(KeyMap.Key_K), baseState({ index: -1, count: 0 }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });
});

// ─── g g (first) / G (last) ───

describe("g g -> first, G -> last", () => {
    test("a lone g arms pending, performs no action", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({ index: 2, pending: null }));
        assert.equal(r.action, null);
        assert.equal(r.pending, "g");
        assert.equal(r.index, 2);
    });

    test("g g within the timeout moves to the first item", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: 3, pending: "g", pendingAt: 100, now: 300
        }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
        assert.equal(r.pending, null);
    });

    test("g g exactly at the 800ms boundary still counts", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: 3, pending: "g", pendingAt: 0, now: 800
        }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
    });

    test("a pending g expires after 800ms -- the second g re-arms instead of firing", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: 3, pending: "g", pendingAt: 0, now: 801
        }));
        assert.equal(r.action, null);
        assert.equal(r.pending, "g");
        assert.equal(r.index, 3);
    });

    test("any other key clears a pending g instead of firing 'first'", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({
            index: 1, pending: "g", pendingAt: 0, now: 10
        }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 2);
        assert.equal(r.pending, null);
    });

    test("G (shift) jumps straight to the last item without needing a pending g", () => {
        var r = resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), baseState({ index: 1, count: 5 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 4);
    });

    // g g and G PLACE a cursor rather than acting on one, so unlike the row
    // actions they must work from rest -- otherwise there is no keyboard route
    // into a list whose cursor has never been set.
    test("g g at rest (-1) jumps to the first item", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: -1, pending: "g", pendingAt: 0, now: 10
        }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
        assert.equal(r.pending, null);
    });

    test("G at rest (-1) jumps to the last item", () => {
        var r = resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), baseState({ index: -1 }));
        assert.equal(r.action, "move");
        assert.equal(r.index, baseState({ index: -1 }).count - 1);
    });

    test("g g on an empty list does not produce an out-of-range index", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: -1, count: 0, pending: "g", pendingAt: 0, now: 10
        }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });

    test("G on an empty list does not produce an out-of-range index", () => {
        var r = resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), baseState({ index: -1, count: 0 }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });
});

// ─── Esc layering ───

describe("Esc layering", () => {
    test("closes search first, even if a selection also exists", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({
            searchActive: true, hasSelection: true, index: 2
        }));
        assert.equal(r.action, "closeSearch");
    });

    test("clears the selection next, if search is not open", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({
            searchActive: false, hasSelection: true, index: 2
        }));
        assert.equal(r.action, "clearSelection");
        assert.equal(r.index, 2);
    });

    test("clears the cursor last, if neither search nor a selection is active", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({
            searchActive: false, hasSelection: false, index: 2
        }));
        assert.equal(r.action, "clearCursor");
        assert.equal(r.index, -1);
    });

    test("is a no-op once every layer is already clear", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({
            searchActive: false, hasSelection: false, index: -1
        }));
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });

    test("one press undoes exactly one layer -- selection survives a search-close", () => {
        var state = baseState({ searchActive: true, hasSelection: true, index: 2 });
        var r1 = resolveKey(evt(KeyMap.Key_Escape), state);
        assert.equal(r1.action, "closeSearch");
        // Caller applies the effect, then the next press acts on the new state.
        var r2 = resolveKey(evt(KeyMap.Key_Escape), baseState({
            searchActive: false, hasSelection: true, index: 2
        }));
        assert.equal(r2.action, "clearSelection");
    });

    test("Esc works even while search is active, unlike other printable keys", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({ searchActive: true, index: -1 }));
        assert.equal(r.action, "closeSearch");
    });

    test("Esc clears a pending g", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState({
            index: 2, pending: "g", pendingAt: 0, now: 10
        }));
        assert.equal(r.pending, null);
    });
});

// ─── Search focus swallows typing ───

describe("search focus swallows printable keys", () => {
    test("j while search is active does not move the cursor -- it must reach the field", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
        assert.equal(r.index, 1);
    });

    test("k while search is active is unhandled", () => {
        var r = resolveKey(evt(KeyMap.Key_K), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("g while search is active does not arm the pending-first state", () => {
        var r = resolveKey(evt(KeyMap.Key_G), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
        assert.equal(r.pending, null);
    });

    test("Space while search is active does not toggle selection", () => {
        var r = resolveKey(evt(KeyMap.Key_Space), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("r while search is active does not refresh", () => {
        var r = resolveKey(evt(KeyMap.Key_R), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("Enter while search is active does not open", () => {
        var r = resolveKey(evt(KeyMap.Key_Return), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("/ while search is active is unhandled (no double-focus)", () => {
        var r = resolveKey(evt(KeyMap.Key_Slash), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("? while search is active is unhandled -- must insert a literal character", () => {
        var r = resolveKey(evt(KeyMap.Key_Question), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });

    test("Shift+/ while search is active is unhandled -- must insert a literal character", () => {
        var r = resolveKey(evt(KeyMap.Key_Slash, KeyMap.ShiftModifier), baseState({ searchActive: true, index: 1 }));
        assert.equal(r.action, null);
    });
});

// ─── Simple one-shot bindings ───

describe("one-shot bindings", () => {
    test("/ focuses search", () => {
        var r = resolveKey(evt(KeyMap.Key_Slash), baseState({ index: 1 }));
        assert.equal(r.action, "focusSearch");
    });

    test("Space toggles selection", () => {
        var r = resolveKey(evt(KeyMap.Key_Space), baseState({ index: 1 }));
        assert.equal(r.action, "toggleSelect");
        assert.equal(r.index, 1);
    });

    test("r refreshes", () => {
        var r = resolveKey(evt(KeyMap.Key_R), baseState({ index: 1 }));
        assert.equal(r.action, "refresh");
    });

    test("A (shift) marks all read", () => {
        var r = resolveKey(evt(KeyMap.Key_A, KeyMap.ShiftModifier), baseState({ index: 1 }));
        assert.equal(r.action, "markAllRead");
    });

    test("a without shift does nothing -- only capital A is bound", () => {
        var r = resolveKey(evt(KeyMap.Key_A), baseState({ index: 1 }));
        assert.equal(r.action, null);
    });

    test("? (Key_Question) toggles the help overlay", () => {
        var r = resolveKey(evt(KeyMap.Key_Question), baseState({ index: 1 }));
        assert.equal(r.action, "toggleHelp");
    });

    test("Shift+/ also toggles the help overlay", () => {
        var r = resolveKey(evt(KeyMap.Key_Slash, KeyMap.ShiftModifier), baseState({ index: 1 }));
        assert.equal(r.action, "toggleHelp");
    });

    test("? toggles help at rest -- cursor-independent", () => {
        var r = resolveKey(evt(KeyMap.Key_Question), baseState({ index: -1 }));
        assert.equal(r.action, "toggleHelp");
    });

    test("? toggles help on an empty list", () => {
        var r = resolveKey(evt(KeyMap.Key_Question), baseState({ index: -1, count: 0 }));
        assert.equal(r.action, "toggleHelp");
    });

    test("m toggles read", () => {
        var r = resolveKey(evt(KeyMap.Key_M), baseState({ index: 1 }));
        assert.equal(r.action, "toggleRead");
    });

    test("s toggles star", () => {
        var r = resolveKey(evt(KeyMap.Key_S), baseState({ index: 1 }));
        assert.equal(r.action, "toggleStar");
    });

    test("o opens", () => {
        var r = resolveKey(evt(KeyMap.Key_O), baseState({ index: 1 }));
        assert.equal(r.action, "open");
    });

    test("Enter (Return) opens", () => {
        var r = resolveKey(evt(KeyMap.Key_Return), baseState({ index: 1 }));
        assert.equal(r.action, "open");
    });

    test("Enter (numpad Enter key code) opens", () => {
        var r = resolveKey(evt(KeyMap.Key_Enter), baseState({ index: 1 }));
        assert.equal(r.action, "open");
    });

    test("an unrecognized key is unhandled", () => {
        var r = resolveKey(evt(0x51 /* Q, not bound */), baseState({ index: 1 }));
        assert.equal(r.action, null);
    });
});

// ─── "m"/"s" act on the whole selection when one exists ───

describe("m/s with a selection act on the selection, not the cursor", () => {
    test("m acts on the selection, not the cursor row", () => {
        var r = resolveKey(evt(KeyMap.Key_M), baseState({ index: 1, hasSelection: true }));
        assert.equal(r.action, "markSelectedRead");
    });

    test("s acts on the selection, not the cursor row", () => {
        var r = resolveKey(evt(KeyMap.Key_S), baseState({ index: 1, hasSelection: true }));
        assert.equal(r.action, "saveSelected");
    });

    test("m acts on the selection even with no cursor (index -1)", () => {
        var r = resolveKey(evt(KeyMap.Key_M), baseState({ index: -1, hasSelection: true }));
        assert.equal(r.action, "markSelectedRead");
    });

    test("s acts on the selection even with no cursor (index -1)", () => {
        var r = resolveKey(evt(KeyMap.Key_S), baseState({ index: -1, hasSelection: true }));
        assert.equal(r.action, "saveSelected");
    });

    test("m falls back to toggleRead on the cursor row once the selection is gone", () => {
        var r = resolveKey(evt(KeyMap.Key_M), baseState({ index: 1, hasSelection: false }));
        assert.equal(r.action, "toggleRead");
    });

    test("s falls back to toggleStar on the cursor row once the selection is gone", () => {
        var r = resolveKey(evt(KeyMap.Key_S), baseState({ index: 1, hasSelection: false }));
        assert.equal(r.action, "toggleStar");
    });
});

// ─── The -1 "nothing focused" rule ───

describe("currentIndex === -1: row actions blocked, cursor-independent ones not", () => {
    var atRest = { index: -1, count: 5 };

    // Row actions would otherwise act on an arbitrary item.
    [
        ["Enter/open", KeyMap.Key_Return, 0],
        ["o", KeyMap.Key_O, 0],
        ["m (toggleRead)", KeyMap.Key_M, 0],
        ["s (toggleStar)", KeyMap.Key_S, 0],
        ["Space (toggleSelect)", KeyMap.Key_Space, 0],
        ["k", KeyMap.Key_K, 0]
    ].forEach(function (row) {
        test(row[0] + " is a no-op at rest", () => {
            var r = resolveKey(evt(row[1], row[2]), baseState(atRest));
            assert.equal(r.action, null);
        });
    });

    // Nothing about these depends on a cursor, and gating them would mean a
    // widget you just clicked ignores almost every key you press.
    test("/ opens search at rest", () => {
        assert.equal(resolveKey(evt(KeyMap.Key_Slash), baseState(atRest)).action, "focusSearch");
    });

    test("r refreshes at rest", () => {
        assert.equal(resolveKey(evt(KeyMap.Key_R), baseState(atRest)).action, "refresh");
    });

    test("A marks all read at rest", () => {
        var r = resolveKey(evt(KeyMap.Key_A, KeyMap.ShiftModifier), baseState(atRest));
        assert.equal(r.action, "markAllRead");
    });

    // G and g g PLACE the cursor, so they must work when there isn't one --
    // otherwise there is no way to start navigating from the end of the list.
    test("G jumps to the last item at rest", () => {
        var r = resolveKey(evt(KeyMap.Key_G, KeyMap.ShiftModifier), baseState(atRest));
        assert.equal(r.action, "move");
        assert.equal(r.index, 4);
    });

    test("g g jumps to the first item at rest", () => {
        var armed = resolveKey(evt(KeyMap.Key_G), baseState(atRest));
        assert.equal(armed.pending, "g");
        var r = resolveKey(evt(KeyMap.Key_G), baseState({
            index: -1, count: 5, pending: "g", pendingAt: 1000, now: 1200
        }));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
    });

    test("j is the way in from rest -- it moves to 0", () => {
        var r = resolveKey(evt(KeyMap.Key_J), baseState(atRest));
        assert.equal(r.action, "move");
        assert.equal(r.index, 0);
    });

    test("Esc at rest with no selection and search closed is still a no-op", () => {
        var r = resolveKey(evt(KeyMap.Key_Escape), baseState(atRest));
        assert.equal(r.action, null);
    });
});

// ─── Empty list guard, across the board ───

describe("empty list (count === 0) never yields an out-of-range index", () => {
    var keys = [
        ["j", KeyMap.Key_J, 0],
        ["k", KeyMap.Key_K, 0],
        ["G", KeyMap.Key_G, KeyMap.ShiftModifier],
        ["Space", KeyMap.Key_Space, 0],
        ["Enter", KeyMap.Key_Return, 0],
        ["o", KeyMap.Key_O, 0],
        ["m", KeyMap.Key_M, 0],
        ["s", KeyMap.Key_S, 0],
        ["r", KeyMap.Key_R, 0],
        ["A", KeyMap.Key_A, KeyMap.ShiftModifier],
        ["/", KeyMap.Key_Slash, 0]
    ];

    keys.forEach(function (entry) {
        test("key " + entry[0] + " on an empty list leaves index at -1", () => {
            var r = resolveKey(evt(entry[1], entry[2]), baseState({ index: -1, count: 0 }));
            assert.equal(r.index, -1);
            assert.notEqual(r.action, "move");
        });
    });
});

// ─── Malformed / missing fields don't throw ───

describe("robustness", () => {
    test("missing event fields do not throw", () => {
        assert.doesNotThrow(() => resolveKey({}, baseState({ index: 1 })));
    });

    test("missing state fields fall back to safe defaults (count 0 -> no-op, not a crash)", () => {
        var r = resolveKey(evt(KeyMap.Key_J), {});
        assert.equal(r.action, null);
        assert.equal(r.index, -1);
    });
});
