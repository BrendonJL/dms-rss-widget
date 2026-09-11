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
    isSafeHref
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
