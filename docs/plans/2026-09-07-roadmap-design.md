# Design: v3 roadmap

Date: 2026-09-07
Status: agreed in principle; per-phase specs still to be written
Scope: architecture for everything after the 2.3.x line

> **Status as of this audit:** Phase 0 (backend interface) and Phase 1
> (Google Reader, minus the settings UI) are implemented. Phase 3 (AI) and
> Phase 4 (export) exist only as unwired JS modules + tests (stages 3a/4a) —
> no UI integration yet. Phase 2 (keyboard navigation) and Phase 5 (reader
> app) have not been started. See each phase's own design doc for detail.

## Guiding principle

Every external thing this widget talks to — feed backend, AI runtime, notes
app — gets an **interface with presets**, never a hardcoded vendor. Where a de
facto standard protocol exists, the interface *is* that protocol and each
"provider" collapses into a base URL plus a label. That keeps the provider count
from becoming a code-path count.

Two protocols make this cheap, and both were verified rather than assumed:

- **Google Reader API** is spoken by FreshRSS, Tiny Tiny RSS (via plugin),
  Inoreader, TheOldReader, BazQux *and* Miniflux. One client, six backends.
- **The OpenAI-compatible `/v1/chat/completions` endpoint** is spoken by ollama,
  vLLM, llama.cpp's server, LM Studio and LocalAI. Verified locally against this
  machine's ollama: `GET http://localhost:11434/v1/models` → `HTTP 200` with an
  OpenAI-shaped `{"object":"list","data":[...]}` body. One client, every local
  runtime.

Transport for all of it stays what the Miniflux integration already uses:
`Proc.runCommand(null, argv, cb, undefined, timeoutMs)` with curl, argv as an
array, never `sh -c`, secrets always their own argv element
(`DankRssWidget.qml:738-771`).

---

## Phase 0 — Backend provider abstraction (blocks almost everything)

`sourceMode` is a two-valued string branched on inline in roughly ten places
(`DankRssWidget.qml:344, 382, 407, 421, 470, 510, ...`). Two values work as an
if/else. Three is where the branch you forgot to update ships as a bug.

Extract an interface before adding a third mode:

```
fetch(cb)                  -> items[]        // normalised, id-prefixed
markRead(ids)              -> void
markUnread(ids)            -> void
toggleStar(id)             -> void
reconcile(serverEntries)   -> {readMap, bookmarkMap}
capabilities               -> { serverState, star, subscribe, categories, fullText }
```

`capabilities` is what stops the UI from growing its own `if (sourceMode ===
...)` branches: the star button asks `backend.capabilities.star`, not which
backend it is. Fever, whenever it lands, is the case that proves this — it is
read-only in Miniflux, so it reports `subscribe: false` and the subscribe UI
disappears without a single mode check.

Implementations: `StandardBackend` (direct feed fetching, local state) and
`MinifluxBackend` (lifted verbatim from today's branches — behaviour-preserving,
no fixes smuggled in). Id prefixes stay as they are (`g:`/`l:`/`h:`/`m:`,
`FeedParser.js:395-401`); Google Reader gets its own.

This is a pure refactor. It must land with the existing suite green and no
observable behaviour change, as its own PR, before Phase 1 starts.

## Phase 1 — Google Reader API backend

A third implementation behind Phase 0's interface. ClientLogin token flow,
`/reader/api/0/stream/contents`, `edit-tag` for read/starred. Ships with a
Miniflux-hosted round-trip test since Miniflux speaks it too — the one backend
we can test locally against a server we already run.

**Fever API is explicitly deferred.** It buys FreshRSS + TT-RSS, both of which
Google Reader already covers, and it is read-only in Miniflux. Reconsider only
if a contributor wants it for a backend that speaks nothing else.

## Phase 2 — Keyboard navigation

Depends on the hover/focus fix in the search-fixes design doc, which is what
makes the surface reliably focusable at all.

Accepted constraint: the wrapper gives us `WlrKeyboardFocus.OnDemand`, so focus
arrives only after a click on the widget. Driving it from cold would need
`Exclusive`, which swallows every compositor key. **Click-then-drive is the
intended model, not a limitation to design around.**

Bindings (Miniflux/vim conventions, so muscle memory transfers):

