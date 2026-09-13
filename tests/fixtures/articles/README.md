# Extraction fixtures

Real pages, for `HtmlExtract.js`. Structural variety matters more than volume:
an extractor tuned on one publisher's markup overfits to it.

| File | Source | Licence | Why it is here |
|---|---|---|---|
| `wikipedia-rss.html` | en.wikipedia.org/wiki/RSS | CC BY-SA 4.0 | Heavy chrome: sidebars, nav, infoboxes, reference lists. The link-density signal has to survive it. |
| `gutenberg-tomsawyer.html` | gutenberg.org (Twain) | Public domain | Long, plain prose with almost no markup — the opposite failure mode. |

Both are **truncated** to keep the repo small, which is deliberate: a truncated
page ends mid-element, so every fixture doubles as an unclosed-tag case.

Only redistributable sources are committed. News articles are not: they are
the real target, but not ours to vendor. Extraction quality against live news
pages is checked by an opt-in live test that fetches at run time and commits
nothing.

## Synthetic fixtures

Small, hand-written pages covering structures the two real pages above don't
exercise:

| File | Why it is here |
|---|---|
| `nav-heavy-article.html` | Header/nav/aside/footer chrome (all droppable) wrapped around one real `<article>` — the `<article>` bonus has to win over sheer link-heavy volume elsewhere on the page. |
| `div-soup.html` | No semantic tags at all: `<div class="headline">`, `<div class="para">`, ... — text sits directly in `<div>`s with no `<p>`, exercising the "loose text becomes its own paragraph" path. Also carries a small link-heavy sidebar (`class="ad"`, deliberately *not* one of the dropped boilerplate class names) to show the link-density penalty doing the job the class/tag drop-list doesn't. |
| `all-navigation.html` | Two link lists and one paragraph of real content ("Page not found."). Exercises the low-content/fallback path. |
