# Design: stage 3b — per-article summaries

Date: 2026-09-10
Status: implemented — on `develop`, unreleased. One deviation below (the
feature toggle shipped global, not per-instance); the connection config
shipped global as designed.
Depends on: 3a (`AiProvider.js`, done)

> **Status:** implemented on `develop`, unreleased. The settings section, the
> `aiReady` gate, the cached/generation-guarded `requestSummary` flow, the
> reader's summary panel and toolbar button, and `i` (both from the reader and
> from the list, opening a summary-only mode) all exist and pass their tests
> (772 node tests green; all touched QML passes `qmlformat`). **Deviation:**
> this doc specified the feature toggle (`aiEnabled`) as per-instance. It
> shipped **global** instead — see "Deviation: the toggle is global, not
> per-instance" below. The connection settings (base URL, model, API key) are
> global as designed. No `qml` binary exists on this machine, so there is
> still no automated coverage of the UI's runtime behaviour, but the manual
> checklist in Testing was run by the owner on 2026-09-12 and passed; see
> Testing for exactly what was and was not covered.

`AiProvider.js` is built and tested but wired to nothing. This gives it a UI.

## The measurement that decides the design

**Update, 2026-09-12:** the original measurement below was correct but its
conclusion was too narrow, and this section originally used it to argue that
summaries must be on demand *because 5s is slow*. That argument no longer
holds — a fast model measured warm at 0.5s — so it has been replaced rather
than quietly patched. Summaries are still strictly on demand; the reasoning
just changed, and that change is recorded rather than hidden.

Original figure: **~4.8s** for a two-sentence summary of a ~120-word article,
measured on this machine (RTX 2070 Super, qwen3:8b). Roughly 60% of that is a
reasoning model thinking; a non-reasoning instruct model was predicted to be
2-3x faster.

New measurements, 2026-09-12, against the live local ollama on the same
machine, using `AiProvider`'s own `summariseRequest` descriptor end to end
(curl → parse) against the same ~120-word fixture article:

- `qwen3:8b` — ~11s cold (model not resident), 4.0s warm. Confirms the
  original ~4.8s figure was in the right range.
- `llama3.2:3b` — 4.0s cold, **0.5s warm**.
- The non-reasoning-instruct prediction was right in direction and badly
  understated in size: warm, it is roughly **8x** faster than the reasoning
  model, not 2-3x.
- Cold start is a real and separate effect, worth stating because it's what a
  user actually feels: ollama evicts an idle model after a default ~5 minute
  timeout, so the first summary of a session costs roughly 2.5x a warm one
  regardless of which model is configured.

At 0.5s warm, "too slow to be automatic" is no longer true, and the latency
argument for never-automatic no longer holds. Summaries stay strictly on
demand anyway, but for a different and better reason: running a GPU job for
an article that merely scrolled past is rude regardless of how fast it is —
it's someone's laptop battery and someone's GPU, spent on something nobody
asked to read yet. Every design decision below still follows from
never-automatic; only the justification for never-automatic changed.

- Summaries are **on demand**. Never on render, never on scroll, never
  prefetched. A widget that quietly runs a GPU job per visible article
  because it scrolled past is a bad neighbour on a laptop, independent of
  how long that job takes.
- Every result is **cached** against the item id. Asking twice for the same
  article must never cost twice.
- The request is **cancellable in effect**: a generation counter, like
  `fetchGeneration`, so a result that arrives after the user moved on is
  discarded rather than rendered against the wrong article.

## Settings

Split by kind, per the roadmap decision:

- **Connection is global** — base URL, model, optional API key, chosen from
  the `PRESETS` table in `AiProvider.js` (ollama, vLLM, llama.cpp, LM Studio,
  Custom). Nobody wants to retype an endpoint into three widget instances, and
  a typo in one is a baffling partial failure.
- **The feature toggle is per-instance** — a small ticker widget stays dumb
  while a large one summarises.

### Deviation: the toggle is global, not per-instance

This shipped with `aiEnabled` global, contrary to the line above. Every
setting in this plugin goes through `saveValue`/`loadValue`, which bottoms
out in `savePluginData(pluginId, key, value)` — keyed by `pluginId` alone,
with no notion of instance. Making one boolean per-instance would mean
adopting the DMS plugin-variant system (`createPluginVariant`/`variants` in
`PluginSettings.qml`), which nothing in this widget has ever used, for a
single toggle. That's disproportionate on its own merits, separate from the
per-instance idea being right in principle.

Recorded here as a deviation rather than fixed quietly. If a small ticker
instance and a large summarising instance both get built from this plugin
one day, the variant system is the real fix, and it would want to carry
more than just this one boolean once it exists.

Add a **Test Connection** that uses `probeRequest()`: it reports whether the
runtime answers *and* whether the configured model is actually present. A
wrong model name is the likeliest misconfiguration and produces an HTTP 404
that would otherwise surface as a generic failure.

