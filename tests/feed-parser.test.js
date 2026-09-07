const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
    extractTag,
    cleanText,
    stripHtml,
    getRelativeTime,
    extractImageUrl,
    isSafeUrl,
    makeItemId,
    parseRssFeed,
    parseAtomFeed,
    parseFeed,
    rootElementName,
    rootElementPrefix,
    stripNamespacePrefix,
    parseOpml,
    dedupeItems,
    parseMinifluxEntries
} = require("../FeedParser.js");

// ─── extractTag ───

describe("extractTag", () => {
    test("extracts simple tag content", () => {
        assert.equal(extractTag("<title>Hello World</title>", "title"), "Hello World");
    });

    test("extracts tag with CDATA", () => {
        assert.equal(
            extractTag("<description><![CDATA[Some <b>bold</b> text]]></description>", "description"),
            "Some <b>bold</b> text"
        );
    });

    test("extracts tag with attributes", () => {
        assert.equal(
            extractTag('<title type="html">My Title</title>', "title"),
            "My Title"
        );
    });

    test("returns empty string for missing tag", () => {
        assert.equal(extractTag("<item><link>http://x.com</link></item>", "title"), "");
    });

    test("handles multiline content", () => {
        const xml = "<description>\n  Line 1\n  Line 2\n</description>";
        assert.equal(extractTag(xml, "description"), "Line 1\n  Line 2");
    });

    test("is case-insensitive", () => {
        assert.equal(extractTag("<Title>Test</Title>", "title"), "Test");
    });
});

// ─── cleanText ───

describe("cleanText", () => {
    test("decodes &amp;", () => {
        assert.equal(cleanText("Tom &amp; Jerry"), "Tom & Jerry");
    });

    test("decodes &lt; and &gt;", () => {
        assert.equal(cleanText("a &lt; b &gt; c"), "a < b > c");
    });

    test("decodes &quot;", () => {
        assert.equal(cleanText('He said &quot;hi&quot;'), 'He said "hi"');
    });

    test("decodes &#39; and &apos;", () => {
        assert.equal(cleanText("it&#39;s &apos;fine&apos;"), "it's 'fine'");
    });

    test("decodes hex numeric entities", () => {
        assert.equal(cleanText("&#x2019;"), "\u2019");  // right single quote
    });

    test("decodes decimal numeric entities", () => {
        assert.equal(cleanText("&#8212;"), "\u2014");  // em dash
    });

    test("collapses whitespace", () => {
        assert.equal(cleanText("  hello   world  \n  foo  "), "hello world foo");
    });

    test("returns empty string for null/undefined", () => {
        assert.equal(cleanText(null), "");
        assert.equal(cleanText(undefined), "");
        assert.equal(cleanText(""), "");
    });

    test("handles multiple entity types together", () => {
        assert.equal(cleanText("&lt;b&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;"), "<b>Tom & Jerry's</b>");
    });
});

// ─── stripHtml ───

