# Design: Phase 5 — reader and annotation app

Date: 2026-09-11
Status: design only, not started
Depends on: Phase 4 (export). Phase 3 is useful but not required.

The widget stays the glanceable list. This is where reading happens: a
standalone window, launched from the widget, showing one article at a time
with room to highlight and annotate.

Per the roadmap decision it ships **in this repo as a second plugin**, so it
shares `ExportProvider.js`, `FeedParser.js` and the backends directly rather
than duplicating them, and one registry listing covers both.

## The hard part is anchoring, not the UI

A highlight must survive the article being fetched again — with different
whitespace, an inserted subscribe banner, a rewritten wrapper, or a
paragraph the publisher edited after publication.

**Character offsets do not survive any of that.** Store instead, per
highlight:

```js
{ exactQuote, prefixContext, suffixContext, approxOffset }
```

and re-locate on load by searching for `exactQuote`, disambiguating repeats
with the surrounding context, and using `approxOffset` only as a tiebreaker
between otherwise identical candidates. This is the model the W3C Web
Annotation spec settled on, for exactly this reason.

**A failed relocation must degrade, never guess.** An anchor that cannot be
found becomes an orphaned note attached to the article, visibly marked as
such. A highlight silently landing on the wrong sentence is worse than one
that admits it is lost, because the user will not notice and will later trust
a quote the article never made.

`anchorHighlight(articleText, anchor) -> { start, end } | null` is a pure
function. It is the whole risk of this phase and it is fully unit-testable:
whitespace changes, a duplicated quote, text inserted before and after,
the quote deleted entirely, an empty article.

## Storage

Annotations live in **plugin state**, keyed by article id; markdown is a
derived export, never the store. Round-tripping structured anchors through a
file a user may have reflowed means parsing our own bookkeeping back out of
prose. A hand-edited exported note is a copy, and we never read it back.

The state cost is real — annotations are unbounded in a way read ids are not,
since a heavy annotator on one article can outweigh a thousand read markers.
Cap per article rather than globally, so one article cannot evict another's
work.

## The window

Quickshell, shaped like DankCalendar. Not a layer-shell panel: this is a
reading surface the user sits with, so it wants to be a normal window they
can move, resize and leave open.

Keyboard-first, reusing `KeyMap.js`'s vocabulary where it transfers — `j`/`k`
to scroll, `o` to open externally, `s` to save, `e` to export, `Esc` to close.
`h` to highlight the selection is new.

**Full-text fetch**: in Miniflux and Google Reader modes the body often is not
in the feed. Both servers can fetch it; that is a backend capability
(`fullText`, already in the interface and currently false for every backend)
rather than a reader-app concern. Wire the capability first, in whichever
phase touches the backends next.

## Staging

- **5a** — `Anchor.js` plus tests. Pure, and the entire risk. Do this first
  and alone; if fuzzy relocation cannot be made reliable, the rest of the
  phase needs rethinking, and that is much cheaper to discover here.
- **5b** — the window: layout, typography, scrolling, keyboard.
- **5c** — selection to highlight, margin notes, the annotation store.
- **5d** — export of an article plus its annotations through Phase 4.

## What would make this fail

Worth stating before building anything:

- **Anchoring that is subtly wrong.** Mitigated by 5a first, and by orphaning
  rather than guessing.
- **Reading feel.** Typography, measure and spacing are the entire product
  here, and they are subjective. This is the one phase where the design
  cannot be settled by reasoning; it needs Brendon reading real articles in
  it and saying what is wrong.
- **Scope.** A reader app can absorb infinite work — themes, fonts, reading
  positions, sync. 5b should be plain and unconfigurable until it is
  pleasant to read, and only then gain options.
