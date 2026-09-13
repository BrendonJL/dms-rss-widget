# Design: Accessible names for icon-only controls

Date: 2026-09-12
Status: proposed — not yet implemented
Depends on: nothing (additive layer, no behaviour change)

> **Status:** proposed

## The problem

`grep -c "Accessible\.\|ToolTip" DankRssWidget.qml DankRssWidgetSettings.qml
ReaderWindow.qml` returns 0, 0, 0. There is no accessibility layer anywhere in
this codebase, and none in the DMS common widgets it's built on either —
`grep -rn "Accessible" /usr/share/quickshell/dms/DankCommon/ /usr/share/quickshell/dms/Widgets/`
also comes back empty. Every `DankActionButton`, `DankToggle`,
`DankDropdown`, `DankTextField`, `StyledText` and `DankIcon` in DMS is silent
to assistive tech: no role, no name, nothing.

That's a gap everywhere, but it bites hardest on this widget's icon-only
controls. The list rows carry three trailing buttons — mark-read, bookmark,
open-in-reader — plus a leading selection checkbox, all rendered as a single
14px Material icon with no visible text. The header and selection bars carry
another half-dozen (refresh, search toggle, mark-all, export, save, close).
Their text labels exist but are hover-revealed and additionally gated behind
`root.widgetWidth >= 300` (`DankRssWidget.qml:1946`, `:2012`, `:2051`,
`:2091`, etc.) — so at the widget's normal panel width, most of these
controls have **no label of any kind, visible or accessible**. A sighted
mouse user infers "bookmark" from the icon shape and muscle memory. A screen
reader user gets nothing: `Accessible.name` defaults to empty on a plain
`Item`/`Rectangle`, so the control is announced as an unlabelled button, if
it's announced as interactive at all.

**This is not a colour problem, and we're not proposing colour changes.**
The colour-redundancy issue is already solved here: feed status pairs
`Theme.success`/`Theme.error` with distinct icons (`check_circle` vs `error`,
`DankRssWidgetSettings.qml:1158-1170`) and distinct text underneath; read vs
unread uses opacity 0.5 plus grey text, not colour alone
(`DankRssWidget.qml:2229`... the row-level dimming, separate from the
per-control icon swap at `:2447`). Brendon has deuteranopia, not a screen
reader — the actual remaining gap for him is that this widget is fully
mouse-and-hover dependent for icon *meaning*, and separately, a real
accessibility layer is missing for anyone who does need one. This doc
addresses the second thing because it's the one that's actually absent, not
because we found a new colour bug.

## What we verified about the widgets before touching anything

We read `/usr/share/quickshell/dms/DankCommon/Widgets/{DankActionButton,
DankIcon,DankToggle,StyledText,DankTextField,DankDropdown}.qml` end to end.
None sets any `Accessible.*` property. Root element types:

| Widget | Root type | Notes |
|---|---|---|
| `DankActionButton` | `StyledRect` → `Rectangle` | Has `Keys.onPressed` for Space/Return/Enter, `activeFocusOnTab`, a `clicked()` signal fired from an inner `StateLayer`'s `MouseArea`. |
| `DankToggle` | `Item` | Switch-style; `showText` gates whether any `StyledText` is even instantiated — with `text: ""` (the default), **no label exists in the tree at all**, not even a hidden one. |
| `DankTextField` | `StyledRect` → `Rectangle` | Has `labelText`/`placeholderText` properties already — the closest thing to a name source DMS ships. |
| `DankDropdown` | `Item` | Trigger is an inner `Rectangle` (`dropdown`) with its own `MouseArea`; the root `Item` carries `activeFocusOnTab` and `Keys.onPressed`, but the clickable/focusable surfaces are two different elements. |
| `DankIcon` | `Item` | Pure glyph, wraps a `StyledText` rendering a ligature font codepoint. Never itself interactive. |
| `StyledText` | `Text` | Plain, non-interactive. |

**This determines where the attached property goes.** `Accessible.name` and
`Accessible.role` are attached properties usable on *any* `Item`-derived
type — `Rectangle` and `Item` both qualify, so they work directly on
`DankActionButton`'s root, on a bare `Rectangle`-based custom button (the
settings feed-row buttons, which don't use `DankActionButton` at all — see
below), and on `DankToggle`'s root. They do **not** need to go on the inner
`DankIcon`, which is correct, because `DankIcon` is decorative — the name
belongs on the element that receives the click and the focus.