describe("stripHtml", () => {
    test("removes HTML tags", () => {
        assert.equal(stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
    });

    test("handles self-closing tags", () => {
        assert.equal(stripHtml("Line 1<br/>Line 2"), "Line 1Line 2");
    });

    test("returns empty string for null", () => {
        assert.equal(stripHtml(null), "");
        assert.equal(stripHtml(""), "");
    });

    test("preserves text without HTML", () => {
        assert.equal(stripHtml("plain text"), "plain text");
    });

    test("handles tags with attributes", () => {
        assert.equal(stripHtml('<a href="http://x.com">link</a>'), "link");
    });
});

// ─── getRelativeTime ───

describe("getRelativeTime", () => {
    const now = new Date("2026-02-09T20:00:00Z");

    test("returns 'just now' for < 60 seconds", () => {
        const date = new Date(now.getTime() - 30 * 1000);
        assert.equal(getRelativeTime(date, now), "just now");
    });

    test("returns minutes for < 1 hour", () => {
        const date = new Date(now.getTime() - 45 * 60 * 1000);
        assert.equal(getRelativeTime(date, now), "45m ago");
    });

    test("returns hours for < 1 day", () => {
        const date = new Date(now.getTime() - 5 * 3600 * 1000);
        assert.equal(getRelativeTime(date, now), "5h ago");
    });

    test("returns days for < 1 week", () => {
        const date = new Date(now.getTime() - 3 * 86400 * 1000);
        assert.equal(getRelativeTime(date, now), "3d ago");
    });

    test("returns locale date for >= 1 week", () => {
        const date = new Date(now.getTime() - 14 * 86400 * 1000);
        const result = getRelativeTime(date, now);
        // Should be a date string, not relative
        assert.ok(!result.includes("ago"), `Expected date format, got: ${result}`);
    });

    test("returns empty string for invalid date", () => {
        assert.equal(getRelativeTime(new Date("invalid"), now), "");
        assert.equal(getRelativeTime(null, now), "");
    });
});

// ─── extractImageUrl ───

describe("extractImageUrl", () => {
    test("extracts media:thumbnail URL", () => {
        const block = '<media:thumbnail url="https://img.com/thumb.jpg" width="140"/>';
        assert.equal(extractImageUrl(block, ""), "https://img.com/thumb.jpg");
    });

    test("extracts media:content with image type", () => {
        const block = '<media:content url="https://img.com/photo.png" type="image/png" />';
        assert.equal(extractImageUrl(block, ""), "https://img.com/photo.png");
    });

    test("extracts media:content without type", () => {
        const block = '<media:content url="https://img.com/media.jpg" medium="image" />';
        assert.equal(extractImageUrl(block, ""), "https://img.com/media.jpg");
    });

    test("extracts enclosure with image type", () => {
        const block = '<enclosure type="image/jpeg" url="https://img.com/enc.jpg" length="12345" />';
        assert.equal(extractImageUrl(block, ""), "https://img.com/enc.jpg");
    });

    test("extracts enclosure with url before type", () => {
        const block = '<enclosure url="https://img.com/enc2.jpg" type="image/png" />';
        assert.equal(extractImageUrl(block, ""), "https://img.com/enc2.jpg");
    });

    test("extracts img from HTML content", () => {
        const content = '&lt;img src=&quot;https://img.com/inline.jpg&quot; /&gt;';
        assert.equal(extractImageUrl("", content), "https://img.com/inline.jpg");
    });

    test("decodes &amp; in URLs (Guardian style)", () => {
        const block = '<media:content url="https://img.com/photo.jpg?w=140&amp;q=85&amp;fmt=auto" />';
        assert.equal(extractImageUrl(block, ""), "https://img.com/photo.jpg?w=140&q=85&fmt=auto");
    });

    test("prefers media:thumbnail over media:content", () => {
        const block = [
            '<media:thumbnail url="https://img.com/thumb.jpg"/>',
            '<media:content url="https://img.com/full.jpg" type="image/jpeg"/>'
        ].join("");
        assert.equal(extractImageUrl(block, ""), "https://img.com/thumb.jpg");
    });

    test("returns empty string when no image found", () => {
        assert.equal(extractImageUrl("<title>No image here</title>", "Just text"), "");
    });

    test("drops a file: URL found via media:thumbnail (SECURITY)", () => {
        const block = '<media:thumbnail url="file:///etc/passwd"/>';
        assert.equal(extractImageUrl(block, ""), "");
    });

    test("drops a javascript: URL found via inline <img> src (SECURITY)", () => {
        const content = '&lt;img src=&quot;javascript:alert(1)&quot; /&gt;';
        assert.equal(extractImageUrl("", content), "");
    });
});

// ─── isSafeUrl ───

describe("isSafeUrl", () => {
    test("accepts plain https URL", () => {
        assert.equal(isSafeUrl("https://ok.example/x"), true);
    });

    test("accepts plain http URL", () => {
        assert.equal(isSafeUrl("http://ok.example/x"), true);
    });

    test("accepts uppercase scheme", () => {
        assert.equal(isSafeUrl("HTTPS://ok.example/x"), true);
        assert.equal(isSafeUrl("HTTP://ok.example/x"), true);
    });

    test("accepts URL with surrounding whitespace after trimming", () => {
        assert.equal(isSafeUrl("  https://ok.example/x  \n"), true);
    });

    test("rejects file: scheme", () => {
        assert.equal(isSafeUrl("file:///etc/passwd"), false);
    });

    test("rejects javascript: scheme", () => {
        assert.equal(isSafeUrl("javascript:alert(1)"), false);
    });

    test("rejects mixed-case javascript: scheme", () => {
        assert.equal(isSafeUrl("JaVaScRiPt:alert(1)"), false);
    });

    test("rejects javascript: with leading whitespace/newline", () => {
        assert.equal(isSafeUrl("  javascript:alert(1)"), false);
        assert.equal(isSafeUrl("\njavascript:alert(1)"), false);
    });

    test("rejects data: scheme", () => {
        assert.equal(isSafeUrl("data:text/html,x"), false);
    });

    test("rejects qrc: scheme", () => {
        assert.equal(isSafeUrl("qrc:/some/resource"), false);
    });

    test("rejects scheme-relative //host form", () => {
        assert.equal(isSafeUrl("//evil.example/x"), false);
    });

    test("rejects empty string", () => {
        assert.equal(isSafeUrl(""), false);
    });

    test("rejects whitespace-only string", () => {
        assert.equal(isSafeUrl("   "), false);
    });

    test("rejects null and undefined", () => {
        assert.equal(isSafeUrl(null), false);
        assert.equal(isSafeUrl(undefined), false);
    });

    test("rejects non-string input", () => {
        assert.equal(isSafeUrl(123), false);
        assert.equal(isSafeUrl({}), false);
        assert.equal(isSafeUrl([]), false);
    });

    test("rejects a URL containing an embedded tab", () => {
        assert.equal(isSafeUrl("https://ok.example/\tx"), false);
    });

    test("rejects a URL containing an embedded newline", () => {
        assert.equal(isSafeUrl("https://ok.example/\nx"), false);
    });

    test("rejects a URL containing an embedded NUL byte", () => {
        assert.equal(isSafeUrl("https://ok.example/ x"), false);
    });

    test("rejects javascript: hidden via embedded control char split (still fails allowlist)", () => {
        assert.equal(isSafeUrl("java script:alert(1)"), false);
    });

    test("rejects an http URL with a control character even if scheme matches", () => {
        assert.equal(isSafeUrl("https://ok.example/x"), false);
    });
});

// ─── parseRssFeed ───

describe("parseRssFeed", () => {
    const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
    <title>Test Feed</title>
    <item>
        <title>First Article</title>
        <link>https://example.com/1</link>
        <description>This is article one</description>
        <pubDate>Mon, 10 Feb 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
        <title>Second Article</title>
        <link>https://example.com/2</link>
        <description>&lt;p&gt;HTML &amp;amp; entities&lt;/p&gt;</description>
        <pubDate>Mon, 10 Feb 2026 11:00:00 GMT</pubDate>
        <media:thumbnail url="https://img.com/2.jpg"/>
    </item>
    <item>
        <title><![CDATA[CDATA Title <Special>]]></title>
        <link>https://example.com/3</link>
        <description><![CDATA[<b>Bold</b> description]]></description>
        <pubDate>Mon, 10 Feb 2026 10:00:00 GMT</pubDate>
    </item>
</channel>
</rss>`;

    test("parses correct number of items", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.equal(items.length, 3);
    });

    test("extracts titles correctly", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.equal(items[0].title, "First Article");
        assert.equal(items[2].title, "CDATA Title <Special>");
    });

    test("extracts links correctly", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.equal(items[0].link, "https://example.com/1");
    });

    test("decodes &amp; in link", () => {
        const xml = `<rss><channel><item>
            <title>T</title>
            <link>https://www.bbc.co.uk/news/x?at_medium=RSS&amp;at_campaign=rss</link>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "BBC", "");
        assert.equal(items[0].link, "https://www.bbc.co.uk/news/x?at_medium=RSS&at_campaign=rss");
    });

    test("decodes numeric entity in link", () => {
        const xml = `<rss><channel><item>
            <title>T</title>
            <link>https://example.com/caf&#233;</link>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "S", "");
        assert.equal(items[0].link, "https://example.com/café");
    });

    test("strips HTML from descriptions", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.equal(items[0].description, "This is article one");
        assert.equal(items[2].description, "Bold description");
    });

    test("decodes entities in descriptions", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        // Entity-encoded HTML survives stripHtml (which only matches real tags),
        // then cleanText decodes entities, leaving decoded <p> tags intact.
        // This is fine in the widget since QML StyledText renders HTML.
        assert.equal(items[1].description, "<p>HTML &amp; entities</p>");
    });

    test("sets source name on all items", () => {
        const items = parseRssFeed(RSS_SAMPLE, "MySource");
        items.forEach(item => assert.equal(item.source, "MySource"));
    });

    test("sets sourceUrl on all items", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test", "https://example.com/feed.xml");
        items.forEach(item => assert.equal(item.sourceUrl, "https://example.com/feed.xml"));
    });

    test("defaults sourceUrl to empty string when not supplied", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        items.forEach(item => assert.equal(item.sourceUrl, ""));
    });

    test("assigns a non-empty id to every item", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        items.forEach(item => assert.ok(item.id && item.id.length > 0));
    });

    test("extracts timestamps", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.ok(items[0].timestamp > 0);
        assert.ok(items[0].timestamp > items[1].timestamp);
    });

    test("extracts image URLs", () => {
        const items = parseRssFeed(RSS_SAMPLE, "Test");
        assert.equal(items[0].imageUrl, "");
        assert.equal(items[1].imageUrl, "https://img.com/2.jpg");
    });

    test("drops a file: image URL to empty string (SECURITY)", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <media:thumbnail url="file:///etc/passwd"/>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].imageUrl, "");
    });

    test("drops a javascript: image URL to empty string (SECURITY)", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <media:thumbnail url="javascript:alert(1)"/>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].imageUrl, "");
    });

    test("keeps a normal https image URL (SECURITY control)", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <media:thumbnail url="https://img.com/ok.jpg"/>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].imageUrl, "https://img.com/ok.jpg");
    });

    test("skips items with no title and no link", () => {
        const xml = "<rss><channel><item><description>orphan</description></item></channel></rss>";
        assert.equal(parseRssFeed(xml, "Test").length, 0);
    });

    test("handles empty feed", () => {
        assert.deepEqual(parseRssFeed("<rss><channel></channel></rss>", "Test"), []);
    });
});

// ─── parseAtomFeed ───

describe("parseAtomFeed", () => {
    const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
    <title>Atom Feed</title>
    <entry>
        <title>Atom Entry 1</title>
        <link rel="alternate" href="https://example.com/atom/1"/>
        <link href="https://example.com/atom/1/self"/>
        <summary>Summary of entry 1</summary>
        <updated>2026-02-10T12:00:00Z</updated>
        <media:thumbnail url="https://img.com/atom1.jpg"/>
    </entry>
    <entry>
        <title>Atom Entry 2</title>
        <link href="https://example.com/atom/2"/>
        <content type="html">&lt;p&gt;Content of entry 2&lt;/p&gt;</content>
        <published>2026-02-10T11:00:00Z</published>
    </entry>
</feed>`;

    test("parses correct number of entries", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.equal(items.length, 2);
    });

    test("prefers alternate link", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.equal(items[0].link, "https://example.com/atom/1");
    });

    test("falls back to first link when no alternate", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.equal(items[1].link, "https://example.com/atom/2");
    });

    test("decodes &amp; in atom link href", () => {
        const xml = `<feed><entry>
            <title>T</title>
            <link rel="alternate" href="https://example.com/a?x=1&amp;y=2"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Example", "");
        assert.equal(items[0].link, "https://example.com/a?x=1&y=2");
    });

    test("uses summary or content for description", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.equal(items[0].description, "Summary of entry 1");
        // Entity-encoded <p> tags survive stripHtml then get decoded by cleanText
        assert.equal(items[1].description, "<p>Content of entry 2</p>");
    });

    test("uses updated or published for timestamp", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.ok(items[0].timestamp > 0);
        assert.ok(items[1].timestamp > 0);
    });

    test("extracts image URL", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        assert.equal(items[0].imageUrl, "https://img.com/atom1.jpg");
        assert.equal(items[1].imageUrl, "");
    });

    test("drops a file: image URL to empty string (SECURITY)", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/1"/>
            <media:thumbnail url="file:///etc/passwd"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "AtomTest");
        assert.equal(items[0].imageUrl, "");
    });

    test("drops a javascript: image URL to empty string (SECURITY)", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/1"/>
            <media:thumbnail url="javascript:alert(1)"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "AtomTest");
        assert.equal(items[0].imageUrl, "");
    });

    test("sets sourceUrl on all entries", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest", "https://example.com/atom.xml");
        items.forEach(item => assert.equal(item.sourceUrl, "https://example.com/atom.xml"));
    });

    test("assigns a non-empty id to every entry", () => {
        const items = parseAtomFeed(ATOM_SAMPLE, "AtomTest");
        items.forEach(item => assert.ok(item.id && item.id.length > 0));
    });
});

// ─── parseFeed (auto-detect) ───

describe("parseFeed", () => {
    test("detects Atom feed", () => {
        const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A</title><link href="http://x.com"/></entry></feed>';
        const items = parseFeed(atom, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "A");
    });

    test("detects RSS feed", () => {
        const rss = '<rss version="2.0"><channel><item><title>B</title><link>http://y.com</link></item></channel></rss>';
        const items = parseFeed(rss, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "B");
    });

    // Regression, reported by @Xn4m3d (#7): routing was a substring test for
    // "<feed" over the whole document, so an RSS feed containing any element
    // whose name merely STARTS with "feed" was handed to the Atom parser and
    // silently yielded zero items. CNBC ships <feed_asset>; FeedBurner ships
    // <feedburner:*>. Both are real, live feeds.
    test("routes an RSS feed containing a <feed_asset> element to the RSS parser", () => {
        const rss = '<?xml version="1.0"?><rss version="2.0"><channel>'
            + '<feed_asset>promo</feed_asset>'
            + '<item><title>CNBC story</title><link>https://cnbc.example/a</link></item>'
            + '</channel></rss>';
        const items = parseFeed(rss, "CNBC");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "CNBC story");
    });

    test("routes an RSS feed using feedburner: namespaced elements to the RSS parser", () => {
        const rss = '<rss version="2.0" xmlns:feedburner="http://rssnamespace.org/feedburner/ext/1.0"><channel>'
            + '<item><title>Burned</title><link>https://fb.example/a</link>'
            + '<feedburner:origLink>https://orig.example/a</feedburner:origLink></item>'
            + '</channel></rss>';
        const items = parseFeed(rss, "FeedBurner");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Burned");
    });

    test("ignores a <feed mentioned in a comment before the root element", () => {
        const rss = '<?xml version="1.0"?><!-- migrated from <feed> --><rss version="2.0"><channel>'
            + '<item><title>Commented</title><link>https://c.example/a</link></item>'
            + '</channel></rss>';
        const items = parseFeed(rss, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Commented");
    });

    test("ignores a <feed> appearing inside item content", () => {
        const rss = '<rss version="2.0"><channel><item><title>Meta</title>'
            + '<link>https://m.example/a</link>'
            + '<description><![CDATA[How to write a <feed> document]]></description>'
            + '</item></channel></rss>';
        const items = parseFeed(rss, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Meta");
    });

    test("detects Atom behind an XML declaration and a comment", () => {
        const atom = '<?xml version="1.0" encoding="UTF-8"?><!-- generated -->'
            + '<feed xmlns="http://www.w3.org/2005/Atom">'
            + '<entry><title>Declared</title><link href="https://a.example/1"/></entry>'
            + '</feed>';
        const items = parseFeed(atom, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Declared");
    });

    // A fully prefixed Atom document (<atom:feed><atom:entry><atom:title>...)
    // used to route correctly and then parse to zero items, because every
    // regex in parseAtomFeed matches unprefixed tags only.
    test("parses a fully prefixed Atom document", () => {
        const atom = '<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom">'
            + '<atom:entry><atom:title>Prefixed</atom:title>'
            + '<atom:link rel="alternate" href="https://p.example/1"/>'
            + '<atom:updated>2026-09-07T00:00:00Z</atom:updated></atom:entry>'
            + '<atom:entry><atom:title>Second</atom:title>'
            + '<atom:link href="https://p.example/2"/></atom:entry>'
            + '</atom:feed>';
        const items = parseFeed(atom, "Test");
        assert.equal(items.length, 2);
        assert.deepEqual(items.map(i => i.title), ["Prefixed", "Second"]);
        assert.equal(items[0].link, "https://p.example/1");
        assert.equal(items[0].dateStr, "2026-09-07T00:00:00Z");
    });

    test("prefixed Atom entries still get distinct non-empty ids", () => {
        const atom = '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">'
            + '<atom:entry><atom:id>urn:a</atom:id><atom:title>A</atom:title>'
            + '<atom:link href="https://p.example/a"/></atom:entry>'
            + '<atom:entry><atom:id>urn:b</atom:id><atom:title>B</atom:title>'
            + '<atom:link href="https://p.example/b"/></atom:entry>'
            + '</atom:feed>';
        const items = parseFeed(atom, "Test");
        assert.equal(items.length, 2);
        assert.ok(items[0].id && items[1].id);
        assert.notEqual(items[0].id, items[1].id);
    });

    test("an unrelated namespace on a prefixed Atom feed is left intact", () => {
        const atom = '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" '
            + 'xmlns:media="http://search.yahoo.com/mrss/">'
            + '<atom:entry><atom:title>Pic</atom:title>'
            + '<atom:link href="https://p.example/1"/>'
            + '<media:thumbnail url="https://img.example/t.jpg"/></atom:entry>'
            + '</atom:feed>';
        const items = parseFeed(atom, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].imageUrl, "https://img.example/t.jpg");
    });

    test("routes RSS 1.0 (<rdf:RDF> root) to the RSS parser", () => {
        const rdf = '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            + '<item><title>RDF item</title><link>https://r.example/a</link></item>'
            + '</rdf:RDF>';
        const items = parseFeed(rdf, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "RDF item");
    });

    test("falls back to the container element when the root is unrecognised", () => {
        const wrapped = '<payload><entry><title>Wrapped</title><link href="https://w.example/1"/></entry></payload>';
        const items = parseFeed(wrapped, "Test");
        assert.equal(items.length, 1);
        assert.equal(items[0].title, "Wrapped");
    });

    test("returns an empty list rather than throwing on junk input", () => {
        assert.deepEqual(parseFeed("", "Test"), []);
        assert.deepEqual(parseFeed("not xml at all", "Test"), []);
    });
});

// ─── rootElementName ───

describe("rootElementName", () => {
    test("returns the root tag name", () => {
        assert.equal(rootElementName('<rss version="2.0"><channel/></rss>'), "rss");
    });

    test("strips a namespace prefix and lowercases", () => {
        assert.equal(rootElementName('<rdf:RDF xmlns:rdf="x"/>'), "rdf");
        assert.equal(rootElementName('<atom:Feed/>'), "feed");
    });

    test("skips the XML declaration, comments and DOCTYPE", () => {
        assert.equal(
            rootElementName('<?xml version="1.0"?><!DOCTYPE rss><!-- <feed> --><rss/>'),
            "rss"
        );
    });

    test("returns empty string when there is no element", () => {
        assert.equal(rootElementName(""), "");
        assert.equal(rootElementName("plain text"), "");
        assert.equal(rootElementName(null), "");
        assert.equal(rootElementName("<!-- unterminated"), "");
    });
});

// ─── rootElementPrefix / stripNamespacePrefix ───

describe("rootElementPrefix", () => {
    test("returns the root prefix, lowercased", () => {
        assert.equal(rootElementPrefix('<atom:feed xmlns:atom="x"/>'), "atom");
        assert.equal(rootElementPrefix('<A10:feed/>'), "a10");
    });

    test("returns empty string for an unprefixed or missing root", () => {
        assert.equal(rootElementPrefix('<feed xmlns="x"/>'), "");
        assert.equal(rootElementPrefix(""), "");
    });
});

describe("stripNamespacePrefix", () => {
    test("strips opening and closing tags of the named prefix only", () => {
        assert.equal(
            stripNamespacePrefix("<atom:entry><media:thumbnail/></atom:entry>", "atom"),
            "<entry><media:thumbnail/></entry>"
        );
    });

    test("leaves xmlns attributes alone", () => {
        assert.equal(
            stripNamespacePrefix('<atom:feed xmlns:atom="http://x"/>', "atom"),
            '<feed xmlns:atom="http://x"/>'
        );
    });

    test("is a no-op without a prefix", () => {
        assert.equal(stripNamespacePrefix("<entry/>", ""), "<entry/>");
        assert.equal(stripNamespacePrefix("", "atom"), "");
    });
});

// ─── parseOpml ───

describe("parseOpml", () => {
    const OPML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
    <head><title>My Feeds</title></head>
    <body>
        <outline text="Tech" title="Tech">
            <outline type="rss" text="Ars Technica" title="Ars Technica" xmlUrl="https://feeds.arstechnica.com/arstechnica/index" htmlUrl="https://arstechnica.com"/>
            <outline type="rss" text="Hacker News" xmlUrl="https://hnrss.org/newest"/>
        </outline>
        <outline type="rss" text="BBC World" xmlUrl="https://feeds.bbci.co.uk/news/world/rss.xml"/>
        <outline type="rss" text="Entities &amp; Stuff" xmlUrl="https://example.com/feed?a=1&amp;b=2"/>
    </body>
</opml>`;

    test("parses correct number of feeds", () => {
        const feeds = parseOpml(OPML_SAMPLE);
        assert.equal(feeds.length, 4);
    });

    test("extracts feed names", () => {
        const feeds = parseOpml(OPML_SAMPLE);
        assert.equal(feeds[0].name, "Ars Technica");
        assert.equal(feeds[1].name, "Hacker News");
        assert.equal(feeds[2].name, "BBC World");
    });

    test("extracts feed URLs", () => {
        const feeds = parseOpml(OPML_SAMPLE);
        assert.equal(feeds[0].url, "https://feeds.arstechnica.com/arstechnica/index");
        assert.equal(feeds[2].url, "https://feeds.bbci.co.uk/news/world/rss.xml");
    });

    test("decodes &amp; in URLs", () => {
        const feeds = parseOpml(OPML_SAMPLE);
        assert.equal(feeds[3].url, "https://example.com/feed?a=1&b=2");
    });

    test("decodes &amp; in names", () => {
        const feeds = parseOpml(OPML_SAMPLE);
        assert.equal(feeds[3].name, "Entities & Stuff");
    });

    test("handles empty OPML", () => {
        assert.deepEqual(parseOpml("<opml><body></body></opml>"), []);
    });

    test("ignores outlines without xmlUrl", () => {
        const xml = '<opml><body><outline text="Category"><outline text="No URL"/></outline></body></opml>';
        assert.deepEqual(parseOpml(xml), []);
    });

    test("tolerates xmlUrl appearing before title/text", () => {
        const xml = '<opml><body><outline xmlUrl="https://example.com/a" title="A Feed" text="A"/></body></opml>';
        const feeds = parseOpml(xml);
        assert.equal(feeds.length, 1);
        assert.equal(feeds[0].url, "https://example.com/a");
        assert.equal(feeds[0].name, "A Feed");
    });

    test("tolerates xmlUrl appearing after title/text (reversed order)", () => {
        const xml = '<outline text="A" title="A Feed" xmlUrl="https://example.com/a"/>';
        const feeds = parseOpml(`<opml><body>${xml}</body></opml>`);
        assert.equal(feeds.length, 1);
        assert.equal(feeds[0].url, "https://example.com/a");
        assert.equal(feeds[0].name, "A Feed");
    });

    test("prefers title over text when both exist, regardless of order", () => {
        const xmlTitleFirst = '<outline title="Title Wins" text="Text Loses" xmlUrl="https://example.com/x"/>';
        const xmlTextFirst = '<outline text="Text Loses" title="Title Wins" xmlUrl="https://example.com/x"/>';
        assert.equal(parseOpml(`<opml><body>${xmlTitleFirst}</body></opml>`)[0].name, "Title Wins");
        assert.equal(parseOpml(`<opml><body>${xmlTextFirst}</body></opml>`)[0].name, "Title Wins");
    });

    test("handles duplicate outlines (does not dedupe on its own)", () => {
        const xml = `<opml><body>
            <outline text="Dup" xmlUrl="https://example.com/dup"/>
            <outline text="Dup" xmlUrl="https://example.com/dup"/>
        </body></opml>`;
        const feeds = parseOpml(xml);
        assert.equal(feeds.length, 2);
        assert.equal(feeds[0].url, feeds[1].url);
    });
});

