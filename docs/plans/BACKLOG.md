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
