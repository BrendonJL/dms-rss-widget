# RSS Widget v2 — Frozen Contracts (Milestone 1)

> **Status:** historical (Milestone 1, the v2 rewrite). The core contracts —
> item shape, id precedence, feed config shape — are still live, but
> `FeedParser.js`'s exported function set has grown substantially since
> (safe-URL checks, OPML, namespace handling, Miniflux entry parsing). Treat
> the "FROZEN" function list here as the Milestone 1 baseline, not the
> current API — check `FeedParser.js`'s own `module.exports` for that.

Authored by the lead agent. All DMS facts below were VERIFIED against
`/usr/share/quickshell/dms/` on this machine. Do not re-litigate them.

## Verified DMS facts

- Plugin loading: `PluginService.qml` uses
  `Qt.createComponent(fileUrl, Component.PreferSynchronous).createObject(...)`.
  The plugin directory is therefore an implicit QML import for its own files.
- Sibling `.js` import WORKS. Precedent:
  `~/.config/DankMaterialShell/plugins/calculator/CalculatorLauncher.qml:4`
  uses `import "calculator.js" as Calculator`
- `.pragma library` MUST NOT be used in a dual-use JS file: it is invalid
  JavaScript and Node's `require()` fails on line 1. (Tested empirically.)
- Widget persistence: `DesktopPluginComponent` exposes `pluginService`
  (line 7), `getData(key, def)` / `setData(key, val)` (lines 56-66).
  - `setData` / `getData` write the SHARED
    `~/.config/DankMaterialShell/settings.json`
  - `pluginService.savePluginState(pluginId, key, val)` and
    `loadPluginState(pluginId, key, def)` write a DEDICATED
    `$XDG_STATE/plugins/dankRssWidget_state.json`, debounced 150ms,
    atomic writes. (PluginService.qml:846-885)
- `Proc.runCommand(id, cmdArray, cb(stdout, exitCode), debounceMs?, timeoutMs?)`
  debounces by `id`; default timeout 10000ms; TIMEOUT YIELDS EXIT CODE 124.
- Toasts: `ToastService.showInfo/showWarning/showError(msg, details, cmd, cat)`.
- Theme tokens: primary, secondary, surfaceText, surfaceVariantText,
  surfaceContainer, surfaceContainerHigh, outlineVariant, error, warning,
  success; spacingXXS/XS/S/M/L/XL = 2/4/8/12/16/24;
  fontSizeSmall/Medium/Large/XLarge = 12/14/16/20;
  iconSize/iconSizeSmall/iconSizeLarge = 24/16/32; cornerRadius (computed).
- Widgets (`import qs.Widgets`): DankTextField, DankActionButton, DankButton,
  DankButtonGroup, DankTabBar, DankListView, DankDropdown, DankToggle,
  DankTooltip, DankSpinner.

## CONTRACT 1 — FeedParser.js public API

New file at repo root: `FeedParser.js`. NO `.pragma library`.
The file ends with:

    if (typeof module !== "undefined" && module.exports) { module.exports = { ... } }

Function names are FROZEN. QML calls them as `FeedParser.fnName(...)`.

    extractTag(xml, tagName) -> string
    cleanText(text) -> string
    stripHtml(text) -> string
    getRelativeTime(date, now) -> string     // `now` optional, defaults to new Date()
    extractImageUrl(block, content) -> string
    makeItemId(rawId, link, source, title, dateStr) -> string
    parseRssFeed(xml, sourceName, sourceUrl) -> Item[]
    parseAtomFeed(xml, sourceName, sourceUrl) -> Item[]
    parseFeed(xml, sourceName, sourceUrl) -> Item[]
    parseOpml(xml) -> Array of {name, url}

## CONTRACT 2 — Item shape (FROZEN)

    {
      id:          string,   // stable, see CONTRACT 3
      title:       string,
      link:        string,
      description: string,
      timestamp:   number,   // ms epoch, 0 if unknown
      dateStr:     string,   // raw date string as published
      source:      string,   // feed display name
      sourceUrl:   string,   // feed url, "" if not supplied
      imageUrl:    string
    }

NOTE: `relativeTime` is REMOVED from the parsed item. It was a stored string
that went stale between fetches. Compute it at render time from `timestamp`.

## CONTRACT 3 — Stable item ID precedence (FROZEN)

`makeItemId` returns the first non-empty of:

1. RSS `<guid>` / Atom `<id>`, trimmed  -> `"g:" + value`
2. canonical link, trimmed              -> `"l:" + value`
3. deterministic fallback               -> `"h:" + hash`

The fallback hash must be a pure, deterministic string hash (djb2 or FNV-1a)
of `source + " " + title + " " + dateStr`. Same input must give the same
output across restarts. No `Date.now()`, no `Math.random()`, no index-based
IDs — those would break read state on every refresh.

## CONTRACT 4 — Feed config shape (settings tier, key "feeds")

    { name: string, url: string, enabled: bool, addedAt?: number }

MIGRATION: existing stored feeds have only `{name, url}`. A MISSING `enabled`
must be treated as `true`. Never write `enabled: false` onto a feed the user
did not explicitly disable.

## CONTRACT 5 — Reader state (state tier, per-plugin file)

Keys under `pluginService` state for pluginId `dankRssWidget`:

    "readIds"  -> string[]   bounded, newest-first, cap 1000
    "seenIds"  -> string[]   bounded, newest-first, cap 1000

Bounding rule: on every save, dedupe preserving newest-first order, then
`slice(0, 1000)`.

`seenIds` semantics for notifications:

- If `seenIds` is EMPTY (first ever load), record all current IDs and notify
  for NOTHING. This is the anti-spam rule.
- Otherwise `new = current IDs not present in seenIds`. Notify with
  `new.length` when it is greater than 0.

## CONTRACT 6 — Per-feed runtime status

    { url, name, state, lastFetched, lastSuccess, lastError, itemCount }

`state` is one of `"idle" | "loading" | "ok" | "error" | "timeout" | "disabled"`.

Map exitCode 124 to `"timeout"`. Any other nonzero exitCode, empty output, or
zero parsed items from non-empty output maps to `"error"` with a short message.

TRANSPORT: the settings panel is a SEPARATE component instance from the
widget and cannot see the widget's in-memory properties. Because P0 requires
status to be visible in settings, the widget WRITES this array to the state
tier under key `"feedStatus"` at the end of each fetch cycle, and the settings
panel READS it with `loadPluginState`. Settings must treat it as read-only and
must render correctly when the key is absent (widget never ran, or was never
loaded) — show "not fetched yet", never an error.

`lastFetched` / `lastSuccess` are ms-epoch numbers, 0 when never.
`lastError` is a short human-readable string, "" when none.

## CONTRACT 7 — Fetch generation guard (fixes a REAL existing bug)

Current `fetchAllFeeds()` shares one `collector` array and one
`root.pendingFetches` counter across async curl callbacks. Two overlapping
calls corrupt both: the counter reaches 0 early and `finalizeFetch` runs on a
half-filled collector while stragglers push into an array nobody reads.

Required fix: an incrementing `fetchGeneration` int. Each fetch captures the
current generation; every callback returns early when
`gen !== root.fetchGeneration`. Manual refresh must additionally be disabled
while `isLoading` is true.

## Ownership (do not edit outside your lane)

    Agent A : FeedParser.js, tests/feed-parser.test.js,
              delete tests/feed-parser.js
    Lead    : DankRssWidget.qml  (serialized, after A lands)
    Agent C : DankRssWidgetSettings.qml
    Agent D : README.md, plugin.json  (runs last)
