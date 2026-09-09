# Design: Phase 0 — backend provider interface

Date: 2026-09-08
Status: ready to implement
Depends on: nothing. Blocks Phase 1 (Google Reader) and Phase 3 (AI).

> **Status:** implemented (0a and 0b, including the addendum below).
> `Backends.js` exists with `StandardBackend`/`MinifluxBackend`; QML is wired
> to `root.backend`/`root.backends`. The `fetchRequest`/`toggleStarRequest`
> signatures in the "Interface" section below are what stage 0a shipped with —
> superseded first by the plural `fetchRequests` addendum, then by Phase 1's
> `session` parameter (`tests/backend-interface.test.js` is now the source of
> truth for the live signatures). `DankRssWidgetSettings.qml` is still not
> capability-driven (Phase 0b as originally scoped) — its `sourceMode`
> branches remain.

## The problem, measured

`sourceMode` is branched on in **21 places in `DankRssWidget.qml`** and **20 more
in `DankRssWidgetSettings.qml`** (`grep -n sourceMode`). Every one is a place a
third mode can be forgotten, and the compiler will never tell us. This is the
single biggest obstacle to the rest of the roadmap.

## The constraint that decides the design

**JS is testable with `node --test`; QML is testable, but only just.**
The shared modules are required directly by the Node suite. QML *can* also be
run headless (`tests/qml/run.sh`, added 2026-09-08 — this doc originally claimed
it could not), but only for logic reachable from a bare `qml` runtime: anything
touching `qs.Common`, `qs.Widgets`, `Quickshell.Io` or the DMS plugin wrapper is
still unreachable, so widget behaviour proper remains read-and-review only.

So the split is not "a backend object per mode." It is:

- **JS owns every backend-specific decision** and returns plain data: which URL,
  which method, which headers, which body, how to parse the response, what the
  backend can do.
- **QML owns only the side effects**: running `Proc`, showing toasts, assigning
  to properties.

The payoff is that Google Reader's protocol — the part with real risk, and the
part we cannot test against a live server until Brendon stands up FreshRSS —
becomes fully unit-testable as pure functions over recorded fixtures.

## Interface

New file `Backends.js`, structured like the existing shared modules (no
`.pragma library`, `var` not `let`, `module.exports` at the bottom).

A backend is a plain object:

```js
{
    id: "miniflux",
    capabilities: {
        serverState: true,   // read/star live on a server, not just locally
        star: true,
        subscribe: true,     // can add feeds through the backend
        categories: true,
        fullText: true
    },

    // Each returns a REQUEST DESCRIPTOR, never performs I/O:
    //   { argv: [...], parse: function (stdout) { ... } }
    // or null when the call is a no-op for this backend.
    fetchRequest: function (config) { ... },
    markReadRequest: function (config, ids) { ... },
    markUnreadRequest: function (config, ids) { ... },
    toggleStarRequest: function (config, id) { ... },

    // Pure: server truth -> local maps. Already exists for Miniflux as
    // ReaderState.reconcileServerStatus; the backend selects it or a no-op.
    reconcile: function (localState, serverEntries) { ... }
}
```

`argv` is a full curl argument vector, built by a shared helper so the security
properties of `minifluxApiCall` (`DankRssWidget.qml:738-771`) are preserved in
one place instead of re-derived per backend: **secrets are always their own argv
element, and no code path ever constructs a shell string.** A test asserts this
directly — that no argv element contains a token substring concatenated with
anything else — so a future backend cannot quietly regress it.

`capabilities` is what removes the `sourceMode` checks from the UI. The star
button asks `backend.capabilities.star`; it never asks which backend it is.
Fever, if it ever lands, reports `subscribe: false` and the subscribe UI
disappears with no mode check written anywhere.

## Implementations

- **`StandardBackend`** — direct feed fetching, local-only state.
  `capabilities.serverState: false`, `reconcile` is a no-op.
- **`MinifluxBackend`** — lifted from the existing branches **verbatim**.

## Scope discipline

This is a **pure refactor**. It must land with the suite green and no observable
behaviour change. Specifically:

- No bug fixes smuggled in, including the known double-`applyFilter` on closing
  search. Note them; fix them separately.
- Id prefixes are unchanged (`g:`/`l:`/`h:`/`m:`, `FeedParser.js:395-401`).
- `DankRssWidgetSettings.qml` is **out of scope**. Its 20 visibility checks
  become capability-driven in a follow-up (Phase 0b), so this diff stays
  reviewable. Phase 0 exports `capabilities` for it to consume later.

## Staging

Two commits, in order, because the second cannot be verified mechanically and
the first can:

**0a — `Backends.js` + tests.** Pure JS, no QML touched. Both backends, request
descriptors, capabilities, the argv-safety test. Fixtures recorded from the real
Miniflux response shapes already covered in `tests/feed-parser.test.js`.

**0b — wire QML to it.** Replace the 21 branch sites with `root.backend.*`
lookups. Behaviour-preserving; verified by reading, `qmllint`, and Brendon
exercising both modes in a live session.

## Testing

`Backends.js` tests must cover, for each backend:

