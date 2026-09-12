# Plans index

Design docs and historical records, newest work first. "Status" here is about
whether the doc describes current reality, not whether it's well-written.

**Shipped in 2.4.0:** search fixes, Phase 0, Phase 1 (1a/1b/1c), Phase 2.
**On `develop`, unreleased:** Phase 4 (4a/4b/4c/4d), Phase 5 (5, 5b).
**Not built:** 3b, 3c, 3d.

| Doc | Covers | Status |
|---|---|---|
| `2026-09-11-phase5b-reader-typography-design.md` | Reader typography (block classification, explicit metrics, colour theming) | implemented — unreleased |
| `2026-09-11-phase5-reader-app-design.md` | The reading window (measure, markdown rendering, focus return) | implemented — unreleased; supersedes the annotation-app design of the same date |
| `2026-09-11-phase4d-editor-presets-design.md` | Editor open presets (`{path}` template, legacy config migration) | implemented — unreleased |
| `2026-09-11-phase4c-fulltext-design.md` | Local full-text extraction (`HtmlExtract.js`, index-page guard, the Readability oracle) | implemented — unreleased |
| `2026-09-10-phase3b-summaries-design.md` | Per-article summaries (on-demand via AiProvider) | partly built — the bounded summary cache in `ReaderState.js` exists, the UI does not |
| `2026-09-10-phase2-keyboard-design.md` | Keyboard navigation (focus latching, key binding) | implemented — 2.4.0 |
| `2026-09-09-phase1c-settings-design.md` | Google Reader settings UI (third source mode, connection section) | implemented — 2.4.0 |
| `2026-09-09-phase1-google-reader-design.md` | Google Reader API backend (chain fetch, session, id normalisation) | implemented (1a/1b/1c) — 2.4.0 |
| `2026-09-08-phase4-export-provider-design.md` | Notes/export provider (Obsidian, Neovim, markdown dir) | implemented (4a–4d) — unreleased; two decisions changed en route, see its status block |
| `2026-09-08-phase3-ai-provider-design.md` | Local AI provider (OpenAI-compatible chat API) | 3a implemented; 3b–3d not built and unwired |
| `2026-09-08-phase0-backend-interface-design.md` | Backend provider interface (`Backends.js`, capabilities) | implemented — 2.4.0 |
| `2026-09-07-roadmap-design.md` | Full v3 roadmap, all phases | current — but Phase 5 was redesigned after it was written; see per-phase docs |
| `2026-09-07-search-fixes-design.md` | Search focus bug, search-during-selection | implemented — 2.4.0 |
| `v2.4-miniflux-port.md` | Porting Miniflux mode + overview guard onto the v2 rewrite | historical — superseded by `Backends.js` (Phase 0) |
| `v2.3-selection-model.md` | Selection model + bulk actions | historical — implemented, one decision (S10) later overturned |
| `v2.2-ui-fixes.md` | Five UI defect fixes + read-toggle/keyboard-focus | historical — implemented |
| `v2-contract.md` | Frozen v2 contracts (item shape, id precedence, state keys) | historical — core contracts still hold, `FeedParser.js` API has grown |
| `2026-09-05-rss-widget-agent-swarm-spec.md` | Original v2 kickoff prompt/spec | historical |

Each doc marked "historical" or partially-implemented carries its own
`> **Status:**` line at the top with specifics. If you're checking whether a
described behaviour still matches the code, trust the code
(`Backends.js`, `tests/backend-interface.test.js`) over any plan doc.

`docs/ci/` documents the CI setup separately — see [`../ci/README.md`](../ci/README.md).
Narrative documentation lives in [`../wiki/`](../wiki/), which is the source for
the GitHub Wiki.
