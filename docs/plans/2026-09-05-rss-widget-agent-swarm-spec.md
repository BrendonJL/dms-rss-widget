# Dank RSS Widget v2 Agent Swarm Prompt And Spec

## Copy-Paste Prompt For Claude

You are working in `/var/home/blasley/projects/dms-rss-widget`, a Dank Material Shell desktop widget plugin written in QML with extracted JavaScript parser tests.

Goal: polish the existing Dank RSS Widget into a more full-featured desktop RSS reader while preserving its current plugin compatibility, lightweight footprint, and DMS visual language.

Important constraints:

- Do not run `git push`, create remote repos, fork repos, or open PRs.
- Keep the plugin compatible with DankMaterialShell `>=1.2.0`.
- Keep the implementation self-contained unless you verify that DMS plugin packaging supports shared local JS/QML modules.
- Preserve existing features unless a change is explicitly justified.
- Preserve existing parser test coverage and add tests for parser/feed-state changes.
- Prefer DMS/Quickshell components and the current theme system over custom UI primitives.
- Fetching currently uses `Proc.runCommand` with `curl`; keep this approach unless you verify a better DMS-native fetch API exists.
- Do not store secrets. Do not add external services.

Current repo map:

- `DankRssWidget.qml`: desktop widget UI, feed fetching, RSS/Atom parsing, read tracking, item list rendering.
- `DankRssWidgetSettings.qml`: settings panel, feed add/edit/delete, OPML paste import, presets, display settings.
- `tests/feed-parser.js`: pure JS copy of parsing helpers for Node tests.
- `tests/feed-parser.test.js`: parser tests.
- `plugin.json`: DMS plugin metadata.
- `README.md`: install, feature, testing docs.

Current capabilities:

- RSS 2.0 and Atom parsing with auto-detection.
- Multiple configured feeds.
- Auto-refresh by interval.
- Manual add/edit/delete feeds.
- OPML paste import.
- Quick-add presets for news, tech, and Reddit feeds.
- Newest, oldest, and grouped-by-feed sorting.
- Compact and expanded list modes.
- Feed source labels, thumbnails, read/unread state, mark-all toggle.
- Toast notifications for new item count.
- Appearance controls for font, background opacity, and border.

Known weak spots to address:

- `readLinks` is in-memory only and resets when the widget reloads.
- Fetch errors are silently ignored; users cannot see per-feed status.
- New item notifications compare item counts, not actual stable item IDs.
- Parser logic is duplicated between QML and `tests/feed-parser.js`.
- Feed validation is weak; a typo URL can be saved without feedback.
- The widget has no search, filters, bookmarks, pinned feeds, or per-feed enable/disable.
- Settings are a long linear page and should be reorganized for a denser, more polished tool.
- OPML import is paste-only and has limited feedback.
- Item identity relies mainly on link strings; GUID/ID should be considered.
- Layout should remain usable at small desktop-widget dimensions.

Swarm operating model:

1. First have one explorer agent inspect DMS plugin APIs and local plugin patterns before changing architecture. Verify whether shared JS modules can be imported from a plugin directory. If not verified, keep parser duplication but make it easier to sync.
2. Split implementation into independent workstreams with disjoint ownership where possible.
3. Each worker must inspect the current files it owns before editing. The repo may contain user changes; do not revert unrelated changes.
4. Each worker must report files changed, tests run, and remaining risks.
5. The lead agent integrates, resolves conflicts, runs final verification, and updates docs.

Recommended agent split:

- Agent A, feed engine and parser:
  Owns `DankRssWidget.qml`, `tests/feed-parser.js`, and `tests/feed-parser.test.js` for parsing, item identity, feed status, error handling, and notification correctness.

- Agent B, widget interaction and visual polish:
  Owns `DankRssWidget.qml` UI sections only. Adds search/filter controls, item action affordances, polished empty/error/loading states, responsive behavior, and keyboard/mouse ergonomics.

- Agent C, settings and feed management:
  Owns `DankRssWidgetSettings.qml`. Reorganizes settings, adds feed validation/test fetch flow, feed enable/disable, categories/tags if implemented, better OPML import feedback, and improved preset management.

- Agent D, docs and packaging:
  Owns `README.md`, `plugin.json` if needed, screenshots only if regenerated, and any docs. Updates feature docs, test instructions, changelog notes, and migration guidance.

Avoid concurrent edits to the same region of `DankRssWidget.qml`. If multiple workers must touch it, lead agent should create stable function boundaries first or serialize those changes.

## Product Direction

Build a compact desktop RSS control center, not a full browser replacement. The widget should let a user glance at current feeds, triage unread items, open interesting posts, and manage sources without leaving Dank Material Shell.

The design should feel like part of DMS: restrained, dense, keyboard/mouse friendly, theme-aware, and useful inside a narrow floating widget. Avoid a marketing-style redesign or oversized decorative UI.

## Feature Priorities

### P0: Foundation And Correctness

- Stable item IDs:
  Use RSS `guid`, Atom `id`, canonical link, then a deterministic fallback from source/title/date. Use this for read state, notifications, dedupe, and bookmarks.

- Persistent read state:
  Save read item IDs in plugin settings or another verified DMS persistence mechanism. Bound the stored history, for example newest 500-1000 IDs, to avoid unbounded settings growth.

- Real new-item detection:
  Track previous seen IDs, notify only for IDs not seen before, and avoid notification spam on first load.

