# Changelog

Newest first. Versions are the ones in `plugin.json`; CI checks that the
version in the manifest has a matching `### <version>` heading in this file.

### Unreleased

Work on `develop` since 2.4.0.

**New: per-article AI summaries**, off by default. A settings section
(`aiEnabled`, a preset picker for ollama/vLLM/llama.cpp/LM Studio/Custom, plus
model and API key fields) and a "Test Connection" button that tells apart an
unreachable runtime, a reachable one missing the configured model (and lists
up to five it does have), and success. A toolbar button in the reader, or `i` from
either the list or the reader, requests a summary on demand — never on render, never on
scroll, never prefetched, because a two-sentence summary of a ~120-word
article measured ~4.8s on this machine, and a widget that quietly runs a
five-second GPU job because it scrolled past an article would be a bad
neighbour on a laptop. Summaries are cached by item id and survive restarts,
since an article's summary doesn't go stale; a generation counter, separate
from the one that guards feed fetches, discards a result that arrives after
the user has moved to a different article rather than rendering it against
the wrong one. With the feature off, or nothing configured, the widget is
completely silent: no affordance, no probe, no error row, no toast.

One thing shipped differently than designed: the feature toggle was meant to
be per-instance, so a small ticker widget could stay dumb while a larger one
summarises. It shipped global instead, because every setting in this plugin
is keyed by plugin id, not by instance, and adding the DMS plugin-variant
system for one boolean was disproportionate. Recorded as a known deviation in
the design doc rather than fixed quietly. The connection settings (base URL,
model, key) are global as designed — nobody wants to retype an endpoint into
three instances of the same widget.

The base URL is **resolved**, not stored: what you typed wins, otherwise the
chosen preset supplies one. That is deliberate rather than incidental. The
first cut filled the field from the preset dropdown's change handler, which on
a fresh install never fires — the dropdown loads its default, which equals the
default it already holds, so no change is emitted and nothing is written. The
field then showed a placeholder that looks exactly like a value, so the form
appeared complete while "Test Connection" correctly reported an empty base
URL. A default has to be resolvable without an event having fired.
`AiProvider.resolveBaseUrl` is that resolution, shared by the settings panel
and the widget so the two cannot disagree, and pinned by tests.

`i` means the same thing wherever you press it: summarise the article in
front of you. In the reader that is the open article. In the list it opens the
reader on the cursor row showing **only** the summary, with no fetch of the
article's own page — the point of that mode is deciding whether the article is
worth opening at all, and fetching it anyway would defeat the reason for the
mode. A "Load full article" button is there if the summary earns it, and runs
the same fetch-and-extract path `v` does rather than a second copy of it.

Summarising from the list deliberately does **not** mark the item read. Reading
a summary is not reading the article, and an item you skimmed and passed over
must still be there next time you filter to unread — otherwise the feature
quietly empties your unread list on your behalf. The cursor still moves, since
you did look at that row.

It is a row action, never a selection action, even though `m`/`s`/`e` all act
on the whole selection when one exists. Summarising a forty-item selection
from one keystroke would be forty GPU jobs, which is the single thing every
other decision here is shaped to avoid.

`i` rather than the mnemonic `s`: `s` already toggles a star everywhere else,
and one finger meaning two different things depending on which window has
focus is worse than a binding with no mnemonic. It is reader-only and
deliberately not routed through `resolveKey`, so `i` stays unbound in the
list; `tests/key-map.test.js` pins that, because the day `i` also means
something in the list is the day the reader's binding becomes ambiguous.

**New: notes export.** Select articles (or just put the cursor on one) and
press `e`, or use the Export button in the selection bar. Notes are markdown
files written to a folder you choose, with YAML frontmatter, the article text
and a link back to the source. Providers: a plain markdown directory, Obsidian
(vault name, `obsidian://` open, wikilinks) and Neovim. The action is hidden
entirely until an export folder is set, so an unconfigured widget stays silent.
Writes go through Quickshell's `FileView` with `atomicWrites`; one toast
reports the batch, and a failure names the first article that failed and how
many succeeded rather than abandoning the rest.

