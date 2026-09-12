# Backlog

Everything agreed but not built, roughly in the order discussed. Design docs
for items that have one are in this directory; `README.md` here indexes them.

## AI features

`AiProvider.js` is built and measured; the bounded summary cache is in
`ReaderState.js`. Nothing is wired to a UI yet.

- **3b — per-article summaries.** On demand only: ~4.8s per summary measured on
  an RTX 2070 Super with qwen3:8b, which rules out anything automatic. Cached by
  item id, generation-guarded so a late result cannot render against the article
  the user has since moved to. Design: `2026-09-10-phase3b-summaries-design.md`.
- **3c — digest.** One call over the last 24h of titles and descriptions.
  Cheaper per item than 3b once its plumbing exists.
- **3d — interest ranking.** Embeddings, ranking unread by similarity to
  starred. Highest risk on the list: ranking that feels wrong is worse than no
  ranking, so it ships default-off with a visible reason and an obvious way
  back to reverse-chronological.

## Accessibility

- **Never signal state by hue alone.** The owner has deuteranopia. Today the
  settings status list uses `Theme.error` red against `Theme.success` green for
  failed versus ok feeds, and unread/read leans on colour. Every state that
  uses colour should also differ in weight, shape or an icon.

  Do this **before** the AI features if possible: it is a small change now and
  three more things to retrofit once summary and ranking indicators exist.
- **Colour themes.** Presets for deuteranopia, protanopia and tritanopia, plus
  custom colours, over the current matugen-only setup. Bigger than it sounds --
  it touches every colour reference in three QML files. Note that a generated
  palette has no reason to preserve contrast between hues a given person cannot
  distinguish, which is why the redundancy rule above matters more than the
  palettes.

## Formerly "good first issues", now ours

The README used to advertise these as a contributor on-ramp. The owner has
decided to take them, so the framing is gone from the README.

- Feed autodiscovery -- paste a site URL, find its feed. Best
  value-per-line on the list; today you must already know the feed URL.
- OPML **export** (import exists).
- Categories/folders -- Miniflux and Google Reader both return them and the
  widget flattens them.
- Per-feed refresh intervals.
- Audio enclosures to MPRIS, so podcast feeds play through the DMS media
  widget. `FeedParser.js` already parses enclosures for images.
- Rule-based notifications -- notify on *interesting* items rather than merely
  new ones. The matcher already exists as the search filter.
- Mark-read-on-scroll, per-source snooze, oldest-first sort.

## Other

- **Images in exported notes.** Tabled deliberately. The real decision is
  hotlinking (rots) versus downloading into an attachments folder (correct,
  more plumbing). Most editors render images, so this is worth doing properly.
- **Miniflux full-text as a fast path.** `GET /v1/entries/{id}/fetch-content`
  works and was measured (936 -> 8412 chars on a real article). Deliberately
  not used: a feature that works on one backend and silently does nothing on
  another is the fragmentation the backend interface exists to prevent. Worth
  wiring behind the existing `fullText` capability only as an optimisation, and
  never as the only route.
- **Extraction precision on reference-heavy pages.** Wikipedia extracts at ~81%
  overlap against Mozilla Readability because we emit ~2.5x its volume, pulling
  in reference lists and infoboxes. When a page has no single wrapping content
  container the document root wins by default, and there is no mechanism to
  merge sibling candidates. Acceptable for a saved note; revisit only if it
  starts bleeding navigation.
