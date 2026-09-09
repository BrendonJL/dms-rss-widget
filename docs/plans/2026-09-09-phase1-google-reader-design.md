# Design: Phase 1 — Google Reader API backend

Date: 2026-09-09
Status: ready to implement
Depends on: Phase 0. **Requires an interface extension** — see below.

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
