# Data and Persistence

Plugin data is split across two tiers.

## Settings

`~/.config/DankMaterialShell/settings.json`, shared with the rest of DMS.

Holds your configured feeds (including each one's own `intervalMinutes`,
empty by default), source mode and credentials, refresh interval, max items,
sort mode, appearance preferences, and every new v3 configuration surface:
notes-export options (including the attachment directory for exported
images), notification rules, mark-read-on-scroll, colour preset, ranking
enable/weight, and the AI settings (`aiEnabled`, preset, base URL, model, key,
embed model). All of it is plugin data, not state — grep `pluginData.` in
`DankRssWidget.qml` for the exhaustive list. Written via `pluginService.setData`,
read via `getData`.

**API tokens and passwords are stored in plaintext here**, like every other
setting. Keep that in mind if your DMS settings are backed up or synced.

## State

`~/.local/state/DankMaterialShell/plugins/dankRssWidget_state.json`, a dedicated
per-plugin file.

Holds, per key:

| Key | What it holds |
|---|---|
| `readIds` | Read item ids, in order |
| `seenIds` | Ids the widget has already displayed once, used to tell a genuinely new item from one just fetched again |
| `bookmarkedIds` | Bookmarked item ids |
| `summaries` | The bounded AI summary cache: an id order plus an id-to-text map |
| `notifiedIds` | Ids a notification **rule** has already fired a toast for |
| `feedLastFetch` | Per-feed timestamps, for per-feed refresh intervals |
| `snoozes` | Per-source snooze expiries |
| `feedStatus` | Per-feed fetch status (last result, error text, item count) |

Written via `pluginService.savePluginState`, read via `loadPluginState`. This
file is not part of your shared DMS settings and is not synced or backed up
along with them. The state tier is not permission-gated separately from the
rest of the plugin.

**`notifiedIds` is kept separate from `seenIds`.** `seenIds` answers "has this
item ever been displayed" and drives the plain new-item count; `notifiedIds`
answers "has a notification *rule* already matched this item", which is a
different question once rules replace the plain count — an item can be seen
without ever matching a rule, and re-evaluating rules against `seenIds` would
either miss a rule that starts matching later or re-fire on every refresh.

**`feedLastFetch` is stamped on attempt, not success.** A feed that is failing
still needs to back off to its own interval instead of being retried every
global cycle, so the timestamp records that a fetch was *asked for*, not that
it worked.

**`snoozes` is pruned on load and on every refresh.** `finalizeFetch` calls
`ReaderState.pruneSnoozes` after every fetch completes and only writes the
state back if pruning actually removed something, so an expired snooze
disappears without waiting for you to touch the snooze UI.

The directory comes from Quickshell's `Paths.state` — the XDG generic state
location plus `/DankMaterialShell`.

### Resetting read state

To mark everything unread and clear notification history without touching your
configured feeds, delete the state file:

```bash
rm ~/.local/state/DankMaterialShell/plugins/dankRssWidget_state.json
```

**This also clears your bookmarks, cached AI summaries, snoozes and per-feed
fetch timestamps.** They all live in the same file as read/seen state, not
separate ones — a snoozed feed unsnoozes, a per-feed interval starts counting
from zero again, and every cached summary has to be regenerated.

### Bounds

`readIds`, `seenIds`, `bookmarkedIds` and `notifiedIds` are each bounded to
1000 ids (`idHistoryCap`). The summary cache is bounded to 100 entries
(`summaryCap`) — those lists store ids and this one stores paragraphs, and the
whole state file is rewritten on every change.

`boundIdList` self-heals a duplicate that has already leaked into an order list,
and the summary cache does the same, so the two do not behave differently under
the same corruption.

## Desktop widget instances

DMS can run this plugin either as a global plugin or as a **desktop widget
instance** (an entry under `desktopWidgetInstances` in `settings.json`).

Instances are handed a *reduced* plugin service by DMS
(`instanceScopedPluginService` in `DesktopPluginWrapper.qml`) that implements
only `loadPluginData`/`savePluginData` and has **no**
`loadPluginState`/`savePluginState`. The widget therefore resolves the real
`PluginService` singleton for state access and feature-detects before calling
it, so read/seen/bookmark persistence works in both modes and a missing state
API can never block feed fetching.

This was a real bug, not a hypothetical: in 2.1.0 the missing method threw from
the top of `fetchAllFeeds()`, aborting the fetch before a single feed was
requested, and the widget showed "No items loaded" forever with no error
anywhere. Every state read and write is wrapped now, so a persistence failure
degrades to "no persistence" rather than stopping the widget, and the refresh
timer is armed *before* reader state is loaded.

Reader state is keyed by plugin ID, so multiple instances share one
read/bookmark history.

## Settings are per-instance, with global as the default

Verified in `/usr/share/quickshell/dms/Modules/Plugins/DesktopPluginWrapper.qml`:
`loadPluginData` reads the widget instance's own config and falls back to the
shared `pluginSettings` store; `savePluginData` writes to the instance config
**only**, returning false when there is no instance.

So for a desktop-widget instance, every setting this plugin has — feeds, source
mode, Miniflux and Google Reader credentials, notes export — is per-instance,
and the global store acts as a default. Two instances can show different feeds,
which is the intended feature; they can also disagree about your vault path,
which is not, but is the cost of a consistent mechanism.

It is possible to write the global store directly via
`SettingsData.setPluginSetting`. **Do not.** It bypasses the documented plugin
API, and the shared settings components (`SelectionSetting` and friends) are
wired to the instance-scoped path, so a bypassed field cannot use them and ends
up looking different from every other field in the panel.

## Item IDs and source prefixes

Item IDs are stable: `guid`/`id`, then the canonical link, then a deterministic
hash. Ids are prefixed per source (`m:` Miniflux, `r:` direct RSS, `g:`/`l:`/`h:`
Google Reader), so switching modes never clears read or bookmark history in
either direction — the two sets cannot collide.

## What is deliberately not persisted

Interest-ranking embeddings live in memory only and are recomputed on each
refresh. A few hundred articles of them is megabytes of JSON, and writing that
into a state file shared with the rest of the shell to save one batch request
that takes about a second is not a trade worth making.

## Upgrading from 1.x

- Existing configured feeds keep working with no changes required.
- A feed with no `enabled` key (all feeds saved by 1.x) is treated as enabled —
  nothing gets silently disabled on upgrade.
- Read/unread state starts empty on first run after upgrading. In 1.x this state
  lived only in memory and was already reset on every widget reload, so nothing
  that previously persisted is being lost.

## See also

- [Architecture](Architecture.md)
- [Sources and Sync](Sources-and-Sync.md)