// ─── makeItemId ───

describe("makeItemId", () => {
    test("prefers rawId (guid/atom id) with g: prefix", () => {
        assert.equal(
            makeItemId("abc-123", "https://x.com/1", "Src", "Title", "date"),
            "g:abc-123"
        );
    });

    test("trims rawId before prefixing", () => {
        assert.equal(
            makeItemId("  abc-123  ", "https://x.com/1", "Src", "Title", "date"),
            "g:abc-123"
        );
    });

    test("falls back to link with l: prefix when rawId is empty", () => {
        assert.equal(
            makeItemId("", "https://x.com/1", "Src", "Title", "date"),
            "l:https://x.com/1"
        );
    });

    test("falls back to hash with h: prefix when neither rawId nor link exist", () => {
        const id = makeItemId("", "", "Src", "Title", "date");
        assert.ok(id.indexOf("h:") === 0);
    });

    test("hash fallback is deterministic across calls", () => {
        const id1 = makeItemId("", "", "Src", "Same Title", "2026-01-01");
        const id2 = makeItemId("", "", "Src", "Same Title", "2026-01-01");
        assert.equal(id1, id2);
    });

    test("hash fallback differs for different titles", () => {
        const id1 = makeItemId("", "", "Src", "Title A", "2026-01-01");
        const id2 = makeItemId("", "", "Src", "Title B", "2026-01-01");
        assert.notEqual(id1, id2);
    });

    test("hash fallback is stable across process runs (no Date.now/Math.random)", () => {
        // Same call twice in the same run must produce identical output;
        // this is a proxy for "no time- or randomness-based inputs".
        const a = makeItemId(null, null, "Src", "T", "D");
        const b = makeItemId(null, null, "Src", "T", "D");
        assert.equal(a, b);
    });
});

