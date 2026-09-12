# Architecture

Logic that can be pure is kept out of QML, in modules at the repo root. QML owns
side effects — running processes, showing toasts, assigning properties — and
nothing else.

## Modules

| Module | Responsibility |
|---|---|
| `FeedParser.js` | RSS/Atom/OPML parsing, stable item IDs, image extraction, relative time, URL safety (`isSafeUrl`) |
| `ReaderState.js` | Read/seen/bookmark bookkeeping, bounding, new-item detection, search and filtering, fetch classification, feed enable/disable and ordering, the bounded AI summary cache |
| `Backends.js` | The backend interface: `capabilities` plus request descriptors for the standard and Miniflux backends |
| `GoogleReader.js` | Google Reader API backend (FreshRSS, TT-RSS, Inoreader, TheOldReader, BazQux, Miniflux) |
| `ChainRunner.js` | Steps a chained request sequence, so the QML runner holds no counter arithmetic |
| `AiProvider.js` | Client for any OpenAI-compatible runtime (ollama, vLLM, llama.cpp, LM Studio) |
| `ExportProvider.js` | Note paths, markdown bodies, editor open-command presets and legacy config migration |
| `HtmlExtract.js` | Local full-text article extraction from an HTML page |
| `KeyMap.js` | Keyboard dispatch: takes a key event plus widget state, returns an action name |

QML files: `DankRssWidget.qml` (the widget), `DankRssWidgetSettings.qml` (the
settings panel), `ReaderWindow.qml` (the reading window).

Each module is imported the same way (`import "FeedParser.js" as FeedParser`)
and `require()`d unchanged by the Node tests — there is no second copy of the
logic to keep in sync.

## Two rules that are easy to violate and hard to notice

**No `.pragma library` line.** It is required for QML-only JS modules in some
contexts, but it is not valid JavaScript and `require()` fails on it
immediately. Adding one breaks the test suite without breaking the widget. CI
greps for it — and greps with a *glob*, not a filename list, because that check
silently stopped covering `Backends.js` the day that file was added.

**Modules never `require()` each other.** `require` does not exist under QML and
`.import` is not valid JavaScript, so neither works in both runtimes. A module
that needs a sibling takes it as an argument instead —
`createBackends({ FeedParser, ReaderState, GoogleReader })`.

## Backends return descriptors, not results

A backend returns **request descriptors** (`{ argv, parse, timeoutMs, meta }`)
and performs no I/O. That is what makes a protocol testable without a server:
the test asserts the argv the widget *would* run.

Every backend takes the same arguments in the same order, because the caller
invokes them positionally without knowing which one it holds.
`tests/backend-interface.test.js` enforces that.

Phase 0 removed every `sourceMode ===` branch from the widget — 17 of them
became one dispatch point. That is why a third backend was a new file rather
than a new branch in twenty places.

Chained protocols (Google Reader needs a ClientLogin token before anything
else) are expressed as a sequence stepped by `ChainRunner.js`, so the QML side
holds no counter arithmetic.

## Pure-module discipline

`KeyMap.js` and `ChainRunner.js` are strictly pure: no Qt APIs, no I/O, no
`Date.now()`, no randomness. `KeyMap.resolveKey()` is handed the raw key event
and the widget's current state, and returns only a *name* for the caller to act
on — it never opens an article or toggles anything itself. Timestamps for the
`g g` pending-key timeout are supplied by the caller.

Because Node has no `Qt` global, the key and modifier codes `KeyMap.js` matches
against are hardcoded as Qt's own numeric values from `qnamespace.h`. QML's
`event.key`/`event.modifiers` are those same numbers, so nothing is translated
at the call site.

## Design principle

Anything with a vendor name gets an interface with presets, never a hardcoded
integration. Feed backends speak the Google Reader API, AI runtimes speak the
OpenAI-compatible chat API, notes apps are "write a markdown file to a
directory", and editors are a `{path}` command template. Adding ollama must not
make vLLM harder.

## See also

- [Data and Persistence](Data-and-Persistence.md) — where settings and state live, and the per-instance rule
- [Development](Development.md) — the three test tiers
- [Sources and Sync](Sources-and-Sync.md) — the backends in use