For `DankDropdown`, the property must go on the *inner* `Rectangle` (`dropdown`,
the one with `dropdownArea` `MouseArea`), not the outer `Item`, because that
inner rectangle is the actual hit target a screen reader's "activate" verb
would need to land on. (Not currently exercised by this widget's controls —
no `DankDropdown` instance was found in the three project files — but noted
for completeness since it was asked about.)

## How Qt Quick Accessible actually behaves here (verified against Qt docs, not assumed)

Three things worth stating plainly rather than asserting from memory:

1. **`Accessible.role` + `Accessible.name` on a non-focusable custom `Item`
   is sufficient** to expose it to the accessibility tree with that role and
   name — Qt Quick's `Accessible` attached type works on any `QQuickItem`
   whether or not the item itself handles keyboard focus. It does not
   require the item to be a `FocusScope` or set `activeFocusOnTab`.
2. However, an item with **no `Accessible.role` set at all is normally
   pruned from the tree** (`Accessible.role` defaults to
   `Accessible.NoRole`, and items with `NoRole` are typically invisible to
   AT). So role must be set explicitly on every control we're naming — a
   name alone, with role left at the default, may not surface. This is why
   every row in the inventory table below carries both.
3. **`Accessible.onPressAction` should be wired to the same handler as the
   click**, not left unset. Screen readers activate a `Button`-role item via
   the accessibility "press" action, not by synthesizing a mouse click on
   its geometry — the widget won't visually see a click at all in that path.
   Every entry below that already has an `onClicked:` handler gets
   `Accessible.onPressAction: <same call>` alongside it — a one-line
   duplication, not a refactor, and worth stating as duplication rather than
   hiding it behind a shared function, since these handlers are all
   one-liners already and a shared function would be more indirection than
   the two-line body it replaces.

None of this was assumed — it's what the attached-property contract Qt Quick
documents, cross-checked against the fact that DMS's own widgets set none of
it and yet Qt Quick applications built on it are known to be at least
partially screen-reader navigable via other means (focus + geometry) rather
than via any name. We are not able to run an actual screen reader against
this widget on this machine (see Verification), so this section is the
closest thing to empirical confirmation available; treat the exact
lower-level AT-bridge behaviour (Orca announcing role transitions etc.) as
unverified until Brendon or another tester checks it live.

## Approach

Add `Accessible.role`, `Accessible.name`, and where the control performs an
action, `Accessible.onPressAction`, directly on each control's existing root
element — no new components, no wrapper items, no behavioural changes.
Static names are string literals. Dynamic names are ternary bindings against
the same state the icon and (where present) the hover-revealed text already
key off, so a name update happens automatically whenever the icon would have
changed — there is no separate state to keep in sync.

For selection/mark-read/bookmark/open-reader controls inside the row
delegate, the name additionally interpolates `model.title` so a screen
reader user tabbing/arrowing through many rows' worth of "Mark as read"
buttons can tell them apart without needing surrounding-row context that a
sighted user gets for free from layout position.

For the row's leading selection control, `Accessible.role` is `CheckBox`
and state goes on `Accessible.checked`, not into the name text — that's the
correct mapping (a checkbox's checked/unchecked state is a first-class AT
property, and duplicating it into the name string produces a screen reader
announcing "checked, Select article X, checked" or similar doubled output).
Mark-read and bookmark are **not** modelled as checkboxes despite also being
binary toggles: they change what clicking them *does* (their icon swaps to
show the resulting state, not the current one being confirmed — clicking
`mark_email_unread` marks it read), which is the semantics of a same-slot
action button, not a checkbox. Their accessible name states the action that
will happen next, which is also how the widget's own bulk-action labels
already phrase themselves ("Mark unread" / "Mark read" swapping based on
`root.selectedAllRead`, `DankRssWidget.qml:2085-2092`) — this proposal
extends an existing, working convention rather than inventing a new one.

## Complete inventory

Every icon-only or unlabelled-at-current-width interactive control across
the three files, in file order.

### DankRssWidget.qml