// ─── id extraction integration (RSS/Atom) ───

describe("id extraction — RSS <guid>", () => {
    test("uses guid as id", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <guid>unique-guid-1</guid>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].id, "g:unique-guid-1");
    });

    test("uses guid as id when isPermaLink=false", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <guid isPermaLink="false">tag:example.com,2026:1</guid>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].id, "g:tag:example.com,2026:1");
    });

    test("uses guid as id when isPermaLink attribute is absent", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <guid>https://x.com/1</guid>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].id, "g:https://x.com/1");
    });

    test("uses guid wrapped in CDATA as id", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <guid><![CDATA[cdata-guid-1]]></guid>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].id, "g:cdata-guid-1");
    });

    test("falls back to link when no guid present", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/no-guid</link>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].id, "l:https://x.com/no-guid");
    });

    test("supports <dc:date> as a date fallback after pubDate", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <dc:date>2026-02-10T12:00:00Z</dc:date>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].dateStr, "2026-02-10T12:00:00Z");
        assert.ok(items[0].timestamp > 0);
    });

    test("pubDate takes priority over dc:date when both exist", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <pubDate>Mon, 10 Feb 2026 12:00:00 GMT</pubDate>
            <dc:date>2020-01-01T00:00:00Z</dc:date>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].dateStr, "Mon, 10 Feb 2026 12:00:00 GMT");
    });

    test("malformed/missing date yields timestamp 0 without throwing", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
            <pubDate>not a real date</pubDate>
        </item></channel></rss>`;
        assert.doesNotThrow(() => {
            const items = parseRssFeed(xml, "Test");
            assert.equal(items[0].timestamp, 0);
        });
    });

    test("missing date entirely yields timestamp 0", () => {
        const xml = `<rss><channel><item>
            <title>T</title><link>https://x.com/1</link>
        </item></channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        assert.equal(items[0].timestamp, 0);
    });
});

