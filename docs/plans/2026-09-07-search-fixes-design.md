# Design: search focus + search-during-selection

Date: 2026-09-07
Status: implemented — shipped in 2.4.0
Scope: two bugs in `DankRssWidget.qml` + one behaviour change in `ReaderState.js`

> **Status:** implemented. `HoverHandler`/`acceptsKeyboardFocus`, the
> selection-bar search toggle, and `pruneSelected` against `root.allItems`
> are all live in `DankRssWidget.qml`/`ReaderState.js`.

## Problem 1 — the search field ignores typing until you click it again

Click the search icon, the field appears, typing does nothing. Click the field
itself and typing works.

### Root cause

Verified in DMS source, not inferred:
`/usr/share/quickshell/dms/Modules/Plugins/DesktopPluginWrapper.qml:341` maps a
plugin's `acceptsKeyboardFocus` onto `WlrKeyboardFocus.OnDemand`, falling back to
`WlrKeyboardFocus.None`.

Layer-shell `on_demand` means **the compositor** grants keyboard focus to the
surface when a click lands on it. Our `acceptsKeyboardFocus` is bound to
`searchActive` (`DankRssWidget.qml:103`), which is still `false` at the moment
the toggle is clicked. So that click lands on a surface advertising
`keyboard_interactivity: none` and grants nothing. The property flips true
immediately after, making the surface eligible — but no *new* click has landed,
so the seat still holds no focus on us.

`searchField.forceActiveFocus()` (`:1305`) then sets Qt's *internal* focus item
on a surface with no Wayland keyboard focus at all. It succeeds and does nothing.
The second click is what actually grants seat focus.

### Fix

Make the surface focus-eligible *before* the click, by widening the condition to
include pointer hover:

```qml
HoverHandler { id: widgetHover }                      // on the root Rectangle

property bool acceptsKeyboardFocus: root.searchActive || widgetHover.hovered
```

Use `HoverHandler`, **not** a root-level `MouseArea`. The widget is full of child
`MouseArea`s (`filterArea`, `markAllArea`, per-item areas); a parent MouseArea's
`containsMouse` goes false whenever a hover-enabled child takes the pointer, so
the flag would flicker exactly while the user is aiming at the search button.
`HoverHandler` is a pointer handler, not an item — it observes the pointer over
its parent's bounds without competing for the event.

Also add a deferred retry, since focus arrival is not synchronous with the click:

```qml
onVisibleChanged: if (visible) { forceActiveFocus(); Qt.callLater(forceActiveFocus); }
```

### Does this reintroduce the D8 problem?

No. The `D8` comment at `:100-102` guards against the widget swallowing
compositor keybinds. `OnDemand` never takes focus on its own — it only makes the
surface *eligible* to receive focus from a click. While the pointer merely rests
over the widget and nothing is clicked, keys still go to niri. The behaviour
change is limited to: a click that lands on the widget while hovering can now
focus it, which is exactly what we want.

**Verification is manual (GUI).** Node tests cannot cover this.

## Problem 2 — the search button disappears while items are checked

### Root cause

The filter/search header row is
`visible: root.allItems.length > 0 && root.selectedCount === 0` (`:1067`), and
the selection bar *replaces* it (`visible: root.selectedCount > 0`, `:1187`).
The search **field** is a separate row keyed only on `searchActive` (`:1286`),
which is why an already-open search survives entering selection mode — the
asymmetry that made this confusing to report.

### Fix

Add a search toggle to the selection bar, mirroring the header's, bound to the
same `root.searchActive`. Keep the replace-the-row layout: selection is a
transient working mode and the filter chips are not useful inside it, but search
is. One row is always visible; no vertical churn.

Factor the toggle into an inline component so the two copies cannot drift.

## Problem 3 (behaviour change) — selection must survive filtering

Requested explicitly: items selected before typing a query stay selected as the
list filters down, provided they still match.

### Current behaviour

`applyFilter()` ends with
`root.selectedMap = ReaderState.pruneSelected(root.selectedMap, visible)`
(`:961`) — it prunes against the **visible** set, so any selected item that the
query filters out is silently deselected. Type a query, clear it, and your
selection is gone.

### New behaviour

Prune against `root.allItems` — the full dataset — instead of `visible`.
Selection then survives both search and filter-chip changes, and an id is dropped
only when it leaves the dataset entirely (a refresh evicting an old item).

`pruneSelected` itself does not change; only its argument and its comment do.
The `(S10)` comment on `ReaderState.js:391-392` currently states the old
invariant and must be rewritten — a stale comment defending removed behaviour is
exactly the failure mode this repo hit twice in 2.3.x.

### Consequence: selection can exceed what is on screen

Deliberate, and the point of the change: select a few, search, select a few more,
act on all of them. Two things follow.

1. **Bulk actions apply to every selected id, including hidden ones.** No change
   needed — `markSelectedRead`/bulk-bookmark already iterate `selectedMap`, not
   the visible model. Document it.
2. **The count label must not lie.** `"3 selected"` while one item is on screen
   reads as a bug. Add a helper and render the hidden portion:

```js
// ReaderState.js — new, testable
function countSelectedIn(selectedMap, items) { /* selected ∩ items */ }
```

```qml
text: root.selectedCount + " selected"
      + (hiddenSelected > 0 ? " (" + hiddenSelected + " hidden)" : "")
```

`Clear selection` (`:1277`) clears everything including hidden ids, which is the
only sane reading of the button.

## Testing

Node (`node --test tests/*.test.js`), added to `reader-state.test.js`:

- `pruneSelected` keeps an id present in the dataset but absent from a filtered
  view — the regression this change exists to prevent.
- `pruneSelected` still drops an id absent from the dataset entirely.
- `countSelectedIn` returns the intersection; `0` for an empty map; ignores
  `false` values, matching `countSelected`.
- A selection round-trip: select 3 → filter to 1 → all 3 still selected → clear
  query → all 3 still selected.

Write these tests **before** the change and watch them fail. Per this repo's own
2.3.x history, every bug that shipped was caught by a human reading code or a
screenshot, never by the suite — tests written after the fact here have twice
asserted the broken behaviour.

Manual (Brendon, GUI — cannot be automated from this session):

1. Click the search icon once; type immediately. Text must appear.
2. Check two items; the search toggle must be present in the selection bar.
3. With two checked, search for a term matching only one. Both stay selected,
   label reads `2 selected (1 hidden)`.
4. Clear the query; both still checked.
5. With search closed and the pointer over the widget, press a niri keybind
   (e.g. `Alt+b`). It must still reach the compositor.

## Out of scope

Keyboard navigation (`j/k/o/m/s`) — it depends on the same hover/focus fix but
is a separate feature, specified in the roadmap design doc.
