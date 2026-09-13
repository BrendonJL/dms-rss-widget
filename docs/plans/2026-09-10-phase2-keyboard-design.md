# Design: Phase 2 — keyboard navigation

Date: 2026-09-10
Status: implemented — shipped in 2.4.0
Depends on: the search-focus fix (done)

## The focus problem, which is the whole difficulty

`acceptsKeyboardFocus` is currently `searchActive || widgetHover.hovered`. DMS
maps it to layer-shell `WlrKeyboardFocus.OnDemand`, and `on_demand` means the
compositor grants keyboard focus when a click lands on the surface.

Hover was enough for search: click the toggle, type immediately, pointer is
still over the widget. **Keyboard navigation breaks that assumption.** Click a
row, move the mouse away to read, and `hovered` goes false — the surface stops
being focus-eligible mid-navigation and the next `j` goes to the compositor.
Worse, it is intermittent: it depends where the pointer happens to rest.

Fix: latch on focus, not on hover.

```qml
property bool acceptsKeyboardFocus: root.searchActive
                                 || widgetHover.hovered
                                 || keyboardScope.activeFocus
```

`keyboardScope` is the `FocusScope` holding the key handlers. Once a click
grants focus it keeps it, so the flag stays true while the user is driving;
when the compositor focuses another surface, `activeFocus` goes false and the
flag follows.

This does not swallow compositor keybinds. `OnDemand` never takes focus on its
own — the compositor decides who has it, and a niri binding is a compositor-
level grab that fires regardless. **This is the single most important thing for
Brendon to verify**, because it is the one claim here that no test can check.

Accepted limitation, unchanged from the roadmap: focus arrives only after a
click. Driving from cold would need `Exclusive`, which takes every key.
Click-then-drive is the model, not a defect.

## Bindings

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` | next / previous | `Space` | toggle selection checkbox |
| `o` / `Enter` | open | `/` | focus search |
| `m` | toggle read | `Esc` | close search, else clear selection, else clear cursor |
| `s` | toggle star | `r` | refresh |
| `g g` / `G` | first / last | `A` | mark all read |

Miniflux and vim conventions, so muscle memory transfers.

`Esc` is layered deliberately: closing search must not also destroy a selection
the user is mid-way through building. Each press undoes one level.

`g g` needs a pending-key state with a timeout, or a lone `g` leaves the widget
armed forever. 800ms, cleared on any other key.

## The cursor

A `currentIndex` on the ListView, `-1` when nothing is focused (the state after
`Esc`, and the initial state — the widget must not open an article because the
user pressed Enter at a freshly-clicked widget).

Keys act on `currentIndex`. When it is `-1`, only **row** actions are blocked --
open, toggle read, toggle star, toggle select -- since those would otherwise act
on an arbitrary item. `j` moves to 0, `G` and `g g` place the cursor (blocking
them would leave no keyboard route into the list at all), and the
cursor-independent actions `/`, `r` and `A` work normally. Gating everything
would mean a widget you just clicked ignores almost every key.

`positionViewAtIndex(currentIndex, ListView.Contain)` after every move, so the
cursor never leaves the viewport.

**Do not use `DankCommon/Widgets/FocusRing.qml`.** It binds
`visible: parent.activeFocus`, which is per-item Qt focus — the wrong model
here, since focus lives on the surface while the cursor is an index. It also
pulls `Style` from `qs.DankCommon.Common`, a different namespace from the
`qs.Common` `Theme` this widget uses. Draw the indicator directly, keyed on
`index === currentIndex`, and make it visually distinct from hover: hover is a
background tint, so the cursor should be a border or edge marker. Two states
that look alike are worse than one.

## Testable vs not

Key **dispatch** is a pure decision — given a key, a cursor, a list length and
the current mode, what happens? Put it in `KeyMap.js` and unit test it:

```js
resolveKey(event, state) -> { action, index, pending }
```

`action` is a name (`"open"`, `"toggleRead"`, `"first"`, …) or `null`. QML
performs it. That covers the `g g` pending state, the `Esc` layering, and the
`-1` cursor rules without a running shell — which is the part with real logic.
What stays untestable is whether the compositor grants focus at all.

## Verification

- Unit: every binding; `g` then a non-`g`; `g` timing out; `Esc` at each layer;
  `j`/`k` clamping at both ends; every action being a no-op at `currentIndex`
  of `-1` except `j`.
- Manual (Brendon): click a row, **move the pointer off the widget**, press
  `j` — the cursor must still move. That is the regression this design exists
  to prevent. Then: `/` focuses search and `Esc` closes it without losing a
  selection; `Alt+b` still reaches niri while the widget has focus.
