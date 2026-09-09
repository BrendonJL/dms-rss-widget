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
- **Optional [Miniflux](https://miniflux.app/) mode** — sync with a self-hosted Miniflux server instead of fetching feeds directly, with bidirectional read/unread and starred sync

## Roadmap

Full designs live in [`docs/plans/`](docs/plans/). Contributors welcome on
anything here — the **Phase 6** items are deliberately self-contained and are
the best place to start.

**Done, awaiting release**

- Search focus and search-during-selection fixes — [design](docs/plans/2026-09-07-search-fixes-design.md) — merged
- **Phase 0**, backend provider interface — [design](docs/plans/2026-09-08-phase0-backend-interface-design.md). Every `sourceMode` branch in the widget is gone (17 → 0), leaving one dispatch point. Backends are plain objects in `Backends.js` exposing `capabilities` and request descriptors; QML runs the process and owns nothing else.
- **Phase 3a**, `AiProvider.js` — [design](docs/plans/2026-09-08-phase3-ai-provider-design.md). The client for any OpenAI-compatible runtime. No UI yet.
- **Phase 4a**, `ExportProvider.js` — [design](docs/plans/2026-09-08-phase4-export-provider-design.md). Builds the note path and markdown for the notes providers. No UI yet.
- Two real Miniflux bugs, both shipped in 2.3.3: mark-as-read never reached the server (`entry_ids` must be `int64`, the widget sent strings), and every API error was silently discarded because `curl` exits 0 on an HTTP 400.

**In progress**

- **Phase 1**, Google Reader API — [design](docs/plans/2026-09-09-phase1-google-reader-design.md). Protocol probed against a live server; needs an additive interface change, since the fetch is a chain rather than a set of independent requests.


**Planned** — [full roadmap design](docs/plans/2026-09-07-roadmap-design.md)

| Phase | Work | Depends on |
|---|---|---|
| 0 | ✅ Backend provider interface — replaces the inline `sourceMode` branches | — |
| 1 | 🟡 Google Reader API backend (FreshRSS, TT-RSS, Inoreader, TheOldReader, BazQux, Miniflux) | 0 |
| 2 | Keyboard navigation (`j`/`k`/`o`/`m`/`s`, `/` to search) | search fixes |
| 3 | 🟡 Local AI via any OpenAI-compatible runtime (ollama, vLLM, llama.cpp, LM Studio): per-article TL;DR, daily digest, interest ranking | 0 |
| 4 | 🟡 Notes/export provider: markdown directory, Obsidian, Neovim | — |
| 5 | Reader + annotation app — a standalone window for reading, highlighting and note-taking | 3, 4 |
| 6 | Independent smaller items — see below | — |

**Phase 6 / good first issues**

- Feed autodiscovery (paste a site URL, find its feed)
- OPML **export** (import already exists)
- Categories/folders (Miniflux returns them; we flatten them)
- Per-feed refresh intervals
- Audio enclosures → MPRIS, so podcast feeds play through the DMS media widget
- Rule-based notifications (notify on *interesting* items, not just new ones)
- Mark-read-on-scroll, per-source snooze, oldest-first sort

**Design principle for anything with a vendor in its name:** it gets an
interface with presets, never a hardcoded integration. Feed backends speak the
Google Reader API, AI runtimes speak the OpenAI-compatible chat API, and notes
apps are "write a markdown file to a directory". Adding ollama should not make
vLLM harder, and adding Obsidian should not make Neovim harder.

**Not planned**

- **Fever API** — covers only backends the Google Reader API already reaches,
  and is read-only in Miniflux.
- **Evernote export** — its local API was retired; there is no integration
  surface left that fits the export interface. Use the markdown provider.

## Miniflux mode

Instead of fetching RSS/Atom URLs directly, the widget can act as a front-end for a
[Miniflux](https://miniflux.app/) server. Switch **Source** to *Miniflux* in settings, enter your
server URL and an API token, and hit **Test Connection**.

Switching **Source** to *Miniflux* replaces the RSS Feed Management, OPML Import, and
Quick Add sections in settings with a Miniflux Connection section (they're RSS-only
concepts and don't apply once feeds are coming from your Miniflux server). That section
has:

- **Server URL** and **API Token** fields
- **Mark as read on open** — sync read state to the server as soon as you open/read an item, not just on the next refresh
- **Show starred entries** — switches the fetched set to your Miniflux bookmarks instead of unread entries
- **Test Connection** and **Force Refresh** buttons
- A read-only list of your Miniflux feed subscriptions

In Miniflux mode:

- Unread (or starred) entries are pulled from the server and flow through the same row UI as RSS items — the same selection checkbox, mark-read control, and bookmark icon described above
- Opening an item marks it read locally immediately and, if *Mark as read on open* is on, pushes that read state to the server
- The row's mark-read control also pushes the read/unread change to the server
- The row's bookmark icon toggles the item's **starred** state in Miniflux (there is no separate star button — Miniflux mode reuses the existing bookmark control instead of adding a second one)
- Bulk **Save** / **Mark read** on a selection push to the server too (batched into one API call per action, not one call per item)
- Every successful fetch reconciles server-side read/starred status back into the local read/bookmark state, so the server is the source of truth after each refresh even though local clicks are instant
- Switching back to Standard/RSS mode leaves your RSS feeds' read/bookmark state exactly as you left it — mode switching never clears read or bookmark history in either direction

Create an API token in Miniflux under **Settings → API Keys**.

**A note on the token:** the API token is stored in plaintext in the plugin's settings,
the same way every other setting (feed URLs, refresh interval, etc.) is stored — there is
no separate encryption or keyring for it. Keep that in mind if your DMS settings file is
backed up, synced, or otherwise readable by other tools.

### Planned (not in this milestone)

- A dedicated "Errors" filter view — deliberately skipped this pass; feed errors are already surfaced via the header's failed-feed count indicator and per-feed status lines in settings, and an error view would need a different row type than the item list
- Per-feed color/category labels
- Configurable excerpt length
- Stale-feed warnings
- Copy-link action on items

### Known limitations

- At very narrow widget widths (approaching the 100px floor) the filter chips can still crowd each other. Fully solving it would need chip wrapping or eliding, which is not implemented. At normal sizes (the default and above) this is not visible.
- Compact view rows reserve slightly more vertical padding than their margins strictly need. This is a pre-existing cosmetic issue, not introduced or fixed in this release.
- `acceptsKeyboardFocus` gating search means the search field needs a **second click** before it accepts typing. The DMS wrapper maps this property onto layer-shell `WlrKeyboardFocus.OnDemand` (`Modules/Plugins/DesktopPluginWrapper.qml`), and `on_demand` grants keyboard focus only on a click that lands while the surface is already focus-eligible — which it is not at the instant the search toggle is clicked. Fix designed, see the roadmap.
- The Miniflux settings layout (Connection section, read-only feed list, mode-gated visibility of the RSS-only sections) has not been visually verified in a live DMS session.

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
- A running Miniflux server and API token — only if you use Miniflux mode

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

## Local development

`install.sh` symlinks the repo into `~/.config/DankMaterialShell/plugins/`, so
**the branch you have checked out is the widget DMS loads**. `dms restart` picks
up changes; there is no plugin hot-reload.

Tests:

    node --test tests/*.test.js     # the shared JS modules
    ./tests/qml/run.sh              # QML smoke tests, headless

`tests/qml/run.sh` needs `QT_QPA_PLATFORM=offscreen` **and** `QML2_IMPORT_PATH`;
without the latter the `qml` tool prints only "Did not load any objects" and no
error, which is why this project long assumed QML could not be tested at all.

`tests/live-miniflux.js` and `tests/live-greader.js` are **not** `*.test.js` on
purpose — they need a real Miniflux server and would fail in CI. Run them by
hand against a local instance. They exist because they catch what unit tests
structurally cannot: a request whose argv is perfectly well-formed and which
the *server* rejects. Both Miniflux bugs fixed in this cycle were found that
way and were invisible to 400 passing unit tests.

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

240 tests across 32 suites — covering (among other things):

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
| `parseMinifluxEntries` | Mapping Miniflux JSON entries to the standard Item shape with `"m:"`-prefixed stable ids, id-collision safety against RSS's `makeItemId`, content-over-summary description preference, image extraction (enclosure over inline `<img>`, `isSafeUrl`-gated), and malformed/empty-input handling |
| `reconcileServerStatus` | Server-wins reconciliation of Miniflux read/starred status into local `readOrder`/`bookmarkOrder`: adding/removing entries, no-op when already in sync, mixed batches, cap enforcement, and null/undefined input safety |

## Migration / upgrading from 1.x

- Existing configured feeds keep working with no changes required.
- A feed with no `enabled` key (all feeds saved by 1.x) is treated as enabled — nothing gets silently disabled on upgrade.
- Read/unread state starts empty on first run after upgrading. In 1.x this state lived only in memory and was already reset on every widget reload, so nothing that previously persisted is being lost.

## Screenshots

![RSS Widget on desktop](screenshot.png)

## Related plugins

**[Dank News RSS & Ticker](https://github.com/Xn4m3d/dms-rss-widget)** by
[@Xn4m3d](https://github.com/Xn4m3d) takes the same feeds in a different
direction: a full-width scrolling headline bar that docks under the DankBar or
follows a bottom bar, plus an optional companion pill that shows the same
headlines inside the bar itself. It's registered separately, as
`dankNewsRssTicker` and `dankNewsRssTickerPill`, so it installs alongside this
plugin rather than replacing it.

Rough guide: if you want a desktop card you sit down and read, use this one. If
you want headlines scrolling past while you work, use theirs.

The two share ancestry and fixes flow between them — PRs
[#1](https://github.com/BrendonJL/dms-rss-widget/pull/1),
[#2](https://github.com/BrendonJL/dms-rss-widget/pull/2),
[#3](https://github.com/BrendonJL/dms-rss-widget/pull/3) and
[#5](https://github.com/BrendonJL/dms-rss-widget/pull/5) came here from @Xn4m3d,
as did the parser bugs fixed in 2.3.1 and 2.3.2
([#7](https://github.com/BrendonJL/dms-rss-widget/issues/7)).

## Changelog

**1.0.0 is the only version previously published to the DMS registry.** The 2.0.0
through 2.2.0 entries below were developed but never released — this is the first
published update since 1.0.0, so if you're upgrading from 1.0.0, every entry from
2.0.0 through 2.3.3 applies to you.

### 2.3.3

- **Fixed: HTML markup showed up as literal text in item descriptions.** Feeds
  that entity-encode their description markup — the Guardian, the BBC and many
  others — rendered as `<p>Chancellor says …</p><ul><li>` in the widget. The
  parser stripped tags *before* decoding entities, so the decode step recreated
  tags the stripper had already passed. Descriptions now go through
  `htmlToText`, which strips, decodes, then strips again, so both real and
  entity-encoded markup are removed and a double-encoded description resolves
  to plain text. Measured on the live Guardian feed: 137 of 137 descriptions
  affected before, 0 after.
- Block-level tags (`</p>`, `<br>`, `</li>` …) are replaced with a space rather
  than deleted, since they mark a word boundary: "across the country</p><p>Far-right
  AfD" was rendering as "the countryFar-right". Inline tags are still deleted
  outright, so "un<b>der</b>stand" stays "understand".
- Two tests asserted the old behaviour on the assumption that DMS's
  `StyledText` renders HTML. It doesn't — it sets `textFormat: Text.PlainText`,
  so the markup was always shown to the user verbatim. Corrected.

### 2.3.2

- **Fixed: Atom feeds that put their elements behind a namespace prefix loaded
  zero items.** A document written as `<atom:feed><atom:entry><atom:title>` was
  routed to the Atom parser correctly but then parsed to nothing, because every
  regex in `parseAtomFeed` matches unprefixed tags only — the same silent
  disappearance as the 2.3.1 bug, with a different cause. `parseAtomFeed` now
  normalises away the prefix declared on the root element before parsing.
  Only the root's own prefix is touched, so other namespaces a feed carries for
  extra data (`media:`, `dc:`, `content:`) are left intact, as are `xmlns:`
  attributes. Found while writing the regression tests for 2.3.1.

### 2.3.1

- **Fixed: RSS feeds containing an element whose name starts with "feed" silently
  loaded zero items.** Reported by [@Xn4m3d](https://github.com/Xn4m3d) in
  [#7](https://github.com/BrendonJL/dms-rss-widget/issues/7). Format detection in
  `parseFeed` was a substring test (`xml.indexOf("<feed")`) over the entire
  document, so an RSS 2.0 feed carrying, say, CNBC's `<feed_asset>` or
  FeedBurner's `<feedburner:*>` elements was routed to the Atom parser, which
  found no `<entry>` and returned nothing — the feed just disappeared with no
  error logged. Detection now resolves the document's **root element** (skipping
  the XML declaration, processing instructions, comments and DOCTYPE, and
  stripping any namespace prefix), so `<rss>` and RSS 1.0's `<rdf:RDF>` go to the
  RSS parser and only a genuine `<feed>` root goes to Atom. Verified against the
  live CNBC feed: 0 items before, 30 after.

### 2.3.0

- **Community contributions merged, not reimplemented.** Five community PRs, previously merged into git history but absent from the working tree pending this rewrite, are now ported onto the current architecture (stable item IDs, `ReaderState.js`, persisted read/bookmark state, selection model):
  - **#1 and #5 (Xn4m3d): security hardening and the overlapping-fetch fix.** curl's protocol/redirect/response-size limits and a `null` Proc id plus stale-run token so an overlapping fetch can no longer deliver one feed's output to another feed's callback and produce duplicate items.
  - **#2 (Xn4m3d): loading state.** Shows a loading state instead of a blank flash when the widget is recreated on resize.
  - **#3 (Xn4m3d): niri overview click guard.** Clicks on the widget are ignored while the niri overview is open, and for a short release window after it closes, so clicking a workspace thumbnail positioned over the widget can no longer land on it and silently open a link or mark an item read.
  - **#6 (alexanderi96): Miniflux source mode.** See below and the new "Miniflux mode" section.
- **Row interaction model**: each row now has a selection checkbox, a separate mark-read control, and a separate save (bookmark) control — all always clickable, independent of hover state. A selection bar lets you bulk **Save** or **Mark read** across everything currently selected.
- **Security hardening** (from #1, carried through the port and applied to Miniflux calls too): link opening and thumbnail loading are gated behind a positive http/https allowlist (`isSafeUrl` in `FeedParser.js`) that fails closed on `javascript:`, `data:`, control characters, and embedded whitespace. Every curl invocation (RSS fetch and Miniflux) is restricted to http/https on both the initial request and any redirect (`--proto`/`--proto-redir`), capped at 5 redirects, and capped at a 5MB download; the response is re-checked for size before being handed to the parser as a belt-and-suspenders measure.
- **Miniflux source mode** (ported from #6): sync with a self-hosted Miniflux server instead of fetching feeds directly. The port moves it onto the stable item ID scheme and the existing persisted read/bookmark store instead of #6's original separate entry-status map — see "Miniflux mode" below for what changed in the UI as a result.

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