| Key | Action | Key | Action |
|---|---|---|---|
| `j` / `k` | next / prev | `Space` | toggle checkbox |
| `o` / `Enter` | open | `/` | focus search |
| `m` | toggle read | `Esc` | close search, else clear selection |
| `s` / `f` | toggle star | `r` | refresh |
| `g g` / `G` | top / bottom | `A` | mark all read |

Needs: a `currentIndex` on the ListView, a focus ring visually distinct from
hover, and `positionViewAtIndex` so the cursor never leaves the viewport.
`Esc` is deliberately layered — closing search before clearing selection — so it
never destroys a selection the user is mid-way through building.

## Phase 3 — AI provider (`AiProvider.js`)

**Interface:** OpenAI-compatible chat completions. A provider is
`{ label, baseUrl, model, apiKey?, timeoutMs }`. Nothing else.

Presets: `ollama` (`http://localhost:11434/v1`), `vLLM`
(`http://localhost:8000/v1`), `llama.cpp`, `LM Studio`
(`http://localhost:1234/v1`), plus `Custom`. Adding a runtime later is a row in
a presets table, not a code path.

Deliberately **not** using ollama's native `/api/generate`. It would work today
and lock out every other runtime tomorrow, which is the exact thing this phase
exists to avoid.

Features on top, in order:

1. **Per-article TL;DR** — on-demand button, result cached against the item id.
2. **Digest** — "last 24h across all feeds in six bullets", one call over
   titles + descriptions.
3. **Interest ranking** — embeddings via `/v1/embeddings`, rank unread by
   similarity to starred. Highest risk here: ranking that feels wrong is worse
   than none. Ships behind a default-off toggle with a visible "why this ranked
   high" and an obvious escape back to reverse-chronological.

Model choice note carried over from Brendon's nvim work: this needs an
**instruct** tag, not a `-base` tag. A base model continues text rather than
following the summarise instruction. That trap already cost a day once.

Degradation: no runtime reachable → AI affordances hide entirely. No error
toasts on a laptop that simply is not running ollama today. The widget must be
completely usable, and completely quiet, with no AI configured.

## Phase 4 — Notes / export provider (`ExportProvider.js`)

**Interface:** write a markdown document somewhere. Verified mechanism —
`Quickshell.Io`'s `FileView` with `setText()`, `blockWrites: true` and
`atomicWrites: true`, exactly as DMS itself writes its caches
(`/usr/share/quickshell/dms/Common/CacheData.qml:282-302`).

```
export(article, annotations) -> path
capabilities -> { openAfterWrite, appendToDaily, tags }
```

Providers:

- **Markdown directory** — the base case. A path, a filename template, YAML
  frontmatter. Every markdown tool on earth reads this.
- **Obsidian** — the markdown provider plus vault awareness: vault-relative
  paths, wikilink-style tags, optional `obsidian://open?vault=…&file=…` callback
  to jump to the note. First-class because it is what Brendon uses.
- **Neovim** — the markdown provider plus an optional `nvim --server … --remote`
  to open the file in a running instance.

**Evernote is not planned.** Its local API was retired; the only integration
paths left are email-in and manual import, neither of which fits this interface.
If someone wants it, the markdown provider plus their own sync script is the
honest answer.

The insight worth keeping: Obsidian is not an integration, it is *a directory of
markdown files*. Building the file writer first and treating Obsidian as a
configured instance of it is what makes neovim and everything else nearly free.

## Phase 5 — Reader / annotation app

A standalone Quickshell window (DankCalendar-shaped), launched from the widget.
The widget stays the glanceable list; the app is where reading happens.

- Full-text fetch (already a single API call in Miniflux mode).
- Reading-optimised typography, images, no chrome.
- Highlights and margin notes.
- One action to push the article plus its annotations through Phase 4.

**The hard problem is anchor stability**, not the UI. A highlight must survive
the article being re-fetched with different whitespace, an added subscribe
banner, or a rewritten wrapper. Character offsets will not survive any of that.
Store `{ exactQuote, prefixContext, suffixContext }` and re-locate by fuzzy
match on load — the model the W3C annotation spec settled on for the same
reason. An anchor that fails to relocate degrades to an orphaned note attached
to the article, never a highlight silently landing on the wrong sentence.

Depends on Phase 4. Blocked on the open questions below.

## Phase 6 — Small items, independent of everything above

Any of these can be picked up by a contributor at any time.

