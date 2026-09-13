# Backlog

Everything agreed but not built, roughly in the order discussed. Design docs
for items that have one are in this directory; `README.md` here indexes them.

Most of this list was cleared on 2026-09-12. What remains is below; what was
done is recorded at the bottom, along with the three items that turned out to
be **wrong rather than outstanding** — worth keeping, because each was
believed for weeks and only measurement settled it.

## Still open

- **Audio enclosures to MPRIS -- half done, and the honest half is the
  remaining one.** Parsing and playback exist: feeds expose `audioUrl`, and
  "p" hands it to a configurable player. What does NOT exist is the stated
  goal, which was for podcasts to appear in the DMS media widget. That widget
  lists MPRIS players, and whether an episode shows up depends entirely on the
  player: mpv does not publish MPRIS without the separate mpv-mpris plugin,
  which is not installed here; VLC does natively.

  Making it true regardless of player means the widget registering *itself* as
  an MPRIS player -- owning playback, transport controls, position and
  metadata. That is a much larger feature than "play this enclosure", and
  worth deciding on rather than drifting into.

## Done, unreleased

All on `develop`, none exercised in anger yet. The reader should assume every
one of these is *shipped but unproven* until the owner has lived with it.

- **3b — per-article summaries**, **3c — digest** (`d`), **3d — interest
  ranking** (settings toggle, default off). Designs:
  `2026-09-10-phase3b-summaries-design.md` and the 3d notes in this file's
  history. Ranking is the riskiest thing here and the one most likely to need
  revisiting after real use: "does it feel right" cannot be answered by a test.
- **Accessible names** on every icon-only control. Design:
  `2026-09-12-accessibility-names-design.md`. Present, but never driven with a
  real screen reader — known to exist, not known to be good.
- **Colour-blindness presets** (deuteranopia, protanopia, tritanopia) over a
  local palette indirection. The plugin never writes to `Theme`, which is a
  singleton shared shell-wide. Palettes are Okabe-Ito and Paul Tol, cited, and
  their distinctness is asserted through simulated dichromacy rather than
  taken on trust.
- **Per-feed refresh intervals.** The fetch-path problem that kept this open
  is solved: skipped feeds' articles are restored from a retention pool before
  the dedupe, and "no descriptors because everything is disabled" is now
  distinguished from "no descriptors because nothing is due". The decision is
  `ReaderState.isFeedDue`, biased so that anything malformed answers *due* --
  fetching too often costs a request, fetching too rarely loses content. The
  settings UI is still owed.
- **OPML export**, **feed autodiscovery**, **images in exported notes**,
  **per-source snooze** (`z` / `Shift+Z`), **mark-read-on-scroll**,
  **rule-based notifications**, and **sibling merging** in the extractor.
- **Categories / folders** from Miniflux and Google Reader, with a cycling
  filter chip hidden on backends that cannot supply them. Worth knowing: the
  `categories` capability on Google Reader had been `true` and meaningless for
  some time -- set because the subscription list returns them, with nothing
  wired at item level. A capability flag that lies is worse than one that says
  no, since the caller has no way to find out.
- **Miniflux full-text fast path**, behind the `fullText` capability, which
  also already existed and was false everywhere. Strictly an optimisation:
  every failure falls through to local extraction, and the server's HTML goes
  through the same extractor so both routes emit identical markdown.

## Three things this list got wrong

Kept deliberately. Each was plausible, written down in good faith, and false.

- **"Never signal state by hue alone."** Recorded as an outstanding defect;
  an audit found it already satisfied. Feed status pairs colour with distinct
  icon *shapes* and differing text, read state is opacity plus greyscale, and
  the row toggles all change icon shape. The codebase even carried a comment
  explaining why the cursor indicator is a border rather than a third tint.
  The real gap was something else entirely: no accessible names at all.
- **"Oldest-first sort."** Listed as unbuilt. It had shipped, inline in the
  widget, and was exposed in the settings dropdown the whole time.
- **"Extraction precision."** The diagnosis was wrong twice over. The document
  root does *not* win by default on Wikipedia — the correct container wins
  outright every time. And suppressing infoboxes and reference lists, which
  sounds obviously right, measures **worse** (mean 92.4% -> 90.9%, one article
  83% -> 58%) because Readability's own output keeps them too. The remaining
  gap is substantially an artefact of how markdown link syntax fragments the
  word-overlap scoring, not an extraction defect.

