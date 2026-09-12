# Design: Phase 1 — Google Reader API backend

Date: 2026-09-09
Status: implemented (1a, 1b, 1c) — shipped in 2.4.0
Depends on: Phase 0. **Requires an interface extension** — see below.

> **Status:** fully implemented and shipped in 2.4.0. `GoogleReader.js`,
> `ChainRunner.js`, `tests/live-greader.js`, and the `session` parameter (now
> shared by all three backends) all exist. 1c (the settings UI) landed in
> `5baa0b0`: `DankRssWidgetSettings.qml` offers Google Reader as a third source
> mode with URL/username/password fields and a Test Connection button that
> runs the real two-step ClientLogin chain.

## Why this backend is worth the trouble

One protocol reaches FreshRSS, Tiny Tiny RSS (via plugin), Inoreader,
TheOldReader, BazQux *and* Miniflux. Six backends, one client.

## The protocol, as actually observed

Everything below was probed against a live Miniflux 2.x instance
(`http://127.0.0.1:8085`) on 2026-09-09, not taken from documentation.

1. `POST /accounts/ClientLogin` with `Email=` and `Passwd=` → a body of
   `SID=`, `LSID=` and **`Auth=<token>`**. Parse the `Auth=` line.
2. Every later call carries `Authorization: GoogleLogin auth=<token>`.
3. **Every POST additionally requires a post-token** from
   `GET /reader/api/0/token`, sent as `T=` in the form body. Without it a
   POST returns `401 Unauthorized` with no explanation — this cost a probe
   cycle to discover.
4. `GET /reader/api/0/subscription/list?output=json` → feeds, ids shaped
   `feed/1`, each with categories.
5. `GET /reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=N&output=json`
   → `{"itemRefs":[{"id":"46"},…],"continuation":"3"}`.
6. `POST /reader/api/0/stream/items/contents?output=json` with `T=` and one
   repeated `i=` per id → the full items.
7. `POST /reader/api/0/edit-tag` with `T=`, `i=`, and `a=`/`r=` set to
   `user/-/state/com.google/read` or `.../starred`. Verified round-trip:
   marking read, starring, and unstarring all took effect server-side.

### Two traps, both confirmed by probing

**`stream/contents` is not implemented by Miniflux.** Every variant
(`stream/contents`, `.../reading-list`, `.../user/-/state/com.google/reading-list`,
`.../feed/1`) returns a bare `[]` with **HTTP 200** — success-shaped, empty,
no error. A client that builds its fetch on `stream/contents`, as the original
Google Reader API documents, gets an empty reader and no clue why. The working
path is the two-step `items/ids` → `items/contents` flow.

**Item ids come in two encodings in the same API.** `items/ids` returns
decimal strings (`"46"`); `items/contents` returns the long form
(`tag:google.com,2005:reader/item/000000000000002e` — hex, zero-padded to 16).
`0x2e` is 46. `edit-tag` accepts **either**. Normalise on the way in, and give
these their own id prefix (`r:`) alongside `g:`/`l:`/`h:`/`m:`.

## The interface problem this exposes

Phase 0's `fetchRequests(config) -> [descriptor]` returns **independent**
requests that the caller runs in parallel. Google Reader cannot be expressed
that way: the contents request needs ids that only exist after the ids request
has returned, which itself needs an auth token, which needs a post token before
any POST. It is a **chain**, not a set.

### Proposed extension: `parse` may return a `nextRequest`

Minimal, and additive rather than a rewrite:

```js
parse: function (stdout) {
    return { items: [], serverStatus: [], error: null, nextRequest: <descriptor|null> };
}
```

The QML runner already inspects the parse result. When `nextRequest` is
present it runs that instead of completing the descriptor. `StandardBackend`
and `MinifluxBackend` never set it and are untouched.

**The dangerous part is the pending counter.** `fetchDescriptor` decrements
`ctx.pending` exactly once per descriptor today, and `finalizeFetch` fires when
it hits zero. A chained request must **not** decrement until the chain
terminates, or the cycle finalises on a half-filled result set — the exact bug
the `fetchGeneration` comment already warns about. Specify and test:

- decrement once per *chain*, not per request;
- a stale generation abandons the whole chain, not just the current link;
- an error anywhere in the chain terminates it and decrements once.

