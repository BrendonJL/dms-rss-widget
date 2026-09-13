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

_To be filled in by the review pass._