Model-choice guidance belongs in the field description, not in a knob: an
**instruct** tag, not a `-base` tag, and a small non-reasoning model rather
than a large reasoning one. Of what's installed here, `llama3.2:3b` measured
best — 0.5s warm against `qwen3:8b`'s 4.0s, see the measurement above — and
that gap is representative of reasoning vs. non-reasoning generally, not a
quirk of this one pair. `AiProvider.js` deliberately emits neither
`/no_think` nor `chat_template_kwargs` because neither does anything through
ollama's OpenAI shim — both were tested against the live endpoint.

### A bug worth recording because the lesson generalises

The settings panel originally filled the Base URL field from the preset
dropdown's `onCurrentIndexChanged` (change) handler. On a fresh install that
handler never fires: the dropdown loads its default selection, which equals
the default it already holds, so nothing changes and nothing is written. The
field then showed a placeholder that looks identical to a real value, so the
form appeared complete while "Test Connection" correctly reported an empty
base URL against a form the user could see was filled.

Fixed with `AiProvider.resolveBaseUrl(preset, explicitUrl)` — a pure, tested
function shared by the settings panel and the widget so the two cannot
disagree about what URL is actually in effect. The lesson: **a default must
be resolvable without an event having fired.** Filling a field from a change
handler quietly assumes something changed; a fresh install is precisely the
case where nothing did.

## Behaviour

A summarise action on the row, shown **only** when the feature is enabled and
a connection is configured. Three states: idle, in flight (a spinner on that
row, not a global one), and done (the summary rendered under the article text,
collapsible).

An error shows on the row that asked for it and nowhere else. **No toasts.**
A failed summary is not an event worth interrupting the user for, and a widget
that toasts every time a local model is unreachable is unusable on a laptop
that only sometimes runs one.

### `i` from the list: summary-only mode

`i` on a list row opens the reader on that row in a **summary-only** mode: it
shows the AI summary and deliberately does **not** fetch the article's own
page. A "Load full article" button sits alongside the summary and runs the
same fetch-and-extract path the `v` open action uses — `openArticle`'s fetch
half was pulled out into `loadFullText()` so there is exactly one fetch path,
shared by both entry points, not two that could drift apart.

The point of summary-only mode is deciding whether an article is worth
opening at all. Fetching the page anyway, even quietly in the background,
would defeat that: the whole reason to reach for `i` instead of `v` is to
avoid paying for a page you might not want.

Two behaviours fall out of that same reasoning:

- **Summarising from the list does not mark the item read.** Reading a
  two-sentence summary is not reading the article, and an item that was only
  skimmed this way must still show up when the list is filtered to unread.
  The cursor does still move to the row, same as any other row action.
- **`i` is a row action, never a selection action.** `m`, `s` and `e` act on
  the whole selection when one exists, because marking read/starred or
  archiving forty items at once is a reasonable thing to want from one
  keystroke. Summarising forty items from one keystroke is not — it's forty
  GPU jobs fired from a single `i`. `i` always acts on the cursor row alone,
  selection or not. Pinned by `tests/key-map.test.js`.

## Cache

`summaryMap` keyed by item id, with a `summaryOrder` list bounded exactly like
`readOrder`/`bookmarkOrder` — the same "prepend, dedupe, cap" helper, so the
state file cannot grow without limit.

**Bound it lower than the id lists.** Those store ids; this stores paragraphs.
A 200-entry cap on ~400-character summaries is ~80KB of state written on every
change, which is a different order of cost from a list of ids. Start at 100
and make the cap a named constant next to `idHistoryCap`.

Cache survives restarts. A summary is expensive and does not go stale — the
article does not change.

## Degradation

With nothing configured the widget must be **completely usable and completely
silent**: no affordance, no error row, no probe on startup, no retry. This is
the most important behavioural requirement in the phase. An AI feature that
nags is worse than one that does not exist.

## Testing

- Unit (`ReaderState.js` or alongside): the bounded summary cache — insert,
  dedupe, cap, and that a cached entry survives the item being reparsed into a
  new object, since it keys off the stable id.
- Live, opt-in: extend `tests/ai-provider.test.js`'s existing localhost suite
  to summarise a fixture article and assert the shape of what comes back —
  skipping cleanly when nothing answers.
- Manual (Brendon): summarise an article with ollama running; ask again and
  confirm it is instant (cache hit); stop ollama and confirm the affordance
  disappears entirely rather than erroring; check that a summary requested and
  then abandoned does not render against a different article.

**Update, 2026-09-12:** the first three manual checklist items were exercised
today and passed — summarising with ollama running works, a repeat request on
the same item is instant (cache hit), and the affordance disappears entirely
when the feature is unconfigured. The fourth item (a summary requested then
abandoned does not render against the wrong article) was not separately
re-verified today.

What remains unverified: there is no automated QML test harness in this repo
(see [Development](../wiki/Development.md)), so the reader panel, the toolbar
button, and the `i` summary-only mode have no automated coverage of their
on-screen behaviour — only the JS modules underneath them (cache, generation
guard, `resolveBaseUrl`, the key map) are tested automatically. The manual
checklist above is the only check on the UI itself, and needs re-running
after any change that touches the reader or settings QML.