describe("id extraction — Atom <id>", () => {
    test("uses atom id as item id", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <id>urn:uuid:1234</id>
            <link href="https://x.com/1"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].id, "g:urn:uuid:1234");
    });

    test("falls back to link when atom id is absent", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/1"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].id, "l:https://x.com/1");
    });

    test("malformed date yields timestamp 0 without throwing", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/1"/>
            <updated>not-a-date</updated>
        </entry></feed>`;
        assert.doesNotThrow(() => {
            const items = parseAtomFeed(xml, "Test");
            assert.equal(items[0].timestamp, 0);
        });
    });
});

describe("Atom alternate-link selection is attribute-order independent", () => {
    test("rel before href resolves to alternate", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link rel="alternate" href="https://x.com/alt"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/alt");
    });

    test("href before rel also resolves to alternate", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/alt" rel="alternate"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/alt");
    });

    test("link with no rel attribute at all counts as alternate", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link href="https://x.com/no-rel"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/no-rel");
    });

    test("rel=self appearing first is skipped in favor of a later alternate", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link rel="self" href="https://x.com/self"/>
            <link href="https://x.com/real" rel="alternate"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/real");
    });

    test("rel=enclosure is not chosen when an alternate exists", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link rel="enclosure" href="https://x.com/media.mp3"/>
            <link rel="alternate" href="https://x.com/real"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/real");
    });

    test("no alternate present falls back to the first link seen", () => {
        const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>T</title>
            <link rel="self" href="https://x.com/self"/>
            <link rel="enclosure" href="https://x.com/media.mp3"/>
        </entry></feed>`;
        const items = parseAtomFeed(xml, "Test");
        assert.equal(items[0].link, "https://x.com/self");
    });
});