| Line | Control | Icon(s) | Action | Proposed `Accessible.name` |
|---|---|---|---|---|
| 1789-1804 | Refresh button | `refresh` | `root.refreshNow()` | `"Refresh feeds"` |
| 1838-1852 (`searchToggleComponent`, instantiated at 1915-1919 and 2111-2115) | Search toggle | `search` / `search_off` | opens/closes search | `root.searchActive ? "Close search" : "Search"` |
| 1875-1906 | Filter chips (All/Unread/Saved) | none (already textual) | sets `filterMode` | *Out of primary scope — already has permanent visible text (`filterLabel`, always shown, never width-gated). Worth a cheap follow-on: `Accessible.role: Button`, `Accessible.checked: active`, since these behave as a segmented toggle group and currently have no role at all despite having a name via ordinary `Text` — see "Out of scope" below.* |
| 1921-1960 | Mark all read/unread | `done_all` / `remove_done` | `root.setAllRead(!markAllRect.allRead)` | `markAllRect.allRead ? "Mark all unread" : "Mark all read"` |
| 1993-2025 | Save (bulk bookmark) | `bookmark` | `root.bulkSaveSelected()` | `"Bookmark selected items"` |
| 2031-2064 | Export selected | `note_add` | `root.exportSelected()` | `"Export selected items"` |
| 2070-2104 | Mark read/unread (selection bar) | `mark_email_read` / `mark_email_unread` | `bulkMarkReadSelected()` / `bulkMarkUnreadSelected()` | `root.selectedAllRead ? "Mark selected unread" : "Mark selected read"` |
| 2119-2127 | Clear selection | `close` | `root.clearSelection()` | `"Clear selection"` |
| 2313-2336 | Row selection checkbox | `check_box` / `check_box_outline_blank` | `root.toggleSelected(model.itemId)` | `"Select " + (model.title \|\| "item")` — role `CheckBox`, `Accessible.checked: itemDelegate.isSelected` |
| 2446-2487 | Row mark-read toggle | `mark_email_read` / `mark_email_unread` | `root.toggleReadSynced(...)` | `(itemDelegate.isRead ? "Mark \"" : "Mark \"") + (model.title \|\| "item") + (itemDelegate.isRead ? "\" as unread" : "\" as read")` |
| 2494-2515 | Row bookmark toggle | `bookmark` / `bookmark_border` | `root.toggleBookmark(model.itemId)` | `(itemDelegate.isBookmarked ? "Remove bookmark from \"" : "Bookmark \"") + (model.title \|\| "item") + (itemDelegate.isBookmarked ? "\"" : "\"")` |
| 2520-2534 | Row open-in-reader | `menu_book` | `root.viewItem(model.itemId, index)` | `"Open \"" + (model.title \|\| "item") + "\" in reader"` |
| 2711-2719 | Close keyboard-shortcuts overlay | `close` | `root.helpVisible = false` | `"Close keyboard shortcuts"` |

### ReaderWindow.qml

| Line | Control | Icon(s) | Action | Proposed `Accessible.name` |
|---|---|---|---|---|
| 409-416 | Maximize/restore | `fullscreen` / `fullscreen_exit` | `windowControls.tryToggleMaximize()` | `root.maximized ? "Restore window" : "Maximize window"` |
| 418-424 | Close reader | `close` | `root.dismiss()` | `"Close reader"` |

### DankRssWidgetSettings.qml

| Line | Control | Icon(s) | Action | Proposed `Accessible.name` |
|---|---|---|---|---|
| 1158-1163 | Feed status OK icon | `check_circle` | none (decorative) | *Not interactive — see "Out of scope".* |
| 1165-1170 | Feed status error icon | `error` | none (decorative) | *Not interactive — see "Out of scope".* |
| 1196-1205 | Feed enabled toggle (`DankToggle`, `text: ""`) | switch, no icon | flips `feeds[index].enabled` | `"Enable " + (modelData.name \|\| "feed") + " feed"` — role `CheckBox`, `Accessible.checked: modelData.enabled !== false` |
| 1207-1240 | Move feed up | `arrow_upward` | reorders `feeds` array | `"Move " + (modelData.name \|\| "feed") + " up"` |
| 1242-1275 | Move feed down | `arrow_downward` | reorders `feeds` array | `"Move " + (modelData.name \|\| "feed") + " down"` |
| 1277-1302 | Edit feed | `edit` | opens the edit form | `"Edit " + (modelData.name \|\| "feed")` |
| 1304-1333 | Delete feed | `delete` | removes the feed | `"Delete " + (modelData.name \|\| "feed")` |

