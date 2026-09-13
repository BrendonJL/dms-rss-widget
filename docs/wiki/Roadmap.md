# Roadmap

Designs live in [`docs/plans/`](https://github.com/BrendonJL/dms-rss-widget/tree/main/docs/plans).
Contributors welcome — the **Phase 6** items below are self-contained and are
the best place to start.

## Shipped in 2.4.0

- **Phase 0** — backend provider interface. Every `sourceMode` branch in the
  widget is gone (17 → 0), leaving one dispatch point.
- **Phase 1** (1a/1b/1c) — Google Reader API backend, chained-request runner,
  and its settings UI.
- **Phase 2** — keyboard navigation, plus the `?` help overlay.
- **Phase 3a** — `AiProvider.js`, a client for any OpenAI-compatible runtime.
  No UI yet.
- **Phase 4a** — `ExportProvider.js`. No UI at that point.
- Search focus and search-during-selection fixes.

## Shipped on `develop`, awaiting release

- **Phase 3b** — per-article summaries, wired to the UI: settings section,
  Test Connection, cached and generation-guarded on-demand summaries in the
  reader. One deviation from the design — the feature toggle shipped global
  rather than per-instance; see `docs/plans/2026-09-10-phase3b-summaries-
  design.md`.
- **Phase 4b** — notes export wired into the widget: the `e` binding, the
  selection-bar action, and the Notes Export settings section.
- **Phase 4c** — `HtmlExtract.js`, local full-text extraction, measured against
  Mozilla Readability at 92.4% mean, with an index-page guard.
- **Phase 4d** — editor open presets: a `{path}` command template with presets
  for VS Code, Zed, Emacs, Neovim, Helix, Vim, Obsidian and Custom.
- **Phase 5** — the reading window, opened with `v`.
- **Phase 5b** — reader typography: the widget typesets the article rather than
  handing markdown to Qt and accepting its defaults.
- Keyboard fixes: focus on any click, selection-aware `m`/`s`, and no Tab stops
  anywhere in the widget.

## Planned

Almost nothing, which is the point: Phase 3 and Phase 6 both cleared on
2026-09-12/13. What is listed here is what genuinely remains, with the reason
it remains — "not done" and "not done for a reason" are different states and
only one of them tells you whether to just pick it up.

| Phase | Work | Notes |
|---|---|---|
| 6 | MPRIS ownership for podcasts | Half done; the remaining half is large — see below |

**Audio enclosures → MPRIS.** Parsing and playback exist: feeds expose
`audioUrl` and `p` hands it to a configurable player. The stated goal was for
podcasts to appear in the DMS media widget, and that widget lists MPRIS
players — so whether an episode shows up depends entirely on the player. mpv
does not publish MPRIS without the separate mpv-mpris plugin; VLC does
natively. Making it player-independent means the widget registering *itself* as
an MPRIS player: owning playback, transport controls, position and metadata.
That is a much larger feature than "play this enclosure" and is worth deciding
on rather than drifting into.

**Per-feed refresh intervals** shipped in `e490027` — the fetch-path retention
problem that had blocked it is solved. The settings UI for it is still owed;
see the finish-line working log.

## Shipped on `develop`, unreleased

- **Phase 3b** — per-article summaries, on demand, cached and generation-guarded.
- **Phase 3c** — digest of the last 24 hours (`d`), rendered in the reader.
- **Phase 3d** — interest ranking, off by default, with a visible reason when
  it declines to rank.
- **Accessibility** — an accessible name on every icon-only control, and
  colour-vision-deficient palettes over a local palette indirection.
- **Phase 6** — feed autodiscovery, OPML export, categories/folders, images in
  exported notes, per-source snooze (`z`/`Shift+Z`), mark-read-on-scroll,
  rule-based notifications, and the Miniflux full-text fast path.

None of it has been through a release, and most of it has had one round of
real use. Treat it as shipped-but-young.

## Design principle

Anything with a vendor name gets an interface with presets, never a hardcoded
integration. Feed backends speak the Google Reader API, AI runtimes speak the
OpenAI-compatible chat API, notes apps are "write a markdown file to a
directory", and editors are a `{path}` command template. Adding ollama must not
make vLLM harder.

## Not planned

- **Fever API** — reaches only backends Google Reader already covers, and is
  read-only in Miniflux.
- **Evernote export** — its local API was retired.
- **Highlighting and annotation in the reader.** Phase 5 was originally designed
  as a reader *and annotation app*, and was rewritten. The hard part is
  anchoring, not the UI: a highlight has to survive the article being refetched
  with different whitespace or an inserted banner, which character offsets do
  not. Annotation now lives in a real text editor, reached with `e` — which is
  the whole point of the `{path}` preset work in 4d.

Open to a contributor who wants any of the first two.

## See also

- [Architecture](Architecture.md)
- [Sources and Sync](Sources-and-Sync.md)
