# Design: stage 3b — per-article summaries

Date: 2026-09-10
Status: ready to implement
Depends on: 3a (`AiProvider.js`, done)

`AiProvider.js` is built and tested but wired to nothing. This gives it a UI.

## The measurement that decides the design

**~4.8s** for a two-sentence summary of a ~120-word article, measured on this
machine (RTX 2070 Super, qwen3:8b). Roughly 60% of that is a reasoning model
thinking; a non-reasoning instruct model is 2-3x faster.

Five seconds is far too slow for anything automatic. Every design decision
below follows from it:

- Summaries are **on demand**. Never on render, never on scroll, never
  prefetched. A widget that quietly runs a 5s GPU job per visible article
  because it scrolled past is a bad neighbour on a laptop.
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

Add a **Test Connection** that uses `probeRequest()`: it reports whether the
runtime answers *and* whether the configured model is actually present. A
wrong model name is the likeliest misconfiguration and produces an HTTP 404
that would otherwise surface as a generic failure.

Model-choice guidance belongs in the field description, not in a knob: an
**instruct** tag, not a `-base` tag, and a non-reasoning model if summaries
feel slow. `AiProvider.js` deliberately emits neither `/no_think` nor
`chat_template_kwargs` because neither does anything through ollama's OpenAI
shim — both were tested against the live endpoint.

## Behaviour

A summarise action on the row, shown **only** when the feature is enabled and
a connection is configured. Three states: idle, in flight (a spinner on that
row, not a global one), and done (the summary rendered under the article text,
collapsible).

An error shows on the row that asked for it and nowhere else. **No toasts.**
A failed summary is not an event worth interrupting the user for, and a widget
that toasts every time a local model is unreachable is unusable on a laptop
that only sometimes runs one.

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