The pattern is worth naming: every one of these was a belief about the code
that survived because nothing measured it. The extractor's oracle is the
reason the third was caught, and the reason the other two took longer.

## Post-v3 candidates, from researching other readers

Researched 2026-09-13 across GitHub issue trackers, Hacker News and named
blogs. Evidence quality is recorded per item **because that is the point** --
"two independent projects have had this open for a decade" is a different
signal from "someone mentioned it once", and the list is worth nothing if the
two look the same here.

**Caveat on coverage:** Reddit was unreachable during the research (r/rss,
r/selfhosted, r/linux all returned nothing retrievable via general web search).
Duplicate-item complaints, feed spam and paywalled-content frustration are
plausible but were NOT independently validated. Treat Reddit sentiment as an
open gap, not as checked-and-absent.

### Worth building

1. **Cross-feed deduplication.** Suppress items that appear near-identically
   across mirrors, planets and syndication.
   *Best-evidenced item found.* Miniflux #797 open since 2020 (57 reactions);
   FreshRSS #948 open **ten years** (55 comments). Two independent codebases,
   same unresolved complaint. Pure client-side logic, no vendor surface, and
   fewer rows suits a narrow widget. Medium.

2. **Keyword / regex mute filters, with optional expiry.** Hide items matching
   a pattern, optionally for a fortnight (mute a spoiler term, let it lapse).
   NetNewsWire #1864 is the single largest thread the research found --
   64 reactions, 32 comments -- and users proposed the expiring form
   themselves. Text filtering costs nothing at any width, and it complements
   the embeddings ranking rather than competing with it. Small, or medium with
   expiry.

3. **Feed health transparency.** Say *why* a feed stopped updating -- HTTP
   status, extraction failure, last success -- rather than going quietly
   stale. FreshRSS #8429 puts it directly: it is "currently very vague when it
   encounters issues with feeds". We already surface a failed-feed count that
   names the errors on click; this is the per-feed, over-time version, and it
   pairs naturally with per-feed intervals and snooze. Small-medium.

4. **Explainable ranking.** Show which starred articles an item resembles,
   instead of an opaque score. **`Ranking.explainRank` already exists, tested
   and unwired** -- it returns exactly those structured facts. The research
   validates building its UI: NewsBlur's trainer is repeatedly praised for not
   being a black box, and the NetNewsWire thread on AI (#4665) has users
   arguing the acceptable version is local, optional and non-mysterious --
   which describes what is already built here, minus the explanation. Medium.

5. **Remappable keyboard shortcuts.** NetNewsWire #508, 36 reactions. Given
   how keyboard-first this widget is, a fixed keymap is the obvious complaint
   waiting to arrive. `KeyMap.js` already isolates the decision, so this is
   mostly a settings surface. Small-medium.

6. **Backdating guard on sort.** Feeds that bulk-republish scramble a
   chronological list; FreshRSS #2596 shipped a fix, confirming it is real.
   Small.

### Inferred, not requested -- treat with suspicion

7. **Opt-in age-out of stale unread items.** Not asked for anywhere. It is a
   synthesis of two opposing data points: the "unread count as anxiety"
   critique (a 2023 Dan Q post, and the 2026 reader "Current" built on that
   thesis), against the Reeder 2024 backlash when unread tracking was *removed*
   and at least three named bloggers objected. The lesson from that pair is
   "do not remove unread state", so any version of this must be opt-in and must
   age items out of the count without deleting them. Medium, and the riskiest
   item here.

### Deliberately not doing

- **Unified social/RSS/video timelines** (the direction Reeder took) -- needs a
  card canvas, and was actively disliked by Reeder's own users.
- **Dashboard-style AI reports** (Inoreader) -- does not compress into a few
  hundred pixels.
- **LDAP / Active Directory auth** -- FreshRSS's most-reacted open issue (#1053,
  44 reactions), and entirely irrelevant to a single-user widget. A reminder
  that raw reaction counts are not transferable between products.
