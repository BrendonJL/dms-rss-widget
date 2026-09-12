# Backlog

Everything agreed but not built, roughly in the order discussed. Design docs
for items that have one are in this directory; `README.md` here indexes them.

## AI features

`AiProvider.js` is built and measured. 3b is now implemented, on `develop`,
unreleased — see below and its design doc's status block. Nothing beyond it
is wired to a UI yet.

- **3b — per-article summaries. Implemented, unreleased, manually verified.**
  On demand only — though note the *reason* changed: the original ~4.8s
  measurement (RTX 2070 Super, qwen3:8b) no longer rules anything out, since
  llama3.2:3b measures 0.5s warm. Summaries stay on demand because running a
  GPU job per article that merely scrolled past is rude regardless of how fast
  it is. Cached by item id, generation-guarded so a late result cannot render
  against the article the user has since moved to. `i` summarises from the
  reader, or from the list into a summary-only view that does not fetch the
  article's page. Shipped with one deviation from the design: the feature
  toggle is global, not per-instance (the connection settings were always
  meant to be global, and are). Design:
  `2026-09-10-phase3b-summaries-design.md`, whose measurement section was
  rebuilt rather than patched. Manually verified against a live ollama on
  2026-09-12; there is still no automated coverage of QML runtime behaviour.
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

- **Accessible names for icon-only controls. Implemented, unreleased.**
  There were no `Accessible.*` properties and no tooltips anywhere across the
  three QML files — a real gap, unrelated to the colour question above:
  sighted mouse users infer an icon's meaning from its shape and from hover
  text (itself width-gated), and screen reader users got nothing at all.
  Sixty-four bindings now name every icon-only control, with names that track
  state where the control has state, and `Accessible.checked` carrying
  checkbox state rather than being folded into the name text. Design:
  `2026-09-12-accessibility-names-design.md`. Still unverified against real
  assistive tech — there is no `qml` binary here and no screen reader was
  driven against it — so the names are known to be *present* and not known to
  be *good*. Worth one pass with an actual reader before release.
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
- **Extraction precision on reference-heavy pages. Diagnosis corrected;
  sibling merging shipped.** This entry used to say the document root wins by
  default on pages with no single wrapping container, and that references and
  infoboxes were the problem. Both claims were measured against the real
  18-page oracle corpus on 2026-09-12 and neither holds:
  - Root never wins on any Wikipedia page in the corpus —
    `mw-parser-output`/`main.mw-body` wins outright each time, already the
    correct container. Root wins only on `ciechanow.ski` (by a 0.1% margin)
    and `gutenberg.org`, where it is *right*: no wrapping element exists and
    root captures the whole book at 100% overlap.
  - Suppressing infoboxes and reference lists by class was implemented and
    measured: mean **dropped** 92.4% → 90.9%, and Wikipedia RSS collapsed
    83% → 58%. Readability's own output retains the infobox and reference
    list for that page, so stripping them moves us away from the oracle, not
    towards it. Reverted, not shipped.
  - The actual driver of the ~81% floor is markdown link syntax
    (`[text](url)`) fragmenting the word-overlap tokenisation used to score
    against the oracle, plus both extractors legitimately keeping reference
    content. It is substantially a measurement artefact, not an extraction
    defect.

  Sibling merging was built anyway, because the *mechanism* was genuinely
  missing: a winning candidate's qualifying siblings are now folded in
  (`SIBLING_SCORE_FACTOR = 0.25`, plus Readability's relaxed bare-paragraph
  rule). Measured byte-identical across all 18 articles — no page in the
  corpus currently has a fragmented top candidate, so it is proven neutral
  rather than proven beneficial. It is there for the pages that will.
