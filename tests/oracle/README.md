# Quality oracle for `HtmlExtract.js`

Runs **Mozilla Readability** — the algorithm behind Firefox Reader View — in
headless Chromium over 20 real article pages, and compares our own extractor
against it.

    node tests/oracle/run-oracle.js            # use cached pages
    node tests/oracle/run-oracle.js --fetch    # re-download the page set

Skips cleanly when no Chromium is found, or before `HtmlExtract.js` exists.

## Why a browser is here but not in the plugin

Readability needs a DOM, so it runs in a browser. **Neither the browser nor
Readability ships with the plugin**, and neither is a runtime dependency.
Extraction in the widget is our own zero-dependency code; this directory exists
only to measure how good that code is, so the answer is a number rather than an
opinion.

Using a headless browser at runtime was considered and rejected: it would make
the feature unavailable to anyone without Chromium installed, which is the same
objection that ruled out depending on Miniflux's server-side extraction.

## What is measured

Word-multiset overlap against Readability's output, not a diff — our extractor
emits markdown and Readability emits text, so punctuation and layout differ
legitimately. The question is whether we captured the same **prose**.

Short words are ignored, so the score is not inflated by articles and
prepositions agreeing.

## What is not committed

`cache/` holds the fetched pages. They are news articles and not ours to
vendor, so they are gitignored and re-fetched on demand. `Readability.js` is
vendored (Apache 2.0, Arc90/Mozilla) because the comparison is meaningless if
the oracle drifts between runs.