Tags are written to the frontmatter only. They used to be repeated in the note
body as `[[rss]]`, which every markdown tool already reads from the
frontmatter, so the body line was only ever something to delete in every note.

**New: local full-text extraction** (`HtmlExtract.js`), off by default. With it
on, export fetches each article's own page and extracts the body instead of
using the feed's summary; `extracted: true|false` in the frontmatter keeps a
mangled extraction distinguishable from a deliberate summary, and a fetch
failure degrades that one note to its summary.

The extractor is a quote-aware tokenizer rather than a pile of regexes: token
stream, then a tree, then one bottom-up stats pass, then scoring on
`charCount + commas + paragraphs` multiplied by `(1 - linkDensity)²` with a
bonus for `article`/`main`. Link density is what separates prose from
navigation, and squaring it makes that decisive.

Quality is **measured, not asserted**. `tests/oracle/` runs Mozilla
Readability — Firefox Reader View's algorithm — in headless Chromium over 18
real articles and compares: **mean 92.4%**. That is why the zero-dependency
extractor stays; neither a runtime browser nor a vendored Readability plus a
DOM shim buys enough to justify itself. Nothing in `tests/oracle/` ships with
the plugin.

Two things the oracle caught that unit tests could not:

- **Index pages over-extract**, where Readability correctly returns nothing.
  Two independent signals now reject a result: link density above 50%, and a
  character-weighted short-unpunctuated-line fraction above 70%. The first
  attempt counted fragment *lines* and dropped the mean from 91.1% to 62.6% —
  real Wikipedia and MDN articles false-positived, because trailing navboxes
  contribute hundreds of tiny link lines beneath a few long paragraphs.
  Character-weighting fixed it; fenced code is excluded from the tally, after
  an LWN article that is mostly a quoted email in a `pre` block.
- **A missed argument in `emitList`** threw `opts is not defined` on 14 of 20
  real pages while all 689 unit tests stayed green. The guard is per-fixture
  now: every fixture must extract without throwing, with options, with empty
  options, and with none.

Bounded against pathological input: 20MB of 400k paragraph tags terminates in
184ms via a token cap rather than hanging.

**Fixed: relative links in extracted articles went nowhere.** Genuine anchors
in the article — site-relative `/news/articles/x` — resolve on the publisher's
site and to nothing in a markdown file, which is worse than no link because the
reader tries them. Hrefs now resolve against the article's own URL.
Site-relative, protocol-relative, document-relative and `../` all become
absolute; in-page anchors and anything unresolvable degrade to plain text,
keeping the words and dropping the dead target.

**Fixed: "Recommended stories" promo blocks landed in exported notes.** They
are spliced between paragraphs, inside the article container, with no class a
boilerplate filter catches. Two shapes are handled on different evidence: a
labelled section (`## Recommended Stories`, then the list) is dropped up to the
next heading of the same or higher level, since the publisher is stating
outright that what follows is not the article; an unlabelled bare list of
headline links is dropped only when *all* of link-only items, at most five
items, and prose on both sides hold — a long run of link-only blocks is a
reference list and real content. Oracle mean unchanged at 92.4%.

**New: open the note in any editor.** The file written is identical in every
case, so only the command that opens it differs. The open action is a `{path}`
template with presets for **VS Code**, **Zed**, **Emacs**, **Neovim** (running
instance via `$NVIM`, and terminal), **Helix**, **Vim**, **Obsidian** and
**None**, plus **Custom**. A preset fills the field and the field stays
editable, which is the difference between supporting an editor and supporting
your setup. The terminal presets say `kitty` because that is what the author
runs; the field description says to edit it.

`{path}` is substituted as its own argv element and never concatenated into a
shell string — verified against a filename containing a semicolon, quotes and
spaces, which lands as exactly one argument. Environment variables are
deliberately not expanded. Existing `obsidian`/`neovim` settings migrate to
their equivalent presets; presence of the `exportOpenCommand` key, not its
value, is what marks a config as legacy.