- Feed fetch status:
  Track per-feed `lastFetched`, `lastSuccess`, `lastError`, item count, and disabled state. Surface status in settings and a compact widget status indicator.

- Safer parsing:
  Improve GUID/id extraction, Atom alternate-link selection regardless of attribute order, Dublin Core dates if practical, image extraction, and HTML/entity cleanup. Add tests for each change.

### P1: Reader Experience

- Search:
  Add a small search field/filter mode for title, description, and source.

- Filters:
  Add All, Unread, Bookmarked, and Errors views. Keep controls compact.

- Bookmarks:
  Let users bookmark items and persist bookmarks by stable item ID. Bookmarked items should survive refreshes while the item still exists in fetched history.

- Item actions:
  Keep single-click behavior predictable. Consider explicit action buttons for open, mark read/unread, and bookmark on hover or in an expanded row.

- Manual refresh:
  Add a visible refresh action with loading feedback and disabled/debounced state while refresh is active.

- Better item summaries:
  Keep descriptions readable, strip unsafe or noisy HTML, and avoid layout jumps when thumbnails load or fail.

### P2: Feed Management Polish

- Feed validation:
  Add a "Test" action before saving or beside each feed. It should fetch the URL, parse it, show detected format and item count, and report useful errors.

- Enable/disable feeds:
  Allow feeds to stay configured but excluded from fetches.

- Feed ordering:
  Allow moving feeds up/down at minimum. Drag reorder is optional if DMS makes it straightforward.

- OPML improvements:
  Keep paste import, but add duplicate summary, import preview, and clearer failure messages. File picker import is optional only if DMS supports it cleanly.

- Presets:
  Group presets more cleanly and avoid duplicate buttons for already-added feeds.

### P3: Nice-To-Have Enhancements

- Per-feed color/accent or category labels.
- Configurable excerpt length.
- Stale-feed warning after repeated failures.
- Copy link action.
- Open all unread from a feed is optional and should not clutter the base UI.

## Non-Goals

- Do not build an embedded article reader unless DMS already has a safe, obvious component for it.
- Do not add account sync, external backend services, or hosted APIs.
- Do not add heavy dependencies.
- Do not replace the DMS theme/components with a custom design system.
- Do not make the widget require network access during startup before the UI can render.

## Architecture Guidance

Preferred approach: incremental v2 inside the existing plugin shape.

Keep `DankRssWidget.qml` and `DankRssWidgetSettings.qml` as the public plugin entry points. Add helper functions and clearer data-shaping boundaries inside those files. Only extract shared parser/state code into separate files if the explorer agent verifies that DMS plugin loading supports it reliably.

Suggested internal model:

- Feed config:
  `{ name, url, enabled, category?, accent?, addedAt? }`

- Parsed item:
  `{ id, title, link, description, timestamp, dateStr, source, sourceUrl, imageUrl, feedIndex }`

- Runtime feed status:
  `{ url, name, state, lastFetched, lastSuccess, lastError, itemCount }`

- Persisted reader state:
  `{ readIds, seenIds, bookmarkedIds }`

Keep persisted arrays bounded and prune IDs not seen recently.

## UI Guidance

Widget:

- Header: title, item count, refresh button, loading spinner/state, optional status/error indicator.
- Filter row: compact segmented controls for All, Unread, Bookmarked, Errors plus search when there is room.
- Item rows: stable height behavior, source, title, relative time, optional thumbnail, excerpt in expanded mode, hover actions.
- Empty states: separate messages for no feeds, no matching search results, all caught up, and all feeds failing.
- Error state: show a short aggregate message in the widget and detailed per-feed errors in settings.

Settings:

- Reorganize into clear sections: Feeds, Import, Presets, Reading, Appearance, Advanced.
- Feed list should show enabled state, last status, item count, edit, test, move, delete.
- Add/edit feed flow should validate URL shape before test fetch and should not silently save empty/invalid URLs.
- Keep controls dense and readable. Avoid nested card-heavy layout.

## Acceptance Criteria

- Existing documented features still work.
- Read/unread survives widget reload.
- Bookmarks survive widget reload.
- New item notifications are based on stable new IDs, not item count.
- Failed feeds show useful status without breaking successful feeds.
- Manual refresh works and cannot start overlapping refresh storms.
- Search and filters work together.
- Disabled feeds are not fetched.
- OPML import still skips duplicates and reports what happened.
- Parser tests cover RSS GUID, Atom ID, alternate links with varied attribute order, malformed/missing dates, media/enclosure images, duplicate items, and OPML duplicates.
- README documents new features and settings.

## Verification Commands

Run at minimum:

```bash
node --test tests/feed-parser.test.js
```

Also perform manual DMS verification:

- Load the widget with no feeds and verify the empty state.
- Add one valid feed and one invalid feed.
- Test manual refresh and automatic refresh.
- Click an item, reload DMS, and confirm read state persists.
- Bookmark an item, reload DMS, and confirm bookmark state persists.
- Import an OPML sample containing duplicates.
- Test compact and expanded modes at narrow and wide widget sizes.
- Confirm failed feeds do not prevent successful feed items from rendering.

## Suggested First Milestone

For the first swarm run, target P0 and the smallest useful slice of P1:

- Stable item IDs.
- Persistent read state.
- Correct new item detection.
- Per-feed fetch status and visible errors.
- Manual refresh button.
- All/Unread filter.
- Parser tests and README update.

Leave bookmarks, full search, feed reordering, and settings reorganization for a second pass if the first swarm run feels too large.