Cap the chain length (say 5). A server that always returns a `nextRequest`
must not loop forever.

## Auth token caching

`ClientLogin` verifies a **bcrypt** hash server-side. Re-authenticating on
every refresh cycle is both slow and rude to the server. Cache the `Auth`
token and the post token in widget state, and re-authenticate only on a 401.
This makes the backend the first one with *session state*, which the Phase 0
interface also has no place for — `config` is currently pure input. Add an
explicit `session` object the caller owns and passes in, rather than letting
the backend hold mutable state; backends must stay pure for the tests to work.

## Capabilities

`{ serverState: true, star: true, subscribe: true, categories: true, fullText: false }`
— `subscribe` because `quickadd` exists, `categories` because
`subscription/list` returns them. Neither needs UI in this phase; the flags
just stop the UI asking which backend it has.

## Testing

- Unit: `ClientLogin` response parsing (including a malformed body and a 401);
  both id encodings normalising to the same `r:` id; chain construction;
  `edit-tag` argv for read/unread/star/unstar; the post-token requirement.
- **`tests/live-greader.js`**, modelled on `tests/live-miniflux.js`: run the
  module's own argv against the local Miniflux and assert the full round trip.
  Named `.js` not `.test.js` so CI never runs it. This is what caught two real
  bugs in the Miniflux backend that unit tests structurally could not.
- The chain/pending arithmetic needs a QML-side test in `tests/qml/`, since it
  lives in the runner rather than in the module.

## Local test instance

Miniflux at `http://127.0.0.1:8085`, Google Reader API enabled for user
`admin`. Credentials in `~/secrets/miniflux.env` as `GREADER_USERNAME` /
`GREADER_PASSWORD` (a separate password from the web login — Miniflux stores
it under `integrations.googlereader_password`, and it is set in the web UI
under Settings → Integrations).

FreshRSS remains worth adding later as the independent check that this
implementation is not accidentally Miniflux-specific — `stream/contents`
returning `[]` is exactly the kind of per-server deviation that a single test
server hides.

---

# Stage 1b addendum — the QML runner

## Make the dangerous part testable instead of careful

The chain arithmetic is the one place a mistake finalises a fetch on partial
results, and it would live in `DankRssWidget.qml`, which `node --test` cannot
reach (`tests/qml/run.sh` can execute `.qml` files headlessly, but only logic
that doesn't touch `qs.Common`/`qs.Widgets`/`Quickshell.Io` — this widget's
fetch orchestration does). So do not put it there. Extract it into a pure
module, `ChainRunner.js`, covered by `node --test` like everything else:

```js
createChain(descriptor, maxLinks)          -> chain
chain.step(parsed)                         -> { action, request, items, serverStatus, error, session }
```

`action` is one of:

- `"next"` — run `request`; the caller must NOT decrement its pending counter.
- `"done"` — the chain produced `items`; decrement exactly once.
- `"error"` — terminate with `error`; decrement exactly once.

The invariant, stated so it can be tested: **`step` returns exactly one
terminal result (`done` or `error`) per chain**, and a chain that exceeds
`maxLinks` returns `error`, never `next`. QML then holds no arithmetic at all
— it runs a request, hands the parse result to `step`, and does what it says.

Tests must include: a 1-link chain; a 4-link chain (Google Reader's cold
start); a chain that errors mid-way; a chain that exceeds the cap; and the
property that no chain ever yields two terminal results.

## Session lives in memory, not in plugin state

Hold `{ authToken, postToken }` in a plain root property, **not** persisted.
It is re-derivable with one `ClientLogin`, and persisting it would write a
credential to disk for no benefit. Re-authenticating once per shell start is
the correct trade.

The session is threaded through as the second argument to every backend call,
which is why all three backends now share that signature
(`tests/backend-interface.test.js` enforces it).

## Call sites

`toggleStarRequest` now takes `currentlyStarred`. The widget already knows it:
`root.bookmarkMap[id]`, read **before** the local toggle is applied, since
after the toggle it reports the new state and Google Reader would send the
wrong one of `a=` / `r=`.

## Out of scope for 1b

The settings UI. `DankRssWidgetSettings.qml` still offers only two source
modes, so Google Reader is reachable in 1b only by hand-editing settings —
which is enough to verify the runner. The third mode, its URL/username/password
fields, and the capability-driven visibility rewrite are stage 1c.