- **Feed autodiscovery** — paste `arstechnica.com`, find the feed. Best
  value-per-line on the whole roadmap; today you must already know the feed URL.
- **OPML export** — import exists (`DankRssWidgetSettings.qml:886`), export does
  not. A tool you cannot leave is a bad look for an open one.
- **Categories/folders** — Miniflux returns them; we flatten them.
- **Per-feed refresh intervals** — hourly feeds should not poll like minute ones.
- **Audio enclosures → MPRIS** — `FeedParser.js` already parses enclosures for
  images. Podcasts would appear in the DMS media widget like any other track.
- **Rule-based notifications** — upgrade "notify on new items" to "notify on
  *interesting* items". The matcher already exists as the search filter.
- **Mark-read-on-scroll**, **per-source snooze**, **oldest-first sort**.

---

## Sequencing

```
search fixes ──> Phase 2 (keyboard)
     │
     └────────> Phase 0 (backend interface) ──> Phase 1 (Google Reader)
                                          └──> Phase 3 (AI) ──┐
                                                              ├──> Phase 5 (reader app)
                                               Phase 4 (export)┘
```

Phase 3 before Phase 5 on purpose: the AI work is a weekend that tells us whether
local-model features feel good at all, and if they do, Phase 5 launches with a
much stronger feature set than it would alone.

Phase 6 runs in parallel throughout — it is the contributor on-ramp.

## Decisions (2026-09-08)

1. **The reader app ships in this repo, as a second connected plugin.** Shares
   `ExportProvider.js`/`FeedParser.js` directly rather than duplicating them, and
   one registry listing covers both.

2. **Opening an article: a default plus a right-click escape hatch.**
   A setting picks what a plain click does (reader app / browser); **right-click
   opens a small context menu** offering the other, plus related per-item actions
   (copy link, mark unread, send to notes). Not a bare toggle: that fails on
   exactly the articles the reader cannot serve — paywalls, heavy JS, video,
   anything needing a logged-in session — and if escaping means a trip to
   settings, people leave it on "browser" and the reader goes unused.

   **Implementation note (verified 2026-09-08):** DMS ships **no reusable
   context-menu component**. `DankCommon/Widgets/` has 44 components and none is
   a menu; every context menu in the shell (`Modals/Clipboard/`,
   `Modals/FileBrowser/`, `Modules/ProcessList/`) is bespoke and lives outside
   the `qs.Widgets` / `qs.Common` / `qs.Services` import surface a plugin gets.
   So this must be hand-rolled. On a layer-shell surface a menu also cannot
   overflow the widget's own bounds without becoming its own surface — budget
   for "menu drawn inside the widget, flipped to stay in bounds," not a free
   floating popup. Item rows currently set no `acceptedButtons`, so they take
   left-click only and will need widening.

3. **Annotations live in plugin state; markdown is an export, not the store.**
   Anchors are structured (`exactQuote`, `prefixContext`, `suffixContext`) and
   round-tripping them through a user-editable markdown file means parsing our
   own bookkeeping back out of prose someone may have reflowed. Plugin state is
   the source of truth; Phase 4 writes a derived note. A hand-edited exported
   note is a copy, and we never read it back.

4. **Phase 1 gets a real FreshRSS instance to test against.** Brendon has no
   non-Miniflux server today and will stand one up. Google Reader support tested
   only against Miniflux is a coin flip on every other backend, so this is a
   prerequisite for Phase 1, not a nice-to-have.

5. **AI config splits by kind: connection global, features per-instance.**
   Base URL, model and API key are set once — nobody wants to retype the ollama
   endpoint into three widget instances, and a typo in one is a confusing
   partial failure. Which *features* are on (summaries, digest, ranking) is
   per-instance, so a small ticker widget can stay dumb while a large one
   summarises. This was raised as "per widget"; the split is the refinement.

6. **`ollama.service` exists** (user unit, enabled, `library=CUDA compute=7.5`
   verified). It runs the `~/.local/bin/ollama` **wrapper**, not the Nix binary
   — the wrapper is the CUDA `LD_LIBRARY_PATH` fix and ollama falls back to CPU
   silently without it.

7. **Phase 0 (backend interface) is next**, ahead of keyboard navigation.

8. **Evernote and Fever stay "not planned"** as written. Revisit only if someone
   asks.