- `capabilities` is the exact expected object (a snapshot — this is the contract
  the UI reads, and a silent change to it silently changes the UI).
- Each `*Request` builds the expected argv for a known config, and returns
  `null` where the operation is a no-op.
- No argv element concatenates a secret with anything else.
- `parse` turns a recorded response into the expected normalised items.
- `reconcile` matches today's `ReaderState.reconcileServerStatus` output for the
  Miniflux case, and is identity for standard.

Write them before the implementation. This repo's 2.3.x history is three
releases in one day where every bug was caught by a human reading code and none
by the suite, twice because a test written afterwards asserted the broken
behaviour it was meant to catch.

## QML smoke tests

`tests/qml/run.sh` runs `.qml` files under a real Qt engine, headless. It exists
because the DI factory below could not otherwise be verified at all.

Two environment settings are required and **both fail silently** when missing:
`QT_QPA_PLATFORM=offscreen`, and `QML2_IMPORT_PATH` pointing at the Qt build's
`lib/qt-6/qml`. Without the latter the `qml` tool prints only "Did not load any
objects, exiting." and no error — which is why this was written off as
impossible in the first place. `console.log` does not reach stdout either, so
tests report through staged exit codes (55 = pass).

`tests/qml/backends-di.qml` verifies the thing no unit test can: that a QML JS
namespace object survives being passed by value into `createBackends`, and that
`deps.FeedParser` still dispatches from inside the returned closure. **Verified
passing** — the highest risk in this phase is retired.

## Manual verification (Brendon, after 0b)

Both modes still work end to end: standard mode fetches and renders; Miniflux
mode fetches, and mark-read / star round-trip to the server and survive a
refresh. Switching modes still clears the other mode's view state
(`DankRssWidget.qml:221`).

---

# Stage 0b addendum — wiring QML

Written after 0a landed and the fetch orchestration was read properly.

## Interface change: `fetchRequests` is plural

`fetchRequest(config)` returning one descriptor does not survive contact with
`fetchAllFeeds` (`DankRssWidget.qml:514-536`): standard mode issues **one request
per enabled feed**, Miniflux issues **one total**. Singular forces QML to keep a
`sourceMode` branch just to decide whether to loop — the exact branch this phase
exists to delete.

Replace it with `fetchRequests(config) -> [descriptor]`. Standard maps its
enabled feeds to N descriptors; Miniflux returns a single-element array. QML
loops over whatever it gets and never asks which backend it has.

Each descriptor grows a `meta` field so the caller can attribute a response
without knowing the backend: `meta: { url, name }` for standard (needed for the
per-feed status rows), and `meta: null` for Miniflux.

## What moves, and what deliberately stays in QML

**Moves into `Backends.js`:** which URL, which method, which headers, which
body, how to parse a response, what the backend can do, whether the current
config is usable.

**Stays in QML — orchestration and side effects, not backend decisions:**

- `fetchGeneration` and the in-flight invalidation
  (`DankRssWidget.qml:523-527`). Note the existing comment: the counter is
  incremented *above* the mode branch on purpose so both paths share one
  generation when the mode is toggled mid-flight. Preserve that ordering.
- Per-feed status collection, sorting, `maxItems` capping, toasts,
  notifications, and all `Proc` invocation.

## New QML surface

```qml
readonly property var backends: Backends.createBackends({
    FeedParser: FeedParser, ReaderState: ReaderState
})
readonly property var backend: root.backends[root.sourceMode] || root.backends.standard
readonly property var backendConfig: ({ /* feeds, minifluxUrl, minifluxToken, maxItems, showStarred */ })

// The ONLY place a descriptor becomes a process.
function runRequest(req, cb) {
    if (!req) { cb(null, null); return; }
    Proc.runCommand(null, req.argv, function (out, code) { cb(out, code); },
                    undefined, req.timeoutMs || undefined);
}
```

`req.timeoutMs` must be honoured. Miniflux carries 30000 deliberately — longer
than curl's own 25s `--max-time`, because otherwise a slow-but-fine request
races Proc's default and surfaces a spurious failure toast.

## Config validity replaces six more branches

The empty-state branches (`DankRssWidget.qml` ~1727-1776) ask things like
`sourceMode === "miniflux" && !minifluxUrl` or `sourceMode === "standard" &&
feeds.length === 0`. Both are one question — "is this backend usable right
now?" — so add to each backend:

```js
configState: function (config) { return { ok: bool, reason: "unconfigured" | "empty" | null }; }
```

The UI switches on `reason`, never on the backend id.

## Verification

- `node --test tests/*.test.js` — existing tests (308 at the time of writing;
  the suite has grown since — check the current count, don't cite this one)
  plus new `fetchRequests` and `configState` cases. Must stay green.
- `tests/qml/run.sh` — extend `backends-di.qml`, or add a sibling, to exercise
  `fetchRequests` and `runRequest`'s descriptor handling under a real engine.
- `qmllint` parses `DankRssWidget.qml`.
- Manual (Brendon): both modes fetch and render; Miniflux mark-read and star
  still round-trip to the server and survive a refresh; switching modes still
  clears the other mode's view state (`DankRssWidget.qml:221`); a feed that
  fails still shows its per-feed error row.
