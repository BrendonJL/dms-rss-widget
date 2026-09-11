# Design: stage 4c — full-text extraction

Date: 2026-09-11
Status: ready to implement
Depends on: 4a/4b (export)

Exported notes currently hold the feed's summary — typically ~1,000 characters
against ~10,000 in the article. A clipping tool that does not clip the article
is a dead end.

## This belongs to the widget, not to a server

Miniflux can do it: `GET /v1/entries/{id}/fetch-content` returns the extracted
article, verified against the local instance (936 → 8,412 chars on a real
Guardian entry). It is tempting and it is the wrong dependency.

The backend interface exists so that features do not vary by backend. A
full-text button that works on Miniflux, silently does nothing on FreshRSS, and
is absent in plain RSS mode is exactly the fragmentation the interface was
built to prevent. **Extraction is the widget's job**, so it works identically
for every source.

Miniflux's endpoint may still be worth wiring later as a *fast path* behind the
existing `fullText` capability — but only once the local path works, and never
as the only route.

## The constraint that shapes everything: no DOM

QML's JS engine has no `DOMParser`, and the module must also run under Node for
tests. So extraction is string processing, like `FeedParser.js` already does
for XML.

**Do not attempt this with regex alone.** Nested tags, attributes containing
`>`, unclosed `<p>`, and comments defeat pattern matching in ways that fail
silently on exactly the pages that matter. Write a small **tokenizer**: a state
machine emitting a flat stream of `{ type: "open"|"close"|"text", tag, attrs }`.
Roughly 200 lines, and it turns every later step into list processing rather
than pattern guessing.

## Algorithm

Deliberately simplified Readability. The goal is a good article body, not a
faithful reimplementation.

1. **Drop** `script`, `style`, `nav`, `header`, `footer`, `aside`, `form`,
   `noscript`, `iframe`, comments, and anything whose class or id matches
   `share|comment|promo|related|newsletter|subscribe|cookie|banner|advert`.
2. **Score** candidate containers (`article`, `main`, `div`, `section`) on the
   text they contain: character count, comma count, paragraph count — and
   **penalise link density hard**. A nav sidebar is mostly links; an article is
   mostly prose. Link density is the single most discriminating signal.
3. `<article>` and `<main>` get a large bonus. When a page says where its
   article is, believe it.
4. **Take the winner**, then emit its descendants as markdown: headings,
   paragraphs, lists, blockquotes, code, inline links and emphasis. Drop
   images by default — a note full of hotlinked CDN images rots.
5. **Fall back** to the feed summary when the winner yields less than ~40% of
   what the summary already had. A worse result than we started with is a
   failure, not an improvement.

## Honesty about quality

This will not match Firefox Reader View. Some pages will extract badly.

So: the note records how its body was obtained — `extracted: true|false` in
frontmatter — and the fallback is silent and automatic. Never present a
mangled extraction as the article without a way to tell.

## Fetching

Same curl discipline as everywhere else: argv array, never a shell string,
`--proto =http,https`, `--max-filesize`, explicit timeouts. `-L` **is** wanted
here (articles redirect constantly) and is safe because these requests carry
no credentials — unlike the API calls, where following a redirect would hand a
token to another host.

Extraction is on demand, at export time, never on fetch. Ten selected articles
means ten HTTP requests to ten different sites; that must be a thing the user
asked for.

## Testing

This is where the value is, and it is fully testable:

- **Fixtures**: real pages, trimmed, in `tests/fixtures/articles/`. Each with
  an expected minimum extracted length and a few phrases that must appear and
  must not (a nav label, a cookie banner, a "related stories" headline).
- **Adversarial**: an empty document; text with no block tags; a page that is
  entirely navigation; unclosed `<p>`; an attribute containing `>`; a comment
  containing `</div>`; and a 5MB page, which must be bounded rather than hang.
- **The fallback**: assert it triggers when extraction underperforms the
  summary, since that is the safety net and an untested safety net is a wish.

## Staging

- **4c-a** — `HtmlExtract.js`: tokenizer, scoring, markdown emit, plus tests.
  Pure, no I/O, no QML. This is the whole risk.
- **4c-b** — wire into export: fetch on demand, cache alongside summaries, the
  frontmatter flag, the fallback.
