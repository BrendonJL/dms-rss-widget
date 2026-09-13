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

## 2. Per-feed refresh intervals

The one item refused so far, and the reason is worth keeping: it means
skipping descriptors in `fetchAllFeeds`, but `finalizeFetch` rebuilds
`allItems` from whatever came back that cycle — so a skipped feed's articles
would vanish from the list. Doing it safely needs items retained for skipped
feeds and merged back in, which is a real change to the most important code
path in the widget, and the failure mode of getting it subtly wrong is
articles quietly disappearing.

Shape to aim for: a per-feed `intervalMinutes` on the feed object, a
`feedLastFetch` map in the state tier, descriptors filtered by what is due, and
retained items merged in `finalizeFetch` for every feed that was skipped.
Server-backed backends have one logical stream and no per-feed concept — the
setting must hide rather than mislead there.

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