// ─── extractImageUrl: enclosure attribute order ───

describe("extractImageUrl — enclosure attribute order reversed", () => {
    test("extracts enclosure image with type before url (already covered) and url before type", () => {
        const reversed = '<enclosure length="99" url="https://img.com/rev.jpg" type="image/gif" />';
        assert.equal(extractImageUrl(reversed, ""), "https://img.com/rev.jpg");
    });
});

// ─── dedupeItems ───

describe("dedupeItems", () => {
    test("removes items with duplicate ids, keeping the first occurrence", () => {
        const items = [
            { id: "g:1", title: "First" },
            { id: "g:2", title: "Second" },
            { id: "g:1", title: "Duplicate of first" }
        ];
        const result = dedupeItems(items);
        assert.equal(result.length, 2);
        assert.equal(result[0].title, "First");
        assert.equal(result[1].title, "Second");
    });

    test("returns empty array for empty input", () => {
        assert.deepEqual(dedupeItems([]), []);
    });

    test("preserves order of first occurrences", () => {
        const items = [
            { id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }, { id: "b" }
        ];
        const result = dedupeItems(items).map(i => i.id);
        assert.deepEqual(result, ["a", "b", "c"]);
    });

    test("integrates with parseRssFeed to remove repeated entries", () => {
        const xml = `<rss><channel>
            <item><title>A</title><link>https://x.com/1</link><guid>1</guid></item>
            <item><title>A again</title><link>https://x.com/1</link><guid>1</guid></item>
        </channel></rss>`;
        const items = parseRssFeed(xml, "Test");
        const deduped = dedupeItems(items);
        assert.equal(items.length, 2);
        assert.equal(deduped.length, 1);
        assert.equal(deduped[0].title, "A");
    });
});

