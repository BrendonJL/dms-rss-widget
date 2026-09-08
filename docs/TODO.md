# dms-rss-widget backlog

Post-2.3.3. Nothing here is committed to a release yet.

## Bugs

### B1 — Search field doesn't accept typing until you click it a second time
**Symptom:** click the search icon, the field appears, typing does nothing. Click
the field itself, then typing works.

**Root cause (verified in DMS source, not a guess):**
`/usr/share/quickshell/dms/Modules/Plugins/DesktopPluginWrapper.qml:341` maps our
`acceptsKeyboardFocus` onto `WlrKeyboardFocus.OnDemand` (`None` when false).
Layer-shell `on_demand` means *the compositor* grants keyboard focus to the
surface when a click lands on it. Our `acceptsKeyboardFocus` is bound to
`searchActive` (DankRssWidget.qml:103), which is still **false** at the moment
the toggle is clicked — so that click lands on a surface with
`keyboard_interactivity: none` and grants nothing. The property flips true
afterwards, but no *new* click has landed, so the seat still has no focus on us.
`searchField.forceActiveFocus()` (line 1305) sets Qt's internal focus item on a
surface that has no Wayland keyboard focus at all — hence the silent no-op.

**Fix direction:** make the surface focus-eligible *before* the click, e.g.
`acceptsKeyboardFocus: root.searchActive || widgetHoverArea.containsMouse`.
Keep the D8 intent (line 100-102): must still be `false` when the pointer is
away, so compositor keybinds aren't swallowed. Re-assert `forceActiveFocus()`
from a `Qt.callLater`/one-shot Timer as a belt-and-braces retry.

### B2 — Search button disappears while items are checked
**Symptom:** with checkboxes ticked there's no way to open search; but if search
was already open it survives entering selection mode.

**Root cause:** the filter/search header row is
`visible: root.allItems.length > 0 && root.selectedCount === 0`
(DankRssWidget.qml:1067) and the selection bar *replaces* it
(`visible: root.selectedCount > 0`, line 1187). The search **field** is a
separate row keyed only on `searchActive` (line 1286), which is exactly why it
survives — the asymmetry the user hit.

**Fix direction:** either keep a search toggle in the selection bar, or stop
hiding the whole header and only swap the chip cluster. Decide whether
"search within selection" is even meaningful first — S10 (line 959) prunes
selection against the visible set, so searching while selected currently
*shrinks* the selection. That interaction needs a decision, not just a button.

## Features

### F1 — Keyboard navigation (feasible, with one hard limit)
Confirmed possible: the wrapper already forwards `acceptsKeyboardFocus`, so we
can hold `OnDemand` focus and attach `Keys.onPressed` handlers.
**Limit:** `OnDemand` means focus arrives only after a click on the widget.
There is no way to be keyboard-driven from cold without `Exclusive`, which would
steal every key from the compositor. So the model is: click once, then drive.

Proposed bindings (Miniflux/Vim conventions):
`j`/`k` next/prev · `o`/`Enter` open · `m` toggle read · `s`/`f` star ·
`/` focus search · `Esc` close search / clear selection · `Space` toggle
checkbox · `r` refresh · `g g`/`G` top/bottom.
Requires: a `currentIndex` on the ListView, a visible focus ring distinct from
hover, and `positionViewAtIndex` so the cursor stays on screen.

### F2 — Google Reader API support (highest leverage backend work)
One protocol unlocks FreshRSS, Tiny Tiny RSS (via plugin), Inoreader,
TheOldReader, BazQux — and Miniflux, which speaks it too. Compare with adding
each backend one at a time.

Prerequisite refactor: `sourceMode` is currently a two-valued string branched on
in ~10 places in DankRssWidget.qml (lines 344, 382, 407, 421, 470, 510, ...).
Adding a third mode by extending those branches will not scale. Extract a
backend interface — `fetch()`, `markRead(ids)`, `toggleStar(id)`,
`reconcile(items)` — with `standard` / `miniflux` as its first two
implementations, *then* add Google Reader as a third.

### F3 — Fever API (cheap second protocol)
Simpler than Google Reader, covers FreshRSS + TT-RSS. **Read-only in Miniflux**
(can't subscribe through it), so it's a complement, never a replacement for F2.

### F4 — Feature ideas from other readers
- **Full-text fetch** (Miniflux, FreshRSS): request the article body when a feed
  only ships a summary. In Miniflux mode this is a single API call we already
  have the token for.
- **Saved searches / filter rules** (NewsBlur, Inoreader): keyword rules that
  auto-mark-read or auto-star. Our search already indexes title/text/source.
- **Feed grouping / categories** (all of them): Miniflux already returns
  categories; we currently flatten them.
- **Hide-read-on-scroll** (Reeder, NetNewsWire): auto-mark items read as they
  scroll past.
- **Send-to** integrations (Wallabag, Pocket-likes): one action to push an entry
  elsewhere; would fit the existing selection bar.
- **Per-feed refresh intervals** (Feedbin): hourly feeds shouldn't poll like
  minute feeds.
- **Unread count badges per source**, sort by oldest-first (Miniflux default).
