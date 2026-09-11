const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
    extractArticle,
    tokenize,
    buildTree,
    annotateStats,
    collectCandidates,
    pickBest,
    scoreNode,
    emitMarkdown,
    plainTextLength,
    decodeEntities,
    isSafeHref,
    indexPageReason
} = require("../HtmlExtract.js");

var FIXTURES = path.join(__dirname, "fixtures", "articles");

function fixture(name) {
    return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

// Returns the link density (0..1) of the container extractArticle actually
// picked, so tests can assert a ceiling on it directly rather than inferring
// it from the markdown.
function winnerLinkDensity(html) {
    var tree = buildTree(tokenize(html));
    annotateStats(tree);
    var best = pickBest(collectCandidates(tree));
    var stats = best._stats;
    return stats.charCount === 0 ? 0 : stats.linkChars / stats.charCount;
}

// ─── real fixtures ───

describe("real fixtures", () => {
    test("wikipedia-rss.html: extracts the article body, not the chrome", () => {
        var html = fixture("wikipedia-rss.html");
        var res = extractArticle(html, {});

        assert.equal(res.usedFallback, false);
        assert.ok(res.textLength > 3000, "expected a substantial extraction, got " + res.textLength);

        // Real article prose must survive.
        assert.match(res.markdown, /web feed/i);
        assert.match(res.markdown, /RSS 2\.0/);
        assert.match(res.markdown, /Winer/);

        // Wikipedia chrome (nav, personal tools, sidebar controls) must not.
        ["Main page", "Create account", "Log in", "Contribute",
            "Toggle the table of contents", "Random article", "Donate"
        ].forEach(function (phrase) {
            assert.ok(!res.markdown.includes(phrase), "chrome leaked into extraction: " + phrase);
        });

        assert.ok(winnerLinkDensity(html) < 0.3, "winning container should be prose-dominant, not link-dominant");
    });

    test("gutenberg-tomsawyer.html: long plain prose with almost no markup", () => {
        var html = fixture("gutenberg-tomsawyer.html");
        var res = extractArticle(html, {});

        assert.equal(res.usedFallback, false);
        assert.ok(res.textLength > 20000, "expected most of the book's prose, got " + res.textLength);

        assert.match(res.markdown, /Aunt Polly/);
        assert.match(res.markdown, /Tom Sawyer/i);

        assert.ok(winnerLinkDensity(html) < 0.3);
    });
});

// ─── synthetic fixtures ───

describe("synthetic fixtures", () => {
    test("nav-heavy-article.html: a real <article> wins over surrounding nav chrome", () => {
        var html = fixture("nav-heavy-article.html");
        var res = extractArticle(html, {});

        assert.equal(res.usedFallback, false);
        assert.ok(res.textLength > 500);

        assert.match(res.markdown, /River restoration project/);
        assert.match(res.markdown, /waterfront/);

        ["World", "Sport", "Culture", "Opinion", "Subscribe now",
            "Council raises parking fees", "About", "Careers", "Privacy Policy"
        ].forEach(function (phrase) {
            assert.ok(!res.markdown.includes(phrase), "nav/boilerplate leaked into extraction: " + phrase);
        });

        assert.equal(winnerLinkDensity(html), 0, "the <article> body here carries no links at all");
    });

    test("div-soup.html: loose text directly under <div>s becomes paragraphs", () => {
        var html = fixture("div-soup.html");
        var res = extractArticle(html, {});

        assert.equal(res.usedFallback, false);
        assert.ok(res.textLength > 400);

        assert.match(res.markdown, /bakery/i);
        assert.match(res.markdown, /Elm and Fourth/);

        // The winning container is the prose div, not the link-heavy sidebar.
        ["Half price pastries", "Sign up for our newsletter"].forEach(function (phrase) {
            assert.ok(!res.markdown.includes(phrase), "sidebar leaked into extraction: " + phrase);
        });

        // The div soup should split into more than one paragraph, not one run-on blob.
        var paragraphs = res.markdown.split("\n\n").filter(Boolean);
        assert.ok(paragraphs.length >= 3, "expected multiple paragraphs, got " + paragraphs.length);

        assert.ok(winnerLinkDensity(html) < 0.1);
    });

    test("all-navigation.html: two nav lists and one real sentence -- the sentence wins", () => {
        var html = fixture("all-navigation.html");
        var res = extractArticle(html, {});

        assert.match(res.markdown, /Page not found/);
        assert.ok(res.textLength < 50, "expected a tiny extraction, got " + res.textLength);

        ["World News", "Business", "Technology", "Advertise", "Terms of use"].forEach(function (phrase) {
            assert.ok(!res.markdown.includes(phrase), "nav label leaked into extraction: " + phrase);
        });
    });
});

// ─── index-page guard ───
//
// Measured 2026-09-11: a real section front scores as a legitimate-looking
// container (nonzero charCount, some structure) but is not an article --
// Readability correctly refuses it and this extractor must too.

describe("index-page guard", () => {
    test("30 headline links: falls back instead of returning headline soup", () => {
        var storiesHtml = "";
        for (var i = 1; i <= 30; i++) {
            storiesHtml += "<div class=\"story\"><a href=\"/story/" + i +
                "\">Breaking update number " + i + " from the newsroom</a> <span>2h ago</span></div>";
        }
        var html = "<main>" + storiesHtml + "</main>";
        var res = extractArticle(html, {});

        assert.equal(res.usedFallback, true);
        assert.match(res.reason, /index page/i);
    });

    test("indexPageReason: high link density alone is enough to reject", () => {
        var reason = indexPageReason("[A link](x)\n\n[B link](y)", 0.9);
        assert.ok(reason);
        assert.match(reason, /link density 90%/);
    });

    test("indexPageReason: mostly short unpunctuated text is enough to reject", () => {
        var lines = [];
        for (var i = 0; i < 20; i++) lines.push("Short headline fragment number " + i + " right here");
        var reason = indexPageReason(lines.join("\n"), 0);
        assert.ok(reason);
        assert.match(reason, /short unpunctuated/);
    });

    test("indexPageReason: markdown headings do not count against a real article", () => {
        var md = "## Introduction\n\nA full sentence with proper punctuation right here.\n\n" +
            "## Background\n\nAnother full sentence, also properly punctuated for good measure.\n\n" +
            "## Conclusion\n\nA closing sentence that wraps things up nicely indeed.";
        assert.equal(indexPageReason(md, 0), null);
    });

    test("indexPageReason: too little text to judge -> never rejects on shape alone", () => {
        assert.equal(indexPageReason("One short line\n\nAnother short one", 0), null);
    });

    // Measured 2026-09-11: a real page (an LWN advisory digest, almost
    // entirely one <pre> block of a forwarded email) false-positived here
    // before fenced code was excluded -- "From:", "To:", "Subject:" are
    // short and unpunctuated by nature, and that is a property of quoted
    // plain text, not evidence of an index.
    test("indexPageReason: fenced code content is excluded from the fragment tally", () => {
        var codeLines = [];
        for (var i = 0; i < 20; i++) codeLines.push("Key" + i + ": value " + i);
        var md = "```\n" + codeLines.join("\n") + "\n```\n\n" +
            "A single real paragraph with proper terminal punctuation right here.";
        assert.equal(indexPageReason(md, 0), null);
    });

    test("real fixtures do not trip the guard", () => {
        ["wikipedia-rss.html", "gutenberg-tomsawyer.html", "nav-heavy-article.html", "div-soup.html"]
            .forEach(function (name) {
                var res = extractArticle(fixture(name), {});
                assert.equal(res.usedFallback, false, name + " unexpectedly fell back: " + res.reason);
            });
    });
});

// ─── adversarial ───

describe("adversarial input", () => {
    test("empty document", () => {
        var res = extractArticle("", {});
        assert.equal(res.usedFallback, true);
        assert.equal(res.markdown, "");
        assert.equal(res.textLength, 0);
        assert.ok(res.reason.length > 0);
    });

    test("non-string / null input never throws", () => {
        assert.doesNotThrow(function () { extractArticle(null, {}); });
        assert.doesNotThrow(function () { extractArticle(undefined, {}); });
        assert.doesNotThrow(function () { extractArticle(42, {}); });
        var res = extractArticle(null, {});
        assert.equal(res.usedFallback, true);
    });

    test("text with no block tags at all", () => {
        var text = "Hello world, this is just plain text with no markup at all, " +
            "repeated to be long enough to count as real content for this test.";
        var res = extractArticle(text, {});
        assert.equal(res.usedFallback, false);
        assert.equal(res.markdown, text);
    });

    test("a page that is entirely <nav>: no salvageable content, falls back", () => {
        var html = "<nav><ul><li><a href='/a'>A</a></li><li><a href='/b'>B</a></li>" +
            "<li><a href='/c'>C</a></li></ul></nav><header><a href='/'>Home</a></header>";
        var res = extractArticle(html, { summary: "A short summary." });
        assert.equal(res.usedFallback, true);
        assert.equal(res.markdown, "A short summary.");
    });

    test("unclosed <p>: a second <p> implicitly closes the first", () => {
        var html = "<div><p>First paragraph text right here." +
            "<p>Second paragraph text right here.</div>";
        var res = extractArticle(html, {});
        assert.equal(res.usedFallback, false);
        var paragraphs = res.markdown.split("\n\n");
        assert.equal(paragraphs.length, 2);
        assert.equal(paragraphs[0], "First paragraph text right here.");
        assert.equal(paragraphs[1], "Second paragraph text right here.");
    });

    test("an attribute containing '>' does not truncate the tag", () => {
        var html = '<article><p>Before <a title="a > b" href="http://x.com/p?a=1&b=2">link text</a> after, ' +
            "with enough surrounding prose to make this the clear winner on the page.</p></article>";
        var res = extractArticle(html, {});
        assert.equal(res.usedFallback, false);
        assert.match(res.markdown, /\[link text\]\(http:\/\/x\.com\/p\?a=1&b=2\)/);
        assert.match(res.markdown, /Before .* after/);
    });

    test("a comment containing '</div>' does not close the real element early", () => {
        var html = "<article><p>Paragraph before the tricky comment, long enough to matter for scoring here.</p>" +
            "<!-- </div> a stray closing tag hidden inside a comment -->" +
            "<p>Paragraph after the tricky comment, also long enough to matter for scoring purposes.</p></article>";
        var res = extractArticle(html, {});
        assert.equal(res.usedFallback, false);
        var paragraphs = res.markdown.split("\n\n");
        assert.equal(paragraphs.length, 2);
        assert.match(paragraphs[0], /before the tricky comment/);
        assert.match(paragraphs[1], /after the tricky comment/);
    });

    test("a very large input is bounded, not hung", () => {
        var big = "<article>";
        for (var i = 0; i < 400000; i++) big += "<p>word word word word word, more words here.</p>";
        big += "</article>";

        var t0 = Date.now();
        var res = extractArticle(big, {});
        var elapsedMs = Date.now() - t0;

        assert.ok(elapsedMs < 5000, "extraction took too long: " + elapsedMs + "ms");
        assert.equal(res.usedFallback, false);
        assert.ok(res.textLength > 0);
        // The token cap means the output is bounded well below the full input,
        // even though the input itself is tens of megabytes.
        assert.ok(res.textLength < big.length, "output should be bounded below full input size");
    });

    test("maxInputLength / maxTokens options are honoured", () => {
        var html = "<article>" + "<p>Paragraph number filler text here.</p>".repeat(1000) + "</article>";
        var resTiny = extractArticle(html, { maxTokens: 20 });
        var resFull = extractArticle(html, {});
        assert.ok(resTiny.textLength < resFull.textLength);
    });
});

// ─── the fallback safety net ───

describe("fallback to summary", () => {
    test("triggers when extraction underperforms the summary", () => {
        var html = "<div id='menu'><ul><li><a href='/a'>A</a></li><li><a href='/b'>B</a></li></ul></div>" +
            "<div><p>Tiny.</p></div>";
        var summary = "This is a much longer summary than the extracted body, describing the article " +
            "in far more detail than what actually got extracted from the page itself.";
        var res = extractArticle(html, { summary: summary });

        assert.equal(res.usedFallback, true);
        assert.equal(res.markdown, summary);
        assert.match(res.reason, /below 40% of summary/);
    });

    test("does NOT trigger when extraction is comparable to or better than the summary", () => {
        var html = fixture("nav-heavy-article.html");
        var res = extractArticle(html, { summary: "A short one-line summary of the story." });
        assert.equal(res.usedFallback, false);
    });

    test("no summary given: extraction stands even if short, unless it is empty", () => {
        var res = extractArticle("<nav><a href='/x'>X</a></nav><div><p>Ok.</p></div>", {});
        assert.equal(res.usedFallback, false);
        assert.equal(res.markdown, "Ok.");
    });
});

// ─── unit-level tokenizer / helpers ───

describe("tokenize", () => {
    test("splits open, text, and close tokens", () => {
        var tokens = tokenize("<p>hi</p>");
        assert.deepEqual(tokens.map(function (t) { return t.type; }), ["open", "text", "close"]);
    });

    test("script content is never tokenized as markup", () => {
        var tokens = tokenize("<script>if (1<2) { document.write('<p>fake</p>'); }</script><p>real</p>");
        var opens = tokens.filter(function (t) { return t.type === "open"; }).map(function (t) { return t.tag; });
        assert.deepEqual(opens, ["script", "p"]);
    });

    test("respects maxTokens", () => {
        var html = "<p>a</p>".repeat(1000);
        var tokens = tokenize(html, 10);
        assert.ok(tokens.length <= 10);
    });
});

describe("decodeEntities / isSafeHref", () => {
    test("decodes named and numeric entities", () => {
        assert.equal(decodeEntities("A &amp; B &lt;tag&gt; &#39;q&#39;"), "A & B <tag> 'q'");
    });

    test("rejects javascript: and data: hrefs", () => {
        assert.equal(isSafeHref("javascript:alert(1)"), false);
        assert.equal(isSafeHref("data:text/html,x"), false);
        assert.equal(isSafeHref("https://example.com"), true);
        assert.equal(isSafeHref("/relative/path"), true);
    });
});

describe("plainTextLength", () => {
    test("strips markdown syntax before measuring", () => {
        assert.equal(plainTextLength("# Heading\n\nSome **bold** and [a link](http://x.com) text."),
            plainTextLength("Heading\n\nSome bold and a link text."));
    });
});

// Extracted articles are full of site-relative links. Emitted as-is they
// become "[text](/news/articles/x)" in the note -- something that reads as a
// link, invites a click, and goes nowhere. Reported from a real export.
describe("relative links are resolved against the article's URL", () => {
    const BASE = "https://www.bbc.co.uk/news/articles/c23x72yx2rvo?at_medium=RSS";

    function extract(bodyHtml, baseUrl) {
        const pad = "Padding prose to clear the minimum length threshold. ".repeat(12);
        const html = "<html><body><article><p>" + bodyHtml + "</p><p>" + pad + "</p></article></body></html>";
        return extractArticle(html, { baseUrl: baseUrl, summary: "s" }).markdown;
    }

    test("a site-relative href gets the article's origin", () => {
        const md = extract('<a href="/news/articles/abc">text</a>', BASE);
        assert.match(md, /\[text\]\(https:\/\/www\.bbc\.co\.uk\/news\/articles\/abc\)/);
    });

    test("an absolute href is left alone", () => {
        const md = extract('<a href="https://example.com/x">text</a>', BASE);
        assert.match(md, /\[text\]\(https:\/\/example\.com\/x\)/);
    });

    test("a protocol-relative href inherits the scheme", () => {
        const md = extract('<a href="//cdn.example.com/x">text</a>', BASE);
        assert.match(md, /\[text\]\(https:\/\/cdn\.example\.com\/x\)/);
    });

    test("a document-relative href resolves against the base's directory", () => {
        const md = extract('<a href="sub/page">text</a>', BASE);
        assert.match(md, /\[text\]\(https:\/\/www\.bbc\.co\.uk\/news\/articles\/sub\/page\)/);
    });

    test("../ segments collapse", () => {
        const md = extract('<a href="../other/page">text</a>', BASE);
        assert.match(md, /\[text\]\(https:\/\/www\.bbc\.co\.uk\/news\/other\/page\)/);
    });

    // These cannot be made to work, so they must not look like links.
    test("an in-page anchor keeps its text and loses the link", () => {
        const md = extract('<a href="#section">text</a>', BASE);
        assert.match(md, /\btext\b/);
        assert.doesNotMatch(md, /\[text\]\(/);
    });

    test("with no baseUrl, a relative href degrades to plain text", () => {
        const md = extract('<a href="/news/articles/abc">text</a>', "");
        assert.match(md, /\btext\b/);
        assert.doesNotMatch(md, /\[text\]\(/);
    });

    test("javascript: is never emitted as a link", () => {
        const md = extract('<a href="javascript:alert(1)">text</a>', BASE);
        assert.doesNotMatch(md, /javascript:/);
        assert.match(md, /\btext\b/);
    });

    test("no relative path survives into the output", () => {
        const md = extract(
            '<a href="/a">one</a> <a href="b">two</a> <a href="#c">three</a> <a href="https://x.com/d">four</a>',
            BASE);
        const links = md.match(/\]\(([^)]*)\)/g) || [];
        links.forEach(l => assert.match(l, /\]\((https?:)?\/\//,
            "every emitted link must be absolute, got " + l));
    });
});

// Every fixture must survive extraction without throwing.
//
// This exists because threading a new `opts` argument through the emitters
// missed one function -- emitList -- and the whole suite stayed green while
// the extractor threw "opts is not defined" on 14 of 20 real pages. The unit
// tests exercised paragraphs and links; nothing exercised a LIST with the new
// argument in play, and a ReferenceError only fires on the branch that touches
// the missing binding.
//
// A per-feature test proves a feature works. This proves the module survives
// real input, which is a different question and the one that failed.
describe("no fixture throws", () => {
    var files = fs.readdirSync(FIXTURES).filter(function (f) { return /\.html$/.test(f); });

    test("there are fixtures to check", () => {
        assert.ok(files.length >= 3, "expected several fixtures, found " + files.length);
    });

    files.forEach(function (f) {
        test(f + " extracts without throwing", () => {
            var html = fs.readFileSync(path.join(FIXTURES, f), "utf8");
            var r;
            assert.doesNotThrow(function () {
                r = extractArticle(html, {
                    baseUrl: "https://example.com/section/page?x=1",
                    summary: "a short feed summary"
                });
            }, "extraction threw on " + f);
            assert.equal(typeof r.markdown, "string");
            assert.equal(typeof r.usedFallback, "boolean");
        });

        // Same page with no options at all: every caller-supplied field must be
        // optional, since buildNote's signature keeps them so.
        test(f + " extracts with no options", () => {
            var html = fs.readFileSync(path.join(FIXTURES, f), "utf8");
            assert.doesNotThrow(function () { extractArticle(html, {}); });
            assert.doesNotThrow(function () { extractArticle(html); });
        });
    });

    // A link inside a list is the exact shape that slipped through.
    test("a list containing links extracts and resolves them", () => {
        var html = "<html><body><article><h1>T</h1><ul>" +
            "<li>An item with <a href=\"/one\">a relative link</a> in it</li>" +
            "<li>Another item with <a href=\"https://x.com/two\">an absolute one</a></li>" +
            "</ul><p>" + "Padding prose to clear the length threshold. ".repeat(12) +
            "</p></article></body></html>";
        var md = extractArticle(html, { baseUrl: "https://site.example/a/b", summary: "s" }).markdown;
        assert.match(md, /https:\/\/site\.example\/one/);
        assert.match(md, /https:\/\/x\.com\/two/);
        assert.doesNotMatch(md, /\]\(\/one\)/);
    });
});