**New: a reading window** (`v`, or the book icon on a row). A floating window
showing one article at a readable measure, which is the one thing the widget
structurally cannot do — a widget is sized for a corner of a desktop and prose
is not. The measure is computed rather than hardcoded
(`FontMetrics.averageCharacterWidth * 68`), so 60–75 characters holds at any
theme font scale or family, centred and capped against the window width so
dragging it wider adds margin instead of line length. Fetch and extraction
reuse the export path exactly, so there is no second fetcher to drift.

**Typography in the reader is ours, not Qt's.** `MarkdownText`'s per-heading
font scaling ignores the item's own `pixelSize`, so heading blocks have their
leading `#`s stripped before they reach it, leaving a plain string whose size
and weight we fully control while `MarkdownText` still handles inline emphasis
and links. Each block is classified and given explicit metrics relative to
`bodyFontSize`, so the scale moves together. The body is split on blank lines
into one `Text` per block inside a `ColumnLayout` whose spacing *is* the
paragraph gap, because Qt gives no control over inter-paragraph spacing inside
one Markdown block; fenced code is guarded so a blank line in a sample does not
split it.

`normalizeForReader` drops a leading H1 when it matches the title, demotes the
rest so the body's top level is H2, and drops bylines and section links before
the first paragraph. It runs in the **reader only** — an exported note has no
window header, so it keeps its H1. Adds an optional `readerFontFamily` for
anyone whose DMS UI font is not reading-friendly; the default is unchanged.

**Fixed: the editor closed itself a few seconds after opening.** It was
launched through `Proc.runCommand`, which applies a default timeout and kills
what it spawned — right for a command that returns output, wrong for a
long-lived editor. It uses `Quickshell.execDetached` now, as DMS itself does.
Still argv only, never a shell string.

**Fixed: closing the reader left keyboard focus nowhere**, so `Esc` did not
land you back on the list and `j`/`k` did nothing until the pointer happened to
be over the widget. The window hands focus back on close. Under layer-shell
`OnDemand` this asks rather than guarantees — the compositor decides — so a
click may still be needed.

**Fixed: multi-article export wrote one file.** One `FileView` was driven
through a queue, but assigning `path` starts a background load (`preload`
defaults true) and `setText` fired before it settled, so later writes hit the
old path or vanished. There is now one `FileView` per note, created with
`preload: false` and destroyed when it finishes, so no shared mutable path is
left to interleave. (`blockLoading` would not have fixed it: per quickshell's
`fileview.hpp` it only makes `text()`/`data()` block, not the path assignment.)

**Fixed: two long titles could produce the same filename.** Making writes
parallel turned that latent collision into silent data loss.
`clampFilenameBytes` truncated the assembled title-hash from the end and ate
the hash; the title is now clamped with the hash and extension reserved, so the
disambiguator always survives. Verified across ASCII and CJK titles at the
255-byte boundary.

**Fixed: the Tags field would not accept a comma.** It saved on every
keystroke, which re-ran the join and rewrote the field under the cursor,
discarding the comma just typed. It commits on Enter or focus loss now.

**Fixed: keys only worked after clicking an article.** `keyboardScope` is a
`FocusScope` around the list and only a row click focused it, so clicking the
header, the chips or empty space left every key dead. A `TapHandler` on the
root grants focus on any click, skipped when the search field already has it.

**Changed: `m` and `s` are selection-aware.** They act on the whole selection
when one exists, which is the model `Space` implies — gather, then act. The
decision is made in `KeyMap.js` and returned as distinct actions, so the widget
routes rather than re-deciding, and the read variant inherits the button's
state-awareness: an all-read selection flips to unread.

