# v3 finish line — working log

> **Status:** in progress, 2026-09-13. This file exists because the work below
> spans more than one session. It is a handover note first and a plan second:
> if a session ends mid-flight, start here.

## Where things stand

`develop` carries everything from Phase 3 (3b/3c/3d), the accessibility work,
the colour palettes, and all of Phase 6 except the two items below. None of it
has been released; most has had exactly one round of real use, and the fixes
from that round are in. Treat it as shipped-but-young.

Verification available on this machine, all of which should pass before any
commit:

- `node --test tests/*.test.js` — currently 1085 passing, 1 skipped (opt-in live ollama).
- `qmlformat` on every `.qml` — **syntax only**, it has no opinion about types.
- `qmllint -I <qt>/lib/qt-6/qml -I .` filtered for `missing-property` /
  `Could not find property` / `Cannot assign` / `unavailable`. This is the
  check that catches a bad property taking the whole widget down. Ignore the
  `qs.*` import noise; it cannot resolve those and never will.
- `bash tests/qml/run.sh` — six QML smoke tests under a real headless engine.
  It finds a `qml` binary in the Nix store on its own.

After editing a plugin, `systemctl --user restart dms.service` may not be
enough: Quickshell caches compiled QML. Move `~/.cache/quickshell/qmlcache`
aside if a change appears to have no effect.

## 1. Collapsible settings sections

The settings panel is ~2700 lines in one scroll. DMS ships
`DankCollapsibleSection` (`qs.Widgets`): `title`, `description`, `expanded`,
`showBackground`, a `default property alias` for content, self-toggling, with
an animated clipped height.

The wrinkle: it is a `ColumnLayout`, but `PluginSettings` reparents children
into a plain `Column`. Each section therefore needs an explicit
`width: parent.width`, and its *contents* move from the `width: parent.width`
idiom to `Layout.fillWidth: true`. That is a per-child change, not a wrapper
dropped on top.

Sections, in file order: Miniflux Connection, Notes Export, Refresh Settings,
Feed Management, Appearance, Reader, AI Summaries, Interest Ranking, Colour
Theme, Notification Rules. **Feed Management starts expanded; the rest
collapsed** — that is what the panel is usually opened for.

## 2. Per-feed refresh intervals — DONE (needs settings UI)

Implemented in `e490027`. The logic that blocked it for so long is handled:

- Skipped feeds' articles are restored before the dedupe from a retention pool,
  so a feed that was not due keeps what it had.
- `descriptors.length === 0` no longer means one thing. Every feed disabled →
  clear the list (honest). Every feed merely inside its interval → leave it
  alone (previously this emptied the widget).
- Skipped feeds carry their previous status forward instead of a "loading" row
  nothing resolves.
- The decision is `ReaderState.isFeedDue(feed, lastFetchMap, nowMs)`, tested,
  and deliberately biased: every malformed or missing input answers *due*,
  including a clock that has moved backwards. Fetching too often costs a
  request; fetching too rarely loses content.
- Opt-in — no `intervalMinutes` means the global cycle, unchanged.
- Stamped on attempt, not success, so a failing feed backs off too.

**Still to do: the settings UI.** The feed rows in `DankRssWidgetSettings.qml`
need a per-feed interval field writing `intervalMinutes` onto the feed object.
Until that exists the feature is reachable only by hand-editing settings.json.
It should be hidden for server-backed backends, which have one logical stream
and no per-feed concept.

This also fixed the digest pool, which had never worked: it was captured after
the maxItems slice, so it was identical to `allItems` and the digest still
could not see past the display cap.

## 3. MPRIS ownership for podcasts

Parsing and playback exist (`audioUrl`, `p`). The stated goal — podcasts
appearing in the DMS media widget — does not, because that widget lists MPRIS
*players* and mpv does not publish MPRIS without `mpv-mpris` (not installed
here; VLC does natively).

Making it player-independent means the widget registering **itself** as an
MPRIS player: owning playback, transport controls, position and metadata.
That is a much larger feature than "play this enclosure". Decide the scope
before starting.

## 4. Adversarial review

Five staff-engineer reviews, each hostile to the code and narrow in remit:

1. **Efficiency and speed** — allocation churn, repeated scans, work done per
   keystroke or per frame, anything that scales badly with feed or item count.
2. **Uncaught bugs and tightening** — the code that is correct by luck rather
   than construction, and anything that could be smaller.
3. **Security** — untrusted feed content, URL handling, argv construction,
   path traversal, secrets in logs or argv.
4. **Style and architectural consistency** — the dual-runtime module rules,
   descriptor discipline, whether the newest code matches the oldest.
5. **CI** — what the workflow checks, what it misses, and what of the local
   verification above belongs in it.

Findings go in `## Review findings` below, not into a chat log that disappears.

## Review findings

Five hostile reviews, 2026-09-13. Four returned; the bug and security passes are
noted where they stand. Findings are recorded with their verdict so a later
reader can tell what was acted on from what was judged and left.

### Architecture — clean, one doc lag (ACTED ON, `91f1cf2`)

Both failure classes this project has actually repeated showed **zero new
instances** across ~7000 lines written by several agents in parallel:

- Dual-runtime discipline holds: no `.pragma library`, no cross-module
  `require()`, no unguarded clock read in a pure module. `Palette.js` and
  `Ranking.js` match house style, and `Ranking.js`'s habit of documenting
  *rejected* alternatives was rated above the existing baseline.
