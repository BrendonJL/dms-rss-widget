# Backlog

Everything agreed but not built, roughly in the order discussed. Design docs
for items that have one are in this directory; `README.md` here indexes them.

Most of this list was cleared on 2026-09-12. What remains is below; what was
done is recorded at the bottom, along with the three items that turned out to
be **wrong rather than outstanding** — worth keeping, because each was
believed for weeks and only measurement settled it.

## Still open

- **Categories / folders.** Miniflux and Google Reader both return them and
  the widget flattens them. Needs the category threaded through the parsed
  item shape (additively — the item shape is a frozen contract), a way to
  enumerate the known categories without walking every item, and a filter in
  the UI. The standard RSS backend has no concept of categories, so whatever
  is built must degrade visibly rather than silently doing nothing on one
  backend — that asymmetry is the fragmentation the backend interface exists
  to prevent.
- **Per-feed refresh intervals.** Today one interval governs every feed. A
  news feed and a weekly blog do not deserve the same poll rate.
- **Audio enclosures to MPRIS**, so podcast feeds play through the DMS media
  widget. `FeedParser.js` already parses enclosures for images, so the parsing
  half largely exists.
- **Miniflux full-text as a fast path.** `GET /v1/entries/{id}/fetch-content`
  works and was measured (936 -> 8412 chars on a real article). Deliberately
  unused so far: a feature that works on one backend and silently does nothing
  on another is exactly the fragmentation above. Worth wiring behind the
  `fullText` capability as an optimisation, and never as the only route —
  local extraction must stay the fallback.

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
- **OPML export**, **feed autodiscovery**, **images in exported notes**,
  **per-source snooze** (`z` / `Shift+Z`), **mark-read-on-scroll**,
  **rule-based notifications**, and **sibling merging** in the extractor.

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