The four feed-row buttons (1207-1333) are worth flagging separately: they
are **not** `DankActionButton` instances at all. They're hand-rolled
`Rectangle` + `DankIcon` + `MouseArea` — meaning `Keys.onPressed` for
Space/Enter, `activeFocusOnTab`, and the whole keyboard-activation story
`DankActionButton` gives you for free are already absent here, independent
of accessibility. Adding `Accessible.role`/`name` to a `Rectangle` that
still isn't keyboard-focusable is a real improvement for screen-reader users
navigating by the accessibility tree (which doesn't require Tab focus), but
it does not make these buttons keyboard-operable for sighted keyboard users.
That's a separate, pre-existing gap this doc does not attempt to close —
converting them to `DankActionButton` would be a larger, riskier change
(they currently rely on `enabled`-gated opacity and custom hover colours
that `DankActionButton`'s `StateLayer` doesn't replicate 1:1) and is out of
scope for a names-only pass.

## Dynamic-state bindings, collected

These are the controls whose accessible name must track live state rather
than being a fixed string, with the exact binding to use:

| Control | Backing property | Binding |
|---|---|---|
| Search toggle | `root.searchActive` | `Accessible.name: root.searchActive ? "Close search" : "Search"` |
| Mark all read/unread | `markAllRect.allRead` | `Accessible.name: markAllRect.allRead ? "Mark all unread" : "Mark all read"` |
| Mark read/unread (selection bar) | `root.selectedAllRead` | `Accessible.name: root.selectedAllRead ? "Mark selected unread" : "Mark selected read"` |
| Row selection checkbox | `itemDelegate.isSelected` | `Accessible.role: Accessible.CheckBox`; `Accessible.checked: itemDelegate.isSelected`; `Accessible.name: "Select " + (model.title || "item")` |
| Row mark-read toggle | `itemDelegate.isRead`, `model.title` | `Accessible.name: "Mark \"" + (model.title || "item") + "\" as " + (itemDelegate.isRead ? "unread" : "read")` |
| Row bookmark toggle | `itemDelegate.isBookmarked`, `model.title` | `Accessible.name: (itemDelegate.isBookmarked ? "Remove bookmark from \"" : "Bookmark \"") + (model.title || "item") + "\""` |
| Reader maximize/restore | `root.maximized` | `Accessible.name: root.maximized ? "Restore window" : "Maximize window"` |
| Feed enabled toggle | `modelData.enabled` | `Accessible.role: Accessible.CheckBox`; `Accessible.checked: modelData.enabled !== false`; `Accessible.name: "Enable " + (modelData.name || "feed") + " feed"` |

Every one of these is a ternary or string concatenation over a property that
already exists and already drives the icon or hover text — no new state is
introduced anywhere in this doc.

## What we rejected, and why

**A shared `AccessibleButton` wrapper component.** Tempting, since the
pattern (`role: Button`, `name: <binding>`, `onPressAction: <same as
onClicked>`) repeats a dozen times. Rejected because `DankActionButton`
already exists as the shared base for most of these, and the four settings
buttons that *aren't* `DankActionButton` are bare `Rectangle`s for reasons
unrelated to accessibility (custom hover-colour behaviour). Wrapping either
would mean either modifying a DMS-owned shared widget (out of bounds — we
don't own `/usr/share/quickshell/dms/`) or introducing a second button
abstraction that only four call sites use, for a three-line saving per
site. Setting the three properties directly at each `DankActionButton`/
`Rectangle` instance keeps the diff local and legible against this table.

**Encoding checkbox-style state into the name string instead of
`Accessible.checked`** (e.g. `"Select article X (selected)"`). Rejected —
covered above under Approach. It's the wrong mapping for `CheckBox` role and
would produce doubled announcements on any AT that reads both the name and
the checked state, which every mainstream screen reader does.

**Modelling mark-read/bookmark as `CheckBox` role instead of `Button`.**
Considered, since they are visually binary toggles. Rejected because their
icon shows the *current* state, not a checkbox glyph, and their click
semantics ("do the opposite of what's currently true") map more naturally
onto "this button's name tells you what pressing it does" than onto
"this checkbox's checked property tells you its state." The bulk-action
labels elsewhere in this same widget already use the action-describing
phrasing ("Mark unread" appearing when items are currently read), so this
also keeps the new names consistent with strings already shipping.

**Colour or icon changes of any kind.** Explicitly not this doc's job — see
Problem statement. The existing colour-plus-icon-plus-text redundancy for
feed status, and opacity-plus-greyscale for read/unread, are correct as they
stand and are not touched here.

**Adding `Accessible.description` (a longer hint distinct from `name`) or
`Accessible.role: Accessible.MenuItem`-style richer roles.** Considered for
the feed-row buttons since they sit inside a list. Rejected as scope
creep — `Button` and `CheckBox` are the two roles this pass needs, and
`name` alone is enough to satisfy the actual gap (a control with no name).
Richer semantics can follow once there's a way to verify they help (see
Verification) rather than layering on speculative detail now.

**Retrofitting the filter chips and status icons into the main table.** The
filter chips already have permanent, non-hover-gated visible text — they
fail "no accessible name" but not "no name at all"; a `Text` child gives
screen readers *something* today, just without a `Button`/toggle role
attached to it. The feed-status icons are purely decorative, duplicating
adjacent text. Both get a one-line mention above rather than full table rows
so the table stays focused on genuinely unlabelled controls, which is what
was asked for.

## Out of scope

- **Colour changes of any kind** — see Problem and Rejected above.
- **Screen-reader testing on this machine.** There is no `qml` binary
  installed here (confirmed: `tests/qml/run.sh` requires one), and no Orca/
  AT-SPI verification loop is available in this environment. Everything in
  this doc about *whether Qt Quick's attached-property model works as
  described* is Qt-documentation-level confidence, not measured-on-this-box
  confidence.
- **Making the settings feed-row buttons keyboard-focusable.** Real gap,
  pre-dates this doc, not an accessible-*naming* problem — see the note
  under the settings table.
- **`DankDropdown` instances** — none exist in this widget's three files
  today; the note on where its name would go is here only because the task
  asked about the widget's general behaviour, not because there's a control
  to fix.
- **Localisation of the new strings.** The rest of the widget's UI text is
  hardcoded English (see e.g. `"Mark all read"`, `"No feeds configured yet"`
  throughout); accessible names follow the same convention rather than
  introducing translation for this one layer alone.

## Verification

CI here runs `qmlformat` for syntax/formatting only — there is no QML type
checking in this repository's CI. `tests/qml/run.sh` requires a `qml`
binary, which is **not installed on this machine**, so none of the existing
`tests/qml/*.qml` harness can be extended to assert on `Accessible.name`
values either, even though that would otherwise be the natural place to pin
these strings down (`Accessible.name` is a readable property, so a `qml`-
runtime test could assert `object.Accessible.name === "Refresh feeds"` the
same way the existing suites assert on `KeyMap.resolveKey()` output).

So verification for this change is, honestly:

1. `qmlformat --inplace` (or whatever `qmlformat-all.sh`-equivalent this repo
   uses) on every file touched, to catch syntax breakage — the only
   automated check available.
2. Manual read-through confirming every `Accessible.name` binding above
   references a property that exists at that scope (`model.title`,
   `itemDelegate.isRead`, `modelData.name`, etc. — all confirmed present at
   their respective call sites during this research pass).
3. **Manual owner testing is required before calling this done.** Ideally:
   run the widget under Orca (or any AT-SPI screen reader) if one is ever
   available on this machine or a test VM, and confirm each control in the
   table above is announced with the name and role listed. Short of that,
   at minimum: confirm in a running Quickshell instance that adding these
   properties causes no visual or behavioural regression (they are additive
   attached properties with no rendering footprint), since that's the one
   thing that *can* be checked without AT tooling.

Until step 3 happens, treat this as "the names are wired up" rather than
"accessibility is verified" — those are different claims, and this doc only
gets to make the first one.