- "Two places deciding one setting" — the bug shipped twice before
  (`resolveBaseUrl`, `resolvePresetEmbedModel`) — does not recur. Every
  candidate is single-sourced.
- Colour discipline is uniform: no direct `Theme.*` role reads outside the
  three `themeBasePalette()` builders.
- The `Accessible.onPressAction` duplication fix held across all ~19 pairs.

Acted on: three docs claimed per-feed intervals were unbuilt (the roadmap was
updated *before* the feature landed), and `Ranking.explainRank` is a complete,
tested, entirely unwired API surface — now flagged as such in source.

Noted, not fixed: the interval work has no dated design doc, only this log,
against this project's own "every phase gets one" rule. Minor, but it is what
working at pace costs.

### Performance — one real finding (ACTED ON, `1ff99c7`)

**Export fan-out had no concurrency cap.** One curl per article for full text,
then one per image per article, all in the same tick — "select all" over thirty
articles is 100+ concurrent processes inside the shell's own process, where a
stall takes the bar with it. Now a bounded queue, four at a time, applied to
the export fetches only; AI and backend requests stay unqueued so a summary
never waits behind an image batch.

Everything else the review was pointed at came back **correctly bounded at this
scale**, and it was refreshingly willing to say so: `applyFilter` is ~6-7
passes over ≤30 items and properly debounced at 150ms; the retention
concat-in-loop is sub-millisecond once per refresh; `indexOf`/`itemById`/
`previousStatusFor` scans are trivial at 30 items; the summary cache rebuild is
already the right trade and documented as such; every persisted list is capped.
No per-frame or per-keystroke problems.

### CI — recommendations, one of which was wrong (PARTIALLY ACTED ON)

**Its top finding was false.** It reported the manifest job's changelog grep as
a live outage still pointing at `README.md`. It is not — the live workflow and
`docs/ci/tests.yml.proposed` are byte-identical below `jobs:` and both read
`CHANGELOG.md`. The review had trusted `docs/ci/README.md`, which still said
PENDING long after the change landed, and it flagged that it had not verified
against the live file. **`docs/ci/README.md` has been corrected** — a stale
"PENDING" is a claim about the present, and it cost a reviewer a finding.

Worth doing, and **needs a human**: Claude cannot write to `.github/workflows/`.

1. **A filtered `qmllint` job.** This is the answer to the question that
   started the review: `qmlformat` passed the change that took the widget down
   (`lineHeightMode` on a `TextEdit`), because it is a syntax check with no
   opinion on whether a property exists. `qmllint` catches it. It cannot
   resolve `qs.*` and never will, but it resolves plain QtQuick types, which is
   where that bug lived. Run it, grep for
   `missing-property|Could not find property|Cannot assign|Type .* unavailable`,
   and fail only on a match. Uses the `qt6-declarative-dev-tools` package the
   existing `qml-syntax` job already installs. Sub-second. Keep that job's
   "prove the checker can fail" discipline: feed it a deliberately bad fixture
   and assert the grep *does* match, because the filter is a regex over
   free-text warnings and a Qt reword would silently disarm it.
2. **Wire in `tests/qml/run.sh`** — six real QML smoke tests, 1.7s locally.
   Catches what neither formatter nor linter can: wiring that resolves but is
   wrong. One caveat the reviewer was honest about — it has only been proven
   against a Nix Qt, not against Ubuntu's package, so smoke-test the runner
   once before trusting it.
3. **The oracle suite: keep it OUT of the per-PR path.** Its value is proven
   (it caught a `ReferenceError` 689 unit tests missed, and a silent drop from
   91.1% to 62.6%), but its fixtures are gitignored and not ours to
   redistribute, so CI would have to fetch live from Wikipedia, LWN, the
   Guardian and several personal blogs on every PR. For a single maintainer a
   gate that fails over a dead link gets disabled, which is worse than absent.
   A scheduled or manual report job is the right shape if it goes in at all.
4. **Do not bother** with a JS linter or an "exports have not changed" job:
   `node --test` already `require()`s all eleven root modules, so a syntax
   error or renamed export fails CI today. The `.pragma` glob was verified
   correct.

### Uncaught bugs — rerun in progress

First attempt died on a session limit. Rerunning, pointed specifically at
QML→module call-shape agreement, which has failed silently twice
(`buildInterestProfile` taking objects not raw vectors; `itemsScrolledPast`
taking the anchor as `visibleIds[0]`).

One was already found by hand while landing the collapsible settings: moving
`addPresetFeed` onto the section object alongside its callers broke all sixteen
Quick Add buttons, because **QML resolves unqualified names against the calling
object and the component root only — never intermediate ancestors.** Proved
with a nine-line file under the real engine rather than argued. Fixed in
`a1944a9`.

### Security — rerun in progress

First attempt died on a session limit. Rerunning against the real threat model:
a malicious feed is the adversary, and its content reaches the parser, the
extractor, the renderer, the export path that writes files, and the argv of
every fetch.

## Still open after the reviews

1. **Settings UI for per-feed intervals** — the logic shipped in `e490027` but
   `intervalMinutes` is only reachable by hand-editing `settings.json`.
2. **MPRIS ownership** — see above; scope it before starting.
3. **The two CI jobs** — a human has to add them; Claude cannot write to
   `.github/workflows/`.

