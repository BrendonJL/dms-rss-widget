const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
    extractTag,
    cleanText,
    stripHtml,
    getRelativeTime,
    extractImageUrl,
    parseRssFeed,
    parseAtomFeed,
    parseFeed,
    parseOpml
} = require("./feed-parser");

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
});
