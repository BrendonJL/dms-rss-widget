// Keyboard dispatch for the Dank RSS Widget's article list.
//
// PURE, same as ChainRunner.js: no Qt APIs, no I/O, no Date.now(), no
// randomness. QML's Keys.onPressed handler calls resolveKey() with the raw
// event and the widget's current state; this module only ever returns a
// NAME for the caller to act on -- it never opens an article, never toggles
// anything itself. Full context: docs/plans/2026-09-10-phase2-keyboard-
// design.md ("Testable vs not").
//
//   var result = KeyMap.resolveKey(event, state);
//   if (result.action) { /* perform result.action, use result.index */ }
//   state.pending = result.pending;
//   if (result.pending) state.pendingAt = state.now; // this keystroke's time
//
// Node has no `Qt` global, so the key/modifier codes the module matches
// against are hardcoded here as Qt's own numeric values (from qnamespace.h),
// not looked up on an injected Qt object. QML's event.key/event.modifiers
// are these same numbers, so no translation is needed at the call site.
var Key_J = 0x4a;
var Key_K = 0x4b;
var Key_G = 0x47;
var Key_A = 0x41;
var Key_O = 0x4f;
var Key_R = 0x52;
var Key_M = 0x4d;
var Key_S = 0x53;
var Key_Space = 0x20;
var Key_Slash = 0x2f;
var Key_Question = 0x3f;
var Key_Escape = 0x01000000;
var Key_Return = 0x01000004;
var Key_Enter = 0x01000005;

var ShiftModifier = 0x02000000;

// A pending "g" (for "g g" -> first) expires after this many milliseconds.
// state.now/state.pendingAt are caller-supplied timestamps -- the module
// never reads a clock itself.
var PENDING_TIMEOUT_MS = 800;

function noop(index, pending) {
    return { action: null, index: index, pending: pending === undefined ? null : pending };
}

function moveTo(index, pending) {
    return { action: "move", index: index, pending: pending === undefined ? null : pending };
}

function act(action, index) {
    return { action: action, index: index, pending: null };
}

function resolveKey(event, state) {
    var key = event && event.key;
    var modifiers = (event && event.modifiers) || 0;
    var shift = (modifiers & ShiftModifier) !== 0;

    var count = (state && typeof state.count === "number") ? state.count : 0;
    var index = (state && typeof state.index === "number") ? state.index : -1;
    var searchActive = !!(state && state.searchActive);
    var hasSelection = !!(state && state.hasSelection);

    // An empty list has no valid index -- every branch below that would
    // otherwise move or act on a row collapses back to -1/no-op.
    if (count === 0)
        index = -1;

    // Esc is layered and fires no matter what else is going on -- including
    // while search has keyboard focus, which is the one printable-key
    // exception below.
    if (key === Key_Escape) {
        if (searchActive)
            return act("closeSearch", index);
        if (hasSelection)
            return act("clearSelection", index);
        if (index !== -1)
            return { action: "clearCursor", index: -1, pending: null };
        return noop(index);
    }

    // While search has keyboard focus, typing must reach the field, not the
    // list -- so every other key is unhandled (null) and QML lets it
    // propagate. This also means a lone "g" typed into search never arms
    // the pending-first state.
    if (searchActive)
        return noop(index);

    // A pending "g" is consumed (or expired) before the current key is
    // otherwise interpreted. Any key other than a second lone "g" clears it
    // and then falls through to be handled normally below.
    var pendingValid = state && state.pending === "g" &&
        typeof state.pendingAt === "number" && typeof state.now === "number" &&
        (state.now - state.pendingAt) <= PENDING_TIMEOUT_MS;

    if (pendingValid && key === Key_G && !shift) {
        // "g g" -> first item. Works at rest: g g PLACES a cursor, so blocking
        // it would leave no way to start navigating from the keyboard.
        if (count === 0)
            return noop(-1);
        return moveTo(0);
    }

    // At rest (index -1, nothing focused yet) only ROW actions are blocked --
    // opening, read, star and select would otherwise act on an arbitrary item.
    // Keys that do not depend on a cursor still work: "/" must open search on a
    // freshly-clicked widget, "r" must refresh, "A" must mark all read, and
    // "G"/"g g" must be able to place the cursor in the first place. Gating
    // those too would mean a widget you just clicked ignores almost everything.
    var atRest = index === -1;

    if (key === Key_J) {
        if (count === 0)
            return noop(-1);
        if (atRest)
            return moveTo(0);
        return moveTo(Math.min(index + 1, count - 1));
    }

    if (key === Key_K) {
        // "j" is the documented way in from rest; "k" does not wrap to the end.
        if (count === 0 || atRest)
            return noop(index);
        return moveTo(Math.max(index - 1, 0));
    }

    if (key === Key_G) {
        if (shift) {
            if (count === 0)
                return noop(index);
            return moveTo(count - 1);
        }
        // Lone "g": arm the pending state. No action fires yet.
        return noop(index, "g");
    }

    // --- cursor-independent actions: valid even with no cursor ---

    // "?" (Shift+/) opens the bindings help overlay. Checked before the plain
    // "/" case below, since some platforms report Shift+/ as Key_Slash with
    // the shift modifier set rather than a distinct Key_Question.
    if (key === Key_Question || (key === Key_Slash && shift))
        return act("toggleHelp", index);

    if (key === Key_Slash)
        return act("focusSearch", index);

    if (key === Key_R)
        return act("refresh", index);

    if (key === Key_A && shift)
        return act("markAllRead", index);

    // --- row actions: these need a cursor, or they act on an arbitrary item ---

    if (atRest)
        return noop(-1);

    if (key === Key_Space)
        return act("toggleSelect", index);

    if (key === Key_Return || key === Key_Enter)
        return act("open", index);

    if (key === Key_O && !shift)
        return act("open", index);

    if (key === Key_M)
        return act("toggleRead", index);

    if (key === Key_S)
        return act("toggleStar", index);

    return noop(index);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        resolveKey: resolveKey,
        PENDING_TIMEOUT_MS: PENDING_TIMEOUT_MS,
        Key_J: Key_J,
        Key_K: Key_K,
        Key_G: Key_G,
        Key_A: Key_A,
        Key_O: Key_O,
        Key_R: Key_R,
        Key_M: Key_M,
        Key_S: Key_S,
        Key_Space: Key_Space,
        Key_Slash: Key_Slash,
        Key_Question: Key_Question,
        Key_Escape: Key_Escape,
        Key_Return: Key_Return,
        Key_Enter: Key_Enter,
        ShiftModifier: ShiftModifier
    };
}
