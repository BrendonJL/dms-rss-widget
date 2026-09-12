# Development

`install.sh` symlinks the repo into `~/.config/DankMaterialShell/plugins/`, so
**the branch you have checked out is the widget DMS loads**. There is no plugin
hot-reload; `dms restart` picks up changes.

```bash
node --test tests/*.test.js     # the JS modules
./tests/qml/run.sh              # QML smoke tests, headless
qmllint DankRssWidget.qml       # semantic checks, needs a full Qt + DMS
```

Node 18+ (`node:test`). Note that `node --test tests/` *without* the glob fails
on Node 24 — it tries to resolve `tests` as a module.

## Three test tiers

Each catches what the one below cannot.

### `tests/*.test.js` — the modules

Run in CI on Node 20, 22 and 24. They prove you built the request you meant to
build. Because no module `require()`s a sibling (see
[Architecture](Architecture.md)), each one is testable in isolation with its
dependencies injected.

### `tests/qml/run.sh` — QML under a real engine, headless

Runs `.qml` files under a real Qt engine. Needs `QT_QPA_PLATFORM=offscreen`
**and** `QML2_IMPORT_PATH`; without the latter the `qml` tool prints only "Did
not load any objects" and no error, which is why this project long assumed QML
could not be tested at all.

`console.log` does not reach stdout either, so tests report through staged exit
codes — **55 = pass**.

### `tests/live-*.js` — real servers

Deliberately **not** named `*.test.js`, so CI never runs them. They execute a
module's own generated argv against a real server.

This tier exists because unit tests structurally cannot catch a request that is
perfectly well-formed and that the *server* rejects. Both Miniflux bugs fixed in
the 2.4.0 cycle were invisible to 400 passing unit tests.

Run them against a local Miniflux; the Google Reader one needs its API enabled
for your user. There is also a live AI suite that summarises through a real
ollama and asserts the *shape* of the result rather than its wording — a model's
prose is not a test fixture.

## `tests/oracle/` — measured extraction quality

`HtmlExtract.js` is graded rather than asserted. The oracle runs Mozilla
Readability — Firefox Reader View's algorithm — in headless Chromium over 18
real articles and compares output: **mean 92.4%**.

Nothing in `tests/oracle/` ships with the plugin. Fixtures committed to the repo
are redistributable only — Wikipedia (CC BY-SA), Project Gutenberg (public
domain) and synthetic structures. News pages are the real target but not ours to
vendor, so the oracle fetches them at run time into a gitignored cache.

The oracle is the reason two extraction bugs were caught at all:

- A missed argument in `emitList` threw on 14 of 20 real pages while 689 unit
  tests stayed green. A `ReferenceError` only fires on the branch that touches
  the missing binding, and nothing exercised a list with the new argument in
  play. The guard is per-fixture now: every fixture must extract without
  throwing, with options, with empty options, and with none.
- The first index-page guard dropped the oracle mean from 91.1% to 62.6% by
  false-positiving real Wikipedia and MDN articles. Falling back to a summary
  looks exactly like working software, so nothing else would have shown it.

## Invariants with their own tests

Some rules break in ways nothing else notices. These have dedicated tests, each
mutation-checked by reverting the fix and confirming the test fails:

- **No Tab stops.** A test enumerates every tabbable type in the QML and fails if
  one lacks `activeFocusOnTab: false`. Adding a button is not obviously a
  keyboard-navigation change, but it breaks keyboard navigation, and the only
  symptom is "the keyboard randomly stops working".
- **Uniform backend signature.** `tests/backend-interface.test.js` asserts every
  backend takes the same arguments in the same order, because the caller invokes
  them positionally.
- **Every fixture extracts without throwing**, under all four option shapes.
- **No `.pragma library`** — checked by CI rather than a test, with a glob.

## Practical notes

- `Quickshell.execDetached` for anything long-lived (an editor). `Proc.runCommand`
  applies a default timeout and kills what it spawned, which is right for a
  command that returns output and wrong for a process the widget has no further
  interest in. Argv only, never a shell string.
- `FileView` has one `path` at a time and `preload` defaults true, so assigning
  `path` starts a background load. Driving one `FileView` through a queue races;
  use one per file, `preload: false`, destroyed when it finishes.
- DMS maps a plugin's `acceptsKeyboardFocus` onto layer-shell `OnDemand`, which
  grants keyboard focus only on a click landing while the surface is *already*
  focus-eligible. Anything that asks for focus is a request to the compositor,
  not a guarantee.

## See also

- [CI](CI.md) — what runs on a PR, and why qmllint is not one of them
- [Architecture](Architecture.md)
