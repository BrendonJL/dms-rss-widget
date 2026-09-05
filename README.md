# Dank RSS Widget

A desktop widget plugin for [DankMaterialShell](https://github.com/AvengeMedia/DankMaterialShell) that displays RSS and Atom feeds directly on your desktop.

## Features

- RSS 2.0 and Atom feed support with auto-detection
- Configurable auto-refresh interval (5min - 24hr)
- Click an item to open it in your browser and mark it read — this always happens, even if the item is already read (clicking never un-reads it)
- A read/unread checkbox on each row toggles read state directly, without opening the link
- Add/edit/remove feeds via the settings panel, with per-feed enable/disable
- URL validation on add/edit (auto-prepends `https://` to a bare domain, rejects non-URLs, inline error text)
- OPML import for bulk feed migration (uses the shared parser)
- Quick-add presets: US/global news, tech, Reddit communities
- Sort modes: newest first, oldest first, grouped by feed
- Compact and expanded view modes
- Thumbnail images from media:thumbnail, media:content, enclosures
- Read/unread tracking with mark-all toggle, **persisted across reloads**
- All / Unread / Saved filter row, with a live count on Unread and Saved
- Bookmarks: toggle a saved flag on any item from a bookmark icon on the row (reduced opacity until hover or already-bookmarked, so hovering never reflows the row), persisted by stable item ID across reloads
- Search: a toggle button reveals a search field on its own row; matches title, description, and source name, case-insensitively, with multiple space-separated terms ANDed (they may match across different fields) and debounced 150ms; composes with whichever filter is active
- Feed reordering in settings via move-up/move-down buttons, disabled (not hidden) at the list boundaries
- New-item notifications via the DMS toast system, based on stable item IDs seen since the last run (no backlog spam on first launch)
- Manual refresh button in the header, disabled while a refresh is in flight
- Per-feed fetch status (idle/loading/ok/error/timeout/disabled) with item counts and error text, visible in settings
- Failed-feed count indicator in the header; distinct empty states for no feeds / all disabled / all failed / all caught up / no matching search results / no saved items
- Configurable font size
- Appearance customization (background opacity, borders)
- CDATA unwrapping and HTML entity decoding
- Feed source labels per item

### Planned (not in this milestone)

- A dedicated "Errors" filter view — deliberately skipped this pass; feed errors are already surfaced via the header's failed-feed count indicator and per-feed status lines in settings, and an error view would need a different row type than the item list
- Per-feed color/category labels
- Configurable excerpt length
- Stale-feed warnings
- Copy-link action on items

### Known limitations

- At very narrow widget widths (approaching the 100px floor) the filter chips can still crowd each other. Fully solving it would need chip wrapping or eliding, which is not implemented. At normal sizes (the default and above) this is not visible.
- Compact view rows reserve slightly more vertical padding than their margins strictly need. This is a pre-existing cosmetic issue, not introduced or fixed in this release.
- The widget now declares `acceptsKeyboardFocus` (gated to when search is open) so the search field can receive typed input. No other widget in the installed DMS build uses this property, so while it is wired correctly per the documented mechanism, its behavior is unproven across DMS versions and may interact with compositor-specific layer-shell focus policy.

## Installation

### From the DMS Plugin Manager

Search for "Dank RSS Widget" in the DMS plugin manager.

### Manual Installation

Clone or symlink this repo into your DMS plugins directory:

```bash
git clone https://github.com/BrendonJL/dms-rss-widget.git
ln -s /path/to/dms-rss-widget ~/.config/DankMaterialShell/plugins/dankRssWidget
```

Reload DMS (Ctrl+Shift+R) or restart your compositor.

## Configuration

Open the widget settings to:

1. **Add feeds** — Enter a name and RSS/Atom URL, or use the quick-add presets
2. **Enable/disable feeds** — A disabled feed stays configured and editable but is not fetched
3. **Reorder feeds** — Move-up/move-down buttons on each feed row change the order feeds are stored in. This order is what "grouped by feed" sort mode groups follow, so reordering feeds changes their display order in that mode. Opening the edit form and then reordering closes the edit form, since a swap would otherwise leave it pointing at the wrong feed.
4. **Set refresh interval** — How often feeds are fetched (default: 30 minutes)
5. **Max items** — Limit displayed items (default: 20)
6. **Appearance** — Background opacity, border toggle/color/thickness

Each configured feed shows a status line: item count when its last fetch succeeded, the error/timeout text when it failed, or "Not fetched yet" before the widget has run.

## Requirements

- DankMaterialShell >= 1.2.0
- `curl` (used for fetching feeds)

## Data & persistence

Plugin data is split across two tiers:

- **Settings** (`~/.config/DankMaterialShell/settings.json`, shared with the rest of DMS) — your configured feeds, refresh interval, max items, sort mode, and appearance preferences. Written via `pluginService.setData` / read via `getData`.
- **State** (`~/.local/state/DankMaterialShell/plugins/dankRssWidget_state.json`, a dedicated per-plugin file) — read/seen item IDs, bookmarked item IDs (`bookmarkedIds`), and per-feed fetch status. Written via `pluginService.savePluginState` / read via `loadPluginState`. This file is not part of your shared DMS settings and is not synced or backed up along with them. The state tier is not permission-gated separately from the rest of the plugin.

To reset read/unread state (mark everything unread and clear notification history) without touching your configured feeds, delete the state file:

```bash
rm ~/.local/state/DankMaterialShell/plugins/dankRssWidget_state.json
```

(The directory comes from Quickshell's `Paths.state`, i.e. the XDG generic state location plus `/DankMaterialShell`.) **Note:** this also clears your bookmarks — they live in the same file as read/seen state, not a separate one.

### A note on desktop widget instances

DMS can run this plugin either as a global plugin or as a **desktop widget instance**
(an entry under `desktopWidgetInstances` in `settings.json`). Instances get their feeds
and preferences from their own per-instance `config` block, not from the shared
`pluginSettings` section — so two instances can show different feeds.

Instances are also handed a *reduced* plugin service by DMS
(`instanceScopedPluginService` in `DesktopPluginWrapper.qml`) that implements only
`loadPluginData`/`savePluginData` and has **no** `loadPluginState`/`savePluginState`.
The widget therefore resolves the real `PluginService` singleton for state access and
feature-detects before calling it, so read/seen/bookmark persistence works in both
modes and a missing state API can never block feed fetching. Reader state is keyed by
plugin ID, so multiple instances share one read/bookmark history.

**Bookmark limitation:** a bookmark is stored by stable item ID and survives refreshes and reloads, but the Saved view can only display an item that is still present in the currently fetched set. If an item scrolls out of its feed (e.g. the source pushes it past your configured max-items window), its bookmark ID is still stored, but there is no local article archive to fall back on — the item simply won't appear in Saved until/unless it's fetched again.

## Architecture

Logic that can be pure is kept out of QML, in two shared files at the repo root:

| File | Responsibility | Imported by |
|------|----------------|-------------|
| `FeedParser.js` | RSS/Atom/OPML parsing, stable item IDs, image extraction, relative time | both `.qml` files + tests |
| `ReaderState.js` | Read/seen/bookmark ID bookkeeping, bounding, new-item detection, search + filtering, fetch classification, persistence capability detection, feed enable/disable and ordering rules | both `.qml` files + tests |

Both are imported the same way (`import "FeedParser.js" as FeedParser`), and the Node test suite `require()`s the very same files — there is no separate copy of the logic to keep in sync.

Splitting `ReaderState.js` out is what makes the trickiest rules testable without a running shell: that notifications stay silent on first run, that a feed outage cannot manufacture phantom "new items", that ID history stays bounded, and that a feed with no `enabled` key still counts as enabled.

These files deliberately have **no `.pragma library` line**. That directive is required for QML-only JS modules in some contexts, but it is not valid JavaScript, and `require()` in Node fails on it immediately. Do not add it back — doing so breaks the test suite without breaking the widget, which makes the failure easy to miss.

Exports are guarded with `if (typeof module !== "undefined" && module.exports) { ... }`, so the same file behaves as a plain QML-imported script inside DMS and as a CommonJS module under Node.

## Testing

The parsing and reader-state logic is unit tested directly with Node.js. The tests import the exact same files the widget uses at runtime, not a mirror or copy, so they exercise real production code.

### Running Tests

```bash
node --test tests/*.test.js
```

Or one suite at a time:

```bash
node --test tests/feed-parser.test.js   # parsing
node --test tests/reader-state.test.js  # read/seen state, feed status
```

Note: `node --test tests/` (with a trailing slash and no glob) fails on Node 24 —
it tries to resolve `tests` as a module. Use the glob form above.

Requires Node.js 18+ (uses the built-in `node:test` runner).

### Test Coverage

180 tests across 27 suites — covering (among other things):

| Area | What it covers |
|------|-----------------|
| `extractTag` | XML tag extraction, CDATA, attributes, case-insensitivity |
| `cleanText` | HTML entity decoding (`&amp;`, `&lt;`, `&#x...;`, `&#...;`), whitespace collapsing |
| `stripHtml` | HTML tag removal, self-closing tags, attributes |
| `getRelativeTime` | Relative timestamps (just now, Xm/h/d ago), locale fallback |
| `extractImageUrl` | media:thumbnail, media:content, enclosure (attribute order independent), inline img, entity decoding |
| `makeItemId` | Stable ID precedence: guid/id -> canonical link -> deterministic djb2 hash; same input always yields the same ID |
| `parseRssFeed` | Full RSS 2.0 parsing, CDATA titles, entity descriptions, image extraction, Dublin Core `<dc:date>` fallback |
| `parseAtomFeed` | Atom feed parsing, attribute-order-independent alternate-link selection, missing-`rel` handling, `rel="self"` avoidance, updated/published dates |
| link entity decoding | `&amp;`/numeric entities decoded in RSS `<link>` and Atom `href` links (e.g. a BBC-style `&amp;` query string, or a numeric `&#233;` entity), so opened URLs are well-formed |
| `parseFeed` | Auto-detection of RSS vs Atom format |
| `parseOpml` | OPML import, feed name/URL extraction, entity decoding |
| `dedupeItems` | Removing repeated items by stable ID |
| `boundIdList` | Dedupe + newest-first bounding at 1000, dropping corrupted entries |
| `evaluateSeen` | Silent first run, new-ID-only notifications, and the regression test that a feed outage plus recovery announces nothing |
| read transitions | Mark read/unread, mark-all, and preserving read history for items outside the current view |
| `classifyFetch` | Timeout (exit 124) reported distinctly from other errors, empty response, and zero-item responses |
| feed migration | A feed with no `enabled` key counts as enabled; only an explicit `false` disables |
| bookmarks | Toggle on/off, bounding, and that a bookmark survives the item being reparsed into a brand-new object (proving it keys off the stable ID, not object identity) |
| search | Tokenizing and lowercasing, multiple terms ANDed across different fields, blank query matching everything, missing fields not throwing |
| `filterItems` | Each filter alone, and search composed with Unread and with Saved, plus an unknown mode falling back to showing everything |
| persistence detection | The real service accepted, the reduced instance shim rejected, half-implemented services rejected, and the resolver preferring whichever can actually persist |
| feed ordering | Configured feed order beating alphabetical source order, newest-first within a feed, unconfigured feeds sorting last, and reordering the config reversing the grouping |
| `toggleBookmark` / `isBookmarked` | Toggling on and off, persistence by stable item ID across reparse, bounding at the same cap as read/seen history |
| `tokenizeQuery` | Lowercasing, whitespace splitting, empty/non-string input |
| search matching | Matches on title, description, and source name; multiple terms ANDed, including across different fields; empty query matches everything; items with missing fields don't throw |
| `filterItems` | All/Unread/Saved modes combined with a search query; search narrows within Unread and within Saved; items with no ID treated as unread and un-bookmarked; unknown mode falls back to showing everything |

## Migration / upgrading from 1.x

- Existing configured feeds keep working with no changes required.
- A feed with no `enabled` key (all feeds saved by 1.x) is treated as enabled — nothing gets silently disabled on upgrade.
- Read/unread state starts empty on first run after upgrading. In 1.x this state lived only in memory and was already reset on every widget reload, so nothing that previously persisted is being lost.

## Screenshots

![RSS Widget on desktop](screenshot.png)

## Changelog

### 2.2.0

- **Behavior change: clicking an item row now always opens the link and marks it read — it never un-reads.** Previously, clicking an already-read item just toggled it back to unread and did not open anything. Combined with read state persisting across restarts (since 2.0.0), this meant re-clicking a previously-read item appeared to do nothing but flip its state, and its link effectively stopped opening. If you rely on links reliably opening, this is the change to know about before upgrading.
- Added a dedicated read/unread checkbox (`check_box` / `check_box_outline_blank`) on each row, separate from the bookmark icon, so you can toggle read state without opening the link. Both controls sit at the row's trailing edge, are always clickable, and render at reduced opacity until you hover the row.
- **Fixed: the bookmark button could not be clicked.** It was bound `enabled: opacity > 0`, and a disabled QML item disables input for its whole child subtree, so clicks fell through to the row instead. Both row controls are now always enabled, and the row's own click area is carved out with a right margin so it can never overlap them.
- **Fixed: could not type in the search field.** The widget now declares `acceptsKeyboardFocus`, gated to when search is open, so it receives compositor keyboard focus only while searching.
- **Fixed: the "Mark all read" control ran off the edge and was cut off.** Filter chips and that control used plain `width:` inside a `RowLayout`, which gives the layout nothing to shrink. All action-row children now use `Layout.preferredWidth`/`Layout.minimumWidth`, and the mark-all control now hides entirely below 160px instead of clipping.
- **Fixed: RSS/Atom links could contain literal HTML entities** (e.g. a BBC link arriving as `...?at_medium=RSS&amp;at_campaign=rss`). Links are now decoded the same way titles and descriptions already were. Verified against the live BBC feed.
- Links now open via `Qt.openUrlExternally()` instead of shelling out to `xdg-open`. A failed open now raises a toast instead of failing silently with no error channel.
- Test suite grew from 177 tests to 180.

### 2.1.1

- **Fixed: widget showed "No items loaded" and never fetched anything when run as a desktop widget instance.** DMS hands desktop-widget instances a reduced `instanceScopedPluginService` that implements only `loadPluginData`/`savePluginData` — it has no `loadPluginState`/`savePluginState`. Calling the missing method threw, and because that call sat at the top of `fetchAllFeeds()`, the exception aborted the fetch before a single feed was requested. With no feeds fetched, no feed reported an error either, so the empty state fell through to its most generic message.
- State access now resolves the real `PluginService` singleton and feature-detects the state API (`hasStateApi`/`resolveStateService`), with every read and write wrapped so a persistence failure degrades to "no persistence" instead of stopping the widget.
- The refresh timer is now armed before reader state is loaded, so nothing in the persistence layer can prevent fetching again.
- Applied the same fix to the settings panel, which read feed status through the same unguarded call.
- Corrected the documented state-file path: it is `~/.local/state/DankMaterialShell/plugins/`, not `~/.local/state/plugins/`.
- Added regression tests that model the real instance shim and assert it is rejected.

### 2.1.0

- Added bookmarks: a bookmark icon on each item row toggles a saved flag, persisted by stable item ID in a new `bookmarkedIds` key in the state file, bounded to 1000 like read/seen history. Bookmarks survive refreshes and reloads, but the Saved view can only display an item that is still in the currently fetched set — there is no local article archive.
- Added search: a toggle button reveals a search field on its own row (kept separate so filter chips stay readable at narrow widths), matching title/description/source name case-insensitively with space-separated terms ANDed across fields, debounced 150ms, and composing with the active filter.
- Filter row is now All / Unread / Saved, each with a live count on Unread and Saved.
- Added feed reordering in settings: move-up/move-down buttons on each feed row, disabled rather than hidden at the list boundaries; reordering swaps whole feed objects and closes any open edit form to avoid it pointing at the wrong feed after a swap.
- **Behavior change:** "grouped by feed" sort mode now groups feeds in the order you arranged them in settings. It previously sorted groups alphabetically by source name, which meant feed order had no effect on the widget at all. Grouping is keyed by feed URL rather than display name, so feeds sharing a name (or with a blank name) still group correctly, and items from a feed you have since removed sort last.
- Added "No matching items" and "No saved items" empty states, each with its own hint line and icon.
- Deliberately did not add a dedicated "Errors" filter view this pass — feed errors are already surfaced by the header's failed-feed indicator and per-feed status in settings.
- Test suite grew from 137 tests (22 suites) to 170 tests (26 suites).

### 2.0.0

- **Single source of truth for parsing**: introduced `FeedParser.js` at the repo root, imported by both `.qml` files and required directly by the test suite. Removed the old `tests/feed-parser.js` mirror.
- Stable item IDs (guid/id -> canonical link -> deterministic hash) replace count-based change detection everywhere.
- Fixed Atom alternate-link selection to be attribute-order independent and to stop incorrectly preferring `rel="self"` over a real alternate.
- Added Dublin Core `<dc:date>` as a date fallback.
- Read/unread state now persists across reloads in the dedicated plugin state file, keyed by stable item ID, bounded to 1000 ids.
- New-item notifications now use a persisted `seenIds` history instead of item-count comparison; no backlog spam on first run.
- Per-feed fetch status (idle/loading/ok/error/timeout/disabled) tracked and surfaced in settings; a failed feed no longer blocks healthy feeds from rendering.
- Fixed a fetch-generation race where two overlapping refreshes could share one result collector and finalize early on a half-filled result set.
- Added manual refresh button, All/Unread filter with live count, per-feed enable/disable toggle, URL validation on add/edit, and a failed-feed count indicator in the header.
- Removed `relativeTime` from the parsed item shape; the widget now computes it at render time and refreshes it on a timer so timestamps don't go stale.
- Extracted reader-state rules into `ReaderState.js` so read/seen bookkeeping, new-item detection, fetch classification, and the feed enable/disable migration are unit tested rather than only reviewable.
- Test suite grew from 60 tests to 137.

## License

MIT