**Fixed: Tab could still walk focus out of the keyboard handler**, after which
`j`/`k` went dead with no way back but a click. The widget now has **no Tab
stops at all** — one cursor, `j`/`k` moves it, `/` reaches search, `Esc`
leaves; controls stay reachable by mouse and by `m`/`s`/`Space` on the cursor
row. Bidirectional Tab/cursor sync was rejected for a concrete reason:
`DankActionButton` sets `activeFocusOnTab` and its own `Keys.onPressed`
consumes Space, Return and Enter, so tabbing onto a row control would hijack
the very keys that select and open. A test enumerates every tabbable type in
the QML and fails if one lacks `activeFocusOnTab: false`.

**Internal.** `ReaderState.js` gains a bounded AI summary cache (`addSummary`,
`getSummary`, `hasSummary`, `pruneSummaries`) capped at 100 rather than the id
lists' 1000, because those store ids and this stores paragraphs and the whole
state file is rewritten on every change. `""` is a real cached value, so
`getSummary` returns `null` for unknown ids. Test suite grew from 610 to 749.

### 2.4.0

**New: Google Reader API support.** Adds FreshRSS, Tiny Tiny RSS (via its
plugin), Inoreader, TheOldReader and BazQux as sources — one protocol rather
than one integration each. Select **Google Reader** as the source mode and
enter your server URL, username and password. On Miniflux and FreshRSS these
are the API credentials from the server's integration settings, not your web
login. Verified end to end against both.

**New: keyboard navigation.** Click the widget once, then drive it: `j`/`k` to
move, `o` or `Enter` to open, `m` to toggle read, `s` to save, `Space` to
select, `g g`/`G` for top and bottom, `/` to search, `r` to refresh, `A` to
mark all read. Press `?` for the full list. `Esc` unwinds one layer at a time —
it closes the help, then search, then a selection, then the cursor, so it never
destroys a selection you were part-way through building.

**Fixed: mark-as-read never reached Miniflux.** Every read you made in Miniflux
mode stayed local. The API types `entry_ids` as `int64` and the widget sent
strings, so the server rejected the whole request with HTTP 400. Starring was
unaffected, because it puts the id in the URL path where the type is never
checked — which is why the bug survived: half the feature worked.

**Fixed: Miniflux API errors were silently discarded.** `curl` exits 0 on an
HTTP 400, and the widget only reacted to a non-zero exit, so every API failure
vanished without a toast, a log line or any other trace. This is what hid the
bug above. Requests now use `--fail-with-body`.

**Fixed: the settings panel showed stale feed status.** It re-read the status
list only when the panel opened, so a feed added while it was already open read
"Not fetched yet" indefinitely — even after the widget had fetched it and
recorded a real result. It now refreshes while visible.

**Fixed: search could not be typed into until you clicked it twice.** DMS maps
a plugin's `acceptsKeyboardFocus` onto layer-shell `OnDemand`, which grants
keyboard focus only on a click landing while the surface is *already*
focus-eligible — which it was not at the moment the search toggle was clicked.

**Fixed: the search button disappeared while items were selected**, and
**selecting items then searching silently dropped the selection.** Selection is
now pruned against the whole dataset rather than the visible list, so it
survives a filter change; the count reports how many of the selected items are
currently hidden.

**Fixed: two feeds sharing a URL rendered each other's names.** Fetch results
were matched to feeds by URL; they are matched by position now.

**Improved: readable fetch errors.** "Could not resolve host" rather than
"curl exit 6", keeping the code in parentheses for bug reports.

**Improved: bulk mark-read is state-aware**, flipping to "Mark unread" when
every selected item is already read.

**Internal.** The widget no longer branches on the source mode anywhere: 17
`sourceMode ===` checks became one dispatch point, with backends exposing
capabilities and returning request descriptors that the QML layer executes.
This is what made a third backend a new file rather than a new branch in
twenty places. Test suite grew from 240 to 610, including live suites that run
the widget's own generated requests against real Miniflux and FreshRSS
servers — both Miniflux bugs above were invisible to the unit tests, because
the requests were well-formed and the *server* rejected them.

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