// Publishers splice "recommended stories" widgets between paragraphs, inside
// the article container, with no class the boilerplate filter catches. Both
// shapes were found in real exports: Al Jazeera labels the section with a
// heading, the BBC emits a bare list of headline links.
describe("promo sections are dropped from the article body", () => {
    const PROSE = "This is a genuine paragraph of article prose, long enough to count as real content rather than a fragment. ";

    function article(middle) {
        return "<html><body><article><h1>Title</h1><p>" + PROSE.repeat(2) + "</p>" +
            middle + "<p>" + PROSE.repeat(2) + "</p></article></body></html>";
    }

    function md(html) {
        return extractArticle(html, { baseUrl: "https://site.example/a/b", summary: "s" }).markdown;
    }

    test("a labelled Recommended Stories section is dropped with its list", () => {
        const out = md(article(
            "<h2>Recommended Stories</h2><ul>" +
            "<li><a href='/one'>Some other article entirely</a></li>" +
            "<li><a href='/two'>And another unrelated headline</a></li></ul>"));
        assert.doesNotMatch(out, /Recommended Stories/i);
        assert.doesNotMatch(out, /Some other article entirely/);
        assert.match(out, /genuine paragraph of article prose/);
    });

    test("the drop stops at the next heading of the same level", () => {
        const out = md(article(
            "<h2>Related Stories</h2><ul><li><a href='/x'>Promo headline</a></li></ul>" +
            "<h2>Focus of attacks</h2><p>" + PROSE + "</p>"));
        assert.doesNotMatch(out, /Promo headline/);
        assert.match(out, /Focus of attacks/, "a real section heading after the promo must survive");
    });

    test("a normal article heading is never treated as promo", () => {
        const out = md(article("<h2>What happens next</h2><p>" + PROSE + "</p>"));
        assert.match(out, /What happens next/);
    });

    // Al Jazeera prefixes list items with screen-reader text.
    test("screen-reader 'list N of M' prefixes do not defeat the match", () => {
        const out = md(article(
            "<h2>Recommended Stories</h2><ul>" +
            "<li>list 1 of 2 <a href='/one'>Promo headline one</a></li>" +
            "<li>list 2 of 2 <a href='/two'>Promo headline two</a></li></ul>"));
        assert.doesNotMatch(out, /Promo headline/);
    });

    test("an unlabelled short list of bare links between prose is dropped", () => {
        const out = md(article(
            "<ul><li><a href='/one'>Saudi Arabia vows to respond after attacks</a></li>" +
            "<li><a href='/two'>Oil hits $100 a barrel for the first time</a></li></ul>"));
        assert.doesNotMatch(out, /Saudi Arabia vows/);
    });

    // The dangerous direction: a reference list is real content.
    test("a LONG list of links is kept -- that is a reference list, not a promo", () => {
        let items = "";
        for (let i = 0; i < 12; i++) items += "<li><a href='/r" + i + "'>Reference number " + i + "</a></li>";
        const out = md(article("<ul>" + items + "</ul>"));
        assert.match(out, /Reference number 0/, "a 12-item link list is content and must survive");
        assert.match(out, /Reference number 11/);
    });

    test("a list with real text beyond its links is kept", () => {
        const out = md(article(
            "<ul><li>First step, which explains something and links to <a href='/one'>a source</a></li>" +
            "<li>Second step, also with explanation and <a href='/two'>another source</a></li></ul>"));
        assert.match(out, /First step/);
    });
});
