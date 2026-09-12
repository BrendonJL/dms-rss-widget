# Backlog

Everything agreed but not built, roughly in the order discussed. Design docs
for items that have one are in this directory; `README.md` here indexes them.

## AI features

`AiProvider.js` is built and measured. 3b is now implemented, on `develop`,
unreleased — see below and its design doc's status block. Nothing beyond it
is wired to a UI yet.

- **3b — per-article summaries. Implemented, unreleased.** On demand only:
  ~4.8s per summary measured on an RTX 2070 Super with qwen3:8b, which ruled
  out anything automatic. Cached by item id, generation-guarded so a late
  result cannot render against the article the user has since moved to.
  Shipped with one deviation from the design: the feature toggle is global,
  not per-instance (the connection settings were always meant to be global,
  and are). Design: `2026-09-10-phase3b-summaries-design.md`. Unverified at
  runtime — no `qml` binary on this machine — so still needs the owner's
  manual test pass from that doc's checklist.
- **3c — digest.** One call over the last 24h of titles and descriptions.
  Cheaper per item than 3b once its plumbing exists.
- **3d — interest ranking.** Embeddings, ranking unread by similarity to
  starred. Highest risk on the list: ranking that feels wrong is worse than no
  ranking, so it ships default-off with a visible reason and an obvious way
  back to reverse-chronological.

## Accessibility

- **Never signal state by hue alone — already satisfied, verified by audit.**
  This item used to claim the settings status list paired `Theme.error` red
  against `Theme.success` green with no other distinction, and that unread/
  read leaned on colour. An audit (2026-09-12) found that's no longer true,
  and possibly never was as badly as described:
  - `DankRssWidgetSettings.qml:1157-1171` — the ok/error status pairs
    `Theme.success`/`Theme.error` with different icon shapes (`check_circle`
    vs `error`) *and* different status text ("N items" / the actual error
    string / "Disabled" / "Not fetched yet"). Colour there is decorative.
  - `DankRssWidget.qml:2229` — `opacity: isRead ? 0.5 : 1.0` on the whole row;
    `:2369` — the title swaps `surfaceVariantText`/`surfaceText`, a greyscale
    change with no hue shift. Read state survives total colour loss.
  - `DankRssWidget.qml:2236` carries a deliberate comment explaining the
    cursor indicator is a border rather than another fill, because hover and
    selection already use background tints and a third tint would be
    indistinguishable from them.
  - Selection checkbox, bookmark and mark-read toggles all swap icon shape
    (`check_box`/`check_box_outline_blank`, `bookmark`/`bookmark_border`,
    `mark_email_read`/`mark_email_unread`), not just colour.
  - The one remaining hue-only site is the feed-source label at
    `DankRssWidget.qml:2353` (`isRead ? Theme.surfaceVariantText :
    Theme.primary`), and it free-rides on the row's own opacity dimming, so
    it isn't a defect on its own.

  Closing this out; what's actually left is the two items below.

- **Accessible names for icon-only controls.** Zero `Accessible.*` or
  tooltips exist across all three QML files — this is a real, unrelated gap
  from the colour question above: sighted mouse users infer icon meaning
  from shape and hover text (itself width-gated), screen reader users get
  nothing. Design written: `2026-09-12-accessibility-names-design.md`. Not
  yet implemented; no `qml` binary on this machine to verify against, so it
  will need manual/live testing regardless of who implements it.
- **Colour theme presets.** Still wanted — deuteranopia/protanopia/
  tritanopia presets plus custom colours, over the current matugen-only
  setup. Research verdict: feasible and safe, but `Theme` is a `pragma
  Singleton` at `/usr/share/quickshell/dms/Common/Theme.qml`, shared
  process-wide — the plugin must never write to `Theme.*` itself, since that
  would leak into the whole shell (bar, popups, other plugins). The correct
  shape is a plugin-owned palette indirection that reads `Theme` for
  defaults, with two first-party precedents already on this machine:
  `dankDesktopWeather`'s `accentColor`/`customColor`, and
  `bongoCat/dms-common/ColorSettingPlus.qml`. Scope is smaller than
  originally feared: 318 `Theme.` references across the three QML files, but
  only ~177 of those are colours, collapsing into roughly a dozen distinct
  semantic roles. Not yet implemented. `2026-09-11-phase5b-reader-typography-
  design.md` already recorded the decision to do this via indirection, and
  named the hue-redundancy item above as its prerequisite.

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