// ─── parseMinifluxEntries ───

describe("parseMinifluxEntries", () => {
    test("parses a well-formed entries object into 'm:'-prefixed ids", () => {
        const json = { entries: [{ id: 42, title: "Hello", url: "https://x.com/1" }] };
        const result = parseMinifluxEntries(json, "https://miniflux.example.com");
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].id, "m:42");
    });

    test("id collision safety vs makeItemId output for the same numeric-looking id", () => {
        const result = parseMinifluxEntries({ entries: [{ id: 42, title: "T", url: "https://x.com" }] }, "");
        assert.notEqual(result.items[0].id, makeItemId("42", "", "src", "t", ""));
    });

    test("maps title/link/description; content preferred over summary; HTML stripped", () => {
        const json = {
            entries: [{
                id: 1,
                title: "  My Title  ",
                url: "https://x.com/a",
                content: "<p>Content <b>wins</b></p>",
                summary: "Summary text"
            }]
        };
        const result = parseMinifluxEntries(json, "");
        const item = result.items[0];
        assert.equal(item.title, "My Title");
        assert.equal(item.link, "https://x.com/a");
        assert.equal(item.description, "Content wins");
    });

    test("falls back to summary when content is absent", () => {
        const json = { entries: [{ id: 1, title: "T", url: "https://x.com", summary: "Only summary" }] };
        const result = parseMinifluxEntries(json, "");
        assert.equal(result.items[0].description, "Only summary");
    });

    test("timestamp/dateStr from published_at; unparseable date yields timestamp 0", () => {
        const good = parseMinifluxEntries({ entries: [{ id: 1, published_at: "2026-01-01T00:00:00Z" }] }, "");
        assert.ok(good.items[0].timestamp > 0);
        assert.equal(good.items[0].dateStr, "2026-01-01T00:00:00Z");

        const bad = parseMinifluxEntries({ entries: [{ id: 2, published_at: "not-a-date" }] }, "");
        assert.equal(bad.items[0].timestamp, 0);
        assert.equal(bad.items[0].dateStr, "not-a-date");
    });

    test("source from entry.feed.title; missing entry.feed yields empty source", () => {
        const withFeed = parseMinifluxEntries({ entries: [{ id: 1, feed: { title: "My Feed" } }] }, "");
        assert.equal(withFeed.items[0].source, "My Feed");

        const withoutFeed = parseMinifluxEntries({ entries: [{ id: 2 }] }, "");
        assert.equal(withoutFeed.items[0].source, "");
    });

    test("sourceUrl falls back to defaultSourceUrl", () => {
        const result = parseMinifluxEntries({ entries: [{ id: 1 }] }, "https://miniflux.example.com");
        assert.equal(result.items[0].sourceUrl, "https://miniflux.example.com");
    });

    test("imageUrl: image/* enclosure wins over inline <img> in content", () => {
        const json = {
            entries: [{
                id: 1,
                content: '<img src="https://x.com/inline.jpg">',
                enclosures: [{ url: "https://x.com/enclosure.jpg", mime_type: "image/jpeg" }]
            }]
        };
        const result = parseMinifluxEntries(json, "");
        assert.equal(result.items[0].imageUrl, "https://x.com/enclosure.jpg");
    });

    test("imageUrl: no enclosure falls back to inline <img>", () => {
        const json = { entries: [{ id: 1, content: '<img src="https://x.com/inline.jpg">' }] };
        const result = parseMinifluxEntries(json, "");
        assert.equal(result.items[0].imageUrl, "https://x.com/inline.jpg");
    });

    test("imageUrl: neither enclosure nor inline image yields empty string", () => {
        const result = parseMinifluxEntries({ entries: [{ id: 1, content: "plain text" }] }, "");
        assert.equal(result.items[0].imageUrl, "");
    });

    test("imageUrl safety: javascript:/data: enclosure or <img> is rejected", () => {
        const jsEnclosure = parseMinifluxEntries({
            entries: [{ id: 1, enclosures: [{ url: "javascript:alert(1)", mime_type: "image/jpeg" }] }]
        }, "");
        assert.equal(jsEnclosure.items[0].imageUrl, "");

        const dataImg = parseMinifluxEntries({
            entries: [{ id: 2, content: '<img src="data:image/png;base64,xxx">' }]
        }, "");
        assert.equal(dataImg.items[0].imageUrl, "");
    });

    test("malformed input returns the empty shape without throwing", () => {
        assert.deepEqual(parseMinifluxEntries(null, ""), { items: [], serverStatus: [] });
        assert.deepEqual(parseMinifluxEntries({}, ""), { items: [], serverStatus: [] });
        assert.deepEqual(parseMinifluxEntries({ entries: null }, ""), { items: [], serverStatus: [] });
    });

    test("an entry missing id is skipped; other valid entries still parse", () => {
        const json = { entries: [{ title: "No id" }, { id: 5, title: "Has id" }] };
        const result = parseMinifluxEntries(json, "");
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].id, "m:5");
    });

    test("serverStatus carries status and starred per entry independent of items", () => {
        const json = {
            entries: [
                { id: 1, status: "read", starred: true },
                { id: 2, status: "unread", starred: false }
            ]
        };
        const result = parseMinifluxEntries(json, "");
        assert.deepEqual(result.serverStatus, [
            { id: "m:1", status: "read", starred: true },
            { id: "m:2", status: "unread", starred: false }
        ]);
    });
});