- **A read-it-later queue** -- redundant with markdown export, which already
  serves "keep this" through a file interface rather than another inbox.
- **A newsletter-to-RSS bridge** -- would mean running hosted infrastructure.
  Users can already point the widget at Kill the Newsletter's output like any
  other feed, so there is no product work to do.

### Confirmed strengths, worth saying out loud in the README

Each of these is something users of other readers are actively missing:

- **Google Reader API sync** -- a Mozilla Bugzilla ticket for Thunderbird sync
  has been open **twenty years** (#308436); Liferea rewrote for it.
- **Local full-text extraction** -- that same ticket calls full-article caching
  "a massive gap in the market".
- **Vim-style keyboard navigation** -- the most consistent praise cluster in the
  whole research set, four independent 2024-25 posts about Newsboat.
- **Per-feed refresh intervals** -- Miniflux #412, 47 reactions, still open there.
- **Local, opt-in AI rather than a cloud upsell** -- the exact axis on which
  Feedly Leo and Inoreader Intelligence are criticised.
- **Podcast enclosures without a second tool** -- Newsboat users need podboat.

## Two larger ideas, post-v3

### SQLite for widget state — viable, and it changes an architectural constraint

**Verified:** `QtQuick.LocalStorage` (Qt's SQLite binding) is present in both
the system Qt and the Nix one, and a create/insert/select round-trip works
under the headless engine. So this is a real option, not a hope.

The case for it is stronger than "JSON is untidy". Every cap in this widget
exists *because* persistence is a whole-file rewrite:

- `idHistoryCap` = 1000 on read/seen/bookmark ids.
- `summaryCap` = 100, and the comment says why plainly — those entries are
  paragraphs, not ids, so the map is tens of KB rewritten on every change.
- Ranking embeddings are **not persisted at all**, because a few hundred items
  of 768 floats is megabytes of JSON in a file shared with the rest of the
  shell.

With a database, all three of those constraints go away. Read history could
span years. Summaries would never be evicted. Embeddings could persist, which
would make interest ranking instant on startup instead of re-embedding every
session. That last one is the biggest single win available.

**The cost is real and worth stating before starting.** This project's
discipline is that logic lives in pure modules testable under Node, and QML
does I/O. `LocalStorage` is QML-only, so anything expressed as SQL leaves the
tested half of the codebase — `boundIdList`, `addSummary`, `pruneSummaries`
and friends become `DELETE ... WHERE` and stop being covered by the 1098 tests.
That is the same structural blind spot that has produced most of this project's
shipped bugs.

Mitigation if it goes ahead: keep the modules as the source of truth for
*decisions* (what to evict, what counts as due) and let SQL do only storage and
retrieval, rather than moving the reasoning into queries. And migrate from the
existing JSON on first run rather than asking anyone to start over.

Effort: large. Worth doing mainly for the embeddings.

### AI fact-checking — not in its obvious form

Worth writing down why, because it sounds good and is the one AI feature here
that could actively harm the user.

A local 3B model asked "is this claim true" will answer confidently and be
wrong a meaningful fraction of the time. It has no retrieval, its knowledge is
frozen at training time, and news is precisely the domain where that is worst.
Presenting that output next to an article implies a verification that did not
happen, and a wrong "verified" is worse than no check at all — the user would
be *less* well informed than before. Every other AI feature here fails safely:
a bad summary is obviously a bad summary. A bad fact-check is invisible.

There are two adjacent features that are genuinely good, use infrastructure
that already exists, and make no truth claims:

1. **Related coverage.** "Three other feeds are carrying this story" —
   cross-referencing the user's own subscriptions using the embeddings already
   computed for interest ranking. It surfaces corroboration without asserting
   it, which is what a reader actually wants: several independent outlets
   beats one model's opinion. It also shares almost all its machinery with
   cross-feed deduplication above, so the two should be built together.
2. **Claim extraction without adjudication.** Pull out the checkable assertions
   and who is quoted making them, leaving the judgement to the reader. Useful,
   honest, and within what a small local model can actually do.

If real fact-checking is ever wanted, it needs retrieval against sources —
which means either a hosted service or a local index, both of which are larger
than this widget. The version worth building is (1).
