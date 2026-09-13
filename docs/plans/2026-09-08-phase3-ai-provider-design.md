# Design: Phase 3 — local AI provider

Date: 2026-09-08
Status: 3a implemented; 3b-3d not built
Depends on: Phase 0 (backend interface), for config plumbing only

> **Status:** stage 3a implemented — `AiProvider.js`, its tests, and the QML
> DI round-trip (`tests/qml/ai-provider.qml`) all exist. Stages 3b-3d
> (per-article TL;DR, digest, interest ranking — the actual UI features) are
> **still not implemented**; nothing in `DankRssWidget.qml` or
> `DankRssWidgetSettings.qml` references `AiProvider.js`. The bounded summary
> cache in `ReaderState.js` (`addSummary`/`getSummary`/`hasSummary`/
> `pruneSummaries`) was built ahead of 3b and is the only part of it that
> exists.

## Interface: the OpenAI-compatible chat API, not "an ollama integration"

A provider is `{ label, baseUrl, model, apiKey?, timeoutMs }` and nothing else.
`POST {baseUrl}/chat/completions`, read `choices[0].message.content`.

Presets ship as a table, not as code paths: ollama
(`http://localhost:11434/v1`), vLLM (`http://localhost:8000/v1`), llama.cpp,
LM Studio (`http://localhost:1234/v1`), Custom. Adding a runtime later is a
table row.

Verified against this machine's ollama rather than assumed:

- `GET /v1/models` → 200, OpenAI-shaped `{"object":"list","data":[...]}`.
- `POST /v1/chat/completions` → 200, standard
  `{choices:[{message:{role,content},finish_reason}],usage:{...}}`.

Using ollama's native `/api/generate` would work today and lock out every other
runtime tomorrow. That is the whole reason this phase has an interface at all.

## Measurements (RTX 2070 Super, qwen3:8b, 2026-09-08)

A two-sentence summary of a ~120-word article:

| Variant | Wall | Completion tokens | Reasoning chars |
|---|---|---|---|
| plain | 4.76s | 276 | 1096 |
| `/no_think` prefix | 4.95s | 286 | 1128 |
| `chat_template_kwargs.enable_thinking=false` | 4.87s | 285 | 1109 |

Three conclusions, all load-bearing:

1. **qwen3 is a reasoning model and roughly 60% of its generation is thinking,
   not output.** Neither documented suppression knob works through ollama's
   OpenAI shim — both were tried and neither changed a thing.
2. **So the fix is model choice, not a flag.** The provider must not try to
   suppress reasoning; it should make the model field prominent and document
   that a non-reasoning instruct model is roughly 2-3x faster for this workload.
   (Reminder from the nvim work: an *instruct* tag here, never a `-base` tag,
   which continues text instead of following the instruction.)
3. **Parsing is unaffected.** ollama returns reasoning in a separate
   `message.reasoning` field and leaves `message.content` clean, so reading
   `content` is correct with or without a reasoning model. Do not write a
   `<think>`-stripping regex; it is not needed here.

**~5s per article is the number the UX must be designed around.** That rules out
summarising on render or on scroll. Summaries are on-demand and cached against
the item id, full stop.

## Staging

**3a — `AiProvider.js` + tests.** Pure JS, node-testable, same shape as
`Backends.js`: build a request descriptor (`{ argv, parse }`), perform no I/O,
let QML run it. Reuses the curl-argv discipline: the API key is always its own
argv element, never concatenated, never a shell string. Add the same
token-isolation test.

Also `probeRequest()` → `GET /models`, used to answer "is a runtime reachable
and does it have this model?" without generating anything.

**3b — per-article TL;DR.** On-demand button, cached by item id. Cache lives in
plugin state, bounded like `readOrder`/`bookmarkOrder` already are.

**3c — digest.** One call over the last 24h of titles + descriptions. Cheaper
per-item than 3b because it is a single request; the prompt-size ceiling is the
constraint, not latency.

**3d — interest ranking.** `/v1/embeddings`, rank unread by similarity to
starred. Highest risk on the roadmap: ranking that feels wrong is worse than no
ranking. Default off, with a visible reason for a high rank and a one-click
return to reverse-chronological.

## Config placement

Per the roadmap decisions: **connection is global** (baseUrl, model, apiKey —
nobody wants to retype an endpoint into three widget instances, and a typo in
one is a baffling partial failure), **feature toggles are per-instance** (a
small ticker widget stays dumb while a large one summarises).

## Degradation

No runtime reachable → every AI affordance hides. No toasts, no error rows, no
retry storms on a laptop that simply is not running ollama today. The widget
must be completely usable and completely silent with nothing configured. This is
the single most important behavioural requirement in the phase: an AI feature
that nags is worse than one that does not exist.

## Testing

- Unit: descriptor argv for each preset; key isolation; `parse` over recorded
  responses including a reasoning-model response (assert `content` is used and
  `reasoning` ignored); error shapes (connection refused, 404 model, malformed
  JSON, empty choices).
- QML harness (`tests/qml/run.sh`): the DI round-trip, as with `Backends.js`.
- **Live, opt-in:** a test that actually calls `localhost:11434` and skips
  cleanly when nothing answers. Recorded fixtures rot silently against a real
  API; one live test that skips is worth more than ten that cannot fail.
