# Plans index

Design docs and historical records, newest work first. "Status" here is about
whether the doc describes current reality, not whether it's well-written.

| Doc | Covers | Status |
|---|---|---|
| `2026-09-09-phase1-google-reader-design.md` | Google Reader API backend (chain fetch, session, id normalisation) | current — 1a/1b implemented, 1c (settings UI) pending |
| `2026-09-08-phase4-export-provider-design.md` | Notes/export provider (Obsidian, Neovim, markdown dir) | current — 4a implemented, 4b (QML wiring) pending |
| `2026-09-08-phase3-ai-provider-design.md` | Local AI provider (OpenAI-compatible chat API) | current — 3a implemented, 3b-3d (UI features) pending |
| `2026-09-08-phase0-backend-interface-design.md` | Backend provider interface (`Backends.js`, capabilities) | implemented |
| `2026-09-07-roadmap-design.md` | Full v3 roadmap, all phases | current — see per-phase docs for what's actually done |
| `2026-09-07-search-fixes-design.md` | Search focus bug, search-during-selection | implemented |
| `v2.4-miniflux-port.md` | Porting Miniflux mode + overview guard onto the v2 rewrite | historical — superseded by `Backends.js` (Phase 0) |
| `v2.3-selection-model.md` | Selection model + bulk actions | historical — implemented, one decision (S10) later overturned |
| `v2.2-ui-fixes.md` | Five UI defect fixes + read-toggle/keyboard-focus | historical — implemented |
| `v2-contract.md` | Frozen v2 contracts (item shape, id precedence, state keys) | historical — core contracts still hold, `FeedParser.js` API has grown |
| `2026-09-05-rss-widget-agent-swarm-spec.md` | Original v2 kickoff prompt/spec | historical |

Each doc marked "historical" or partially-implemented carries its own
`> **Status:**` line at the top with specifics. If you're checking whether a
described behaviour still matches the code, trust the code
(`Backends.js`, `tests/backend-interface.test.js`) over any plan doc.

`docs/ci/` documents the CI setup separately — see `docs/ci/README.md`.
