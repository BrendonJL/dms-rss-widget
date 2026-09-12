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

| Phase | Work | Depends on | Notes |
|---|---|---|---|
| 3b | Per-article summaries, on demand | 3a | The bounded summary cache in `ReaderState.js` is built; the UI is not |
| 3c | Digest — one summary across the unread set | 3b | Design only |
| 3d | Interest ranking | 3b | Design only |
| 6 | Independent smaller items, below | — | |

## Phase 6 / good first issues

Each is self-contained:

- Feed autodiscovery — paste a site URL, find its feed
- OPML **export** (import already exists)
- Categories / folders
- Per-feed refresh intervals
- Audio enclosures → MPRIS, so podcasts play through the DMS media widget
- Rule-based notifications
- Mark-read-on-scroll
- Per-source snooze

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
