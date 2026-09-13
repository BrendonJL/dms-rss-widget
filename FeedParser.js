// Single source of truth for feed parsing logic.
// Consumed by BOTH QML (`import "FeedParser.js" as FeedParser`) and Node (`require`).
//
// IMPORTANT: no `.pragma library` line here — it is invalid JavaScript and
// breaks Node's require(). Keep this file pure ES5/basic-ES6: no QML
// globals, no Qt APIs, no I/O, no Date.now() inside ID generation.

function extractTag(xml, tagName) {
    var regex = new RegExp("<" + tagName + "[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/" + tagName + ">", "i");
    var match = xml.match(regex);
    if (match) {
        return (match[1] !== undefined ? match[1] : match[2]) || "";
    }
    return "";
}

function cleanText(text) {
    if (!text) return "";
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#x([0-9a-fA-F]+);/g, function(m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
    text = text.replace(/&#(\d+);/g, function(m, dec) {
        return String.fromCharCode(parseInt(dec, 10));
    });
    text = text.replace(/\s+/g, " ").trim();
    return text;
}

function stripHtml(text) {
    if (!text) return "";
    return text.replace(/<[^>]+>/g, "");
}

// Feed descriptions arrive as markup in two different shapes, sometimes both in
// the same document: real tags (<p>foo</p>) and entity-encoded tags
// (&lt;p&gt;foo&lt;/p&gt;). The obvious composition, cleanText(stripHtml(raw)),
// only handles the first: it strips tags, THEN decodes entities, so the decode
// step creates tags the stripper has already walked past and they render as
// literal "<p>" text in the widget. Verified against the live Guardian feed:
// 137 of 137 descriptions leaked markup this way.
//
// Strip, decode, strip again. The second pass catches whatever the decode
// produced, and a double-encoded description resolves to plain text instead of
// showing "&lt;p&gt;".
// Block-level tags are a WORD BOUNDARY. Deleting them outright welds the text
// on either side into one word -- "...across the country</p><p>Far-right AfD..."
// renders as "the countryFar-right" -- so these become a space, while inline
// tags (<b>, <a>, <em>) are deleted so "un<b>der</b>" stays "under".
function separateBlocks(text) {
    if (!text) return "";
    return text.replace(/<\/?(p|div|br|hr|li|ul|ol|dl|dd|dt|h[1-6]|blockquote|pre|section|article|table|tr|td|th)\b[^>]*>/gi, " ");
}

function htmlToText(raw) {
    if (!raw) return "";
    var text = cleanText(stripHtml(separateBlocks(raw)));
    return cleanText(stripHtml(separateBlocks(text)));
}

function getRelativeTime(date, now) {
    if (!date || isNaN(date.getTime())) return "";
    now = now || new Date();
    var diff = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    if (diff < 604800) return Math.floor(diff / 86400) + "d ago";
    return date.toLocaleDateString();
}

// SECURITY: positive allowlist for URLs that are safe to hand to
// Qt.openUrlExternally or load into a QML Image. Only http(s) survives.
// This is deliberately an allowlist (not a blocklist of known-bad schemes)
// so novel bypass schemes fail closed rather than open.
//
// Rejects:
//   - non-strings / empty / whitespace-only
//   - any control character (0x00-0x1F, 0x7F) anywhere in the trimmed value
//   - any embedded whitespace (space, tab, newline, ...) anywhere in the value
//   - anything not matching ^https?:// (case-insensitive) after trimming --
//     this covers javascript:, data:, file:, qrc:, and scheme-relative
//     "//host" forms, including mixed-case bypass attempts.
function isSafeUrl(url) {
    if (typeof url !== "string") return false;

    var trimmed = url.trim();
    if (trimmed === "") return false;

    for (var i = 0; i < trimmed.length; i++) {
        var code = trimmed.charCodeAt(i);
        if (code <= 0x1F || code === 0x7F) return false;
    }

    if (/\s/.test(trimmed)) return false;

    return /^https?:\/\//i.test(trimmed);
}

// The audio enclosure, if a feed carries one -- podcasts almost always do.
//
// Deliberately audio only. A feed may enclose a PDF, a torrent or a video, and
// handing an arbitrary enclosure to a media player is how "play this episode"
// becomes "open whatever the feed felt like attaching". The same isSafeUrl
// gate every other URL in this file passes applies here too, for the same
// reason: a malicious feed must not be able to point this at file: or data:.
//
// Returns "" when there is nothing playable, so the caller's check is a plain
// truthiness test and the field is absent-shaped rather than null-shaped,
// matching imageUrl beside it.
function extractAudioUrl(block) {
    if (!block)
        return "";

    var patterns = [
        /<enclosure[^>]*type=["']audio\/[^"']*["'][^>]*url=["']([^"']+)["']/i,
        /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']audio\//i
    ];
    for (var i = 0; i < patterns.length; i++) {
        var m = block.match(patterns[i]);
        if (m && m[1] && isSafeUrl(m[1]))
            return cleanText(m[1]);
    }
    return "";
}

// Miniflux hands us entry.enclosures directly rather than raw XML, so the
// regex path above never sees it -- same split as minifluxEntryImage.
function minifluxEntryAudio(entry) {
    var enclosures = (entry && entry.enclosures) || [];
    for (var k = 0; k < enclosures.length; k++) {
        var enc = enclosures[k];
        if (!enc || !enc.url)
            continue;
        var mime = enc.mime_type || "";
        if (mime.indexOf("audio/") === 0 && isSafeUrl(enc.url))
            return enc.url;
    }
    return "";
}

function extractImageUrl(block, content) {
    var url = "";

    var m = block.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
    if (m) { url = m[1]; }

    if (!url) {
        m = block.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
        if (m) url = m[1];
    }

    if (!url) {
        m = block.match(/<media:content[^>]*url=["']([^"']+)["']/i);
        if (m) url = m[1];
    }

    if (!url) {
        m = block.match(/<enclosure[^>]*type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i);
        if (m) url = m[1];
    }
    if (!url) {
        m = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i);
        if (m) url = m[1];
    }

    if (!url) {
        var decoded = content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        m = decoded.match(/<img[^>]*src=["']([^"']+)["']/i);
        if (m) url = m[1];
    }

    if (url) {
        url = url.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    }

    // SECURITY: never hand back a URL with an unsafe scheme (e.g. a
    // malicious feed pointing an <img>/enclosure at javascript:/file:/data:).
    // Downstream (QML Image) would otherwise attempt to load it.
    if (url && !isSafeUrl(url)) return "";

    return url;
}

// Deterministic unsigned 32-bit djb2 hash, returned as base36.
// Pure function of the input string — no Date.now(), no Math.random().
function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
        hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

// CONTRACT 3 — stable item ID precedence:
//   1. RSS <guid> / Atom <id>, trimmed  -> "g:" + value
//   2. canonical link, trimmed          -> "l:" + value
//   3. deterministic fallback           -> "h:" + hash(source + " " + title + " " + dateStr)
function makeItemId(rawId, link, source, title, dateStr) {
    var id = rawId ? String(rawId).trim() : "";
    if (id !== "") return "g:" + id;

    var l = link ? String(link).trim() : "";
    if (l !== "") return "l:" + l;

    var seed = (source || "") + " " + (title || "") + " " + (dateStr || "");
    return "h:" + djb2Hash(seed);
}

function parseRssFeed(xml, sourceName, sourceUrl) {
    var items = [];
    var itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
    var match;

    while ((match = itemRegex.exec(xml)) !== null) {
        var block = match[1];
        var title = extractTag(block, "title");
        var link = extractTag(block, "link");
        var description = extractTag(block, "description");
        var guid = extractTag(block, "guid");
        var pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date");

        if (!title && !link) continue;

        var cleanTitle = cleanText(title || "Untitled");
        var itemLink = link ? cleanText(link) : "";

        items.push({
            id: makeItemId(guid, itemLink, sourceName, cleanTitle, pubDate || ""),
            title: cleanTitle,
            link: itemLink,
            description: htmlToText(description || ""),
            dateStr: pubDate || "",
            timestamp: pubDate ? new Date(pubDate).getTime() || 0 : 0,
            source: sourceName,
            sourceUrl: sourceUrl || "",
            imageUrl: extractImageUrl(block, description || ""),
            audioUrl: extractAudioUrl(block)
        });
    }
    return items;
}

// Picks the Atom "alternate" link regardless of attribute order.
// Per the Atom spec, a <link> with no rel attribute defaults to "alternate".
// rel="self"/"enclosure" (or anything else) must not be chosen when an
// alternate exists elsewhere in the entry.
function pickAtomLink(block) {
    var linkRegex = /<link\b([^>]*)\/?>/gi;
    var linkMatch;
    var firstHref = "";
    var altHref = "";
    var foundAlt = false;

    while ((linkMatch = linkRegex.exec(block)) !== null) {
        var attrs = linkMatch[1];
        var hrefMatch = attrs.match(/href=["']([^"']*)["']/i);
        if (!hrefMatch) continue;
        var href = hrefMatch[1];
        if (!firstHref) firstHref = href;

        var relMatch = attrs.match(/rel=["']([^"']*)["']/i);
        var rel = relMatch ? relMatch[1] : "alternate";

        if (!foundAlt && rel === "alternate") {
            altHref = href;
            foundAlt = true;
        }
    }

    return foundAlt ? altHref : firstHref;
}

// Removes ONE namespace prefix from element tags: "<atom:entry>" -> "<entry>".
// Only the prefix it is asked for is touched, so unrelated namespaces a feed
// carries for extra data (media:, dc:, content:) survive untouched, as do
// attributes -- xmlns:atom="..." is left alone deliberately.
function stripNamespacePrefix(xml, prefix) {
    if (!xml || !prefix)
        return xml;
    var escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return xml.replace(new RegExp("<(/?)" + escaped + ":", "gi"), "<$1");
}

function parseAtomFeed(xml, sourceName, sourceUrl) {
    // An Atom document may put its elements behind a prefix declared on the
    // root (<atom:feed><atom:entry><atom:title>...). Every regex below matches
    // unprefixed tags only, so such a feed parsed to zero items -- the same
    // silent disappearance @Xn4m3d reported in #7 for the RSS misroute, with a
    // different cause. Normalise the root's own prefix away up front rather
    // than making every regex below namespace-aware.
    xml = stripNamespacePrefix(xml, rootElementPrefix(xml));

    var items = [];
    var entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    var match;

    while ((match = entryRegex.exec(xml)) !== null) {
        var block = match[1];
        var title = extractTag(block, "title");
        var summary = extractTag(block, "summary") || extractTag(block, "content");
        var updated = extractTag(block, "updated") || extractTag(block, "published");
        var entryId = extractTag(block, "id");

        var link = cleanText(pickAtomLink(block));

        if (!title && !link) continue;

        var cleanTitle = cleanText(title || "Untitled");

        items.push({
            id: makeItemId(entryId, link, sourceName, cleanTitle, updated || ""),
            title: cleanTitle,
            link: link,
            description: htmlToText(summary || ""),
            dateStr: updated || "",
            timestamp: updated ? new Date(updated).getTime() || 0 : 0,
            source: sourceName,
            sourceUrl: sourceUrl || "",
            imageUrl: extractImageUrl(block, summary || ""),
            audioUrl: extractAudioUrl(block)
        });
    }
    return items;
}

// Returns the tag name of the document's ROOT element, lowercased and with any
// namespace prefix stripped ("rdf:RDF" -> "rdf"), or "" if none can be found.
//
// Reported by @Xn4m3d (#7): routing used to be `xml.indexOf("<feed") !== -1`,
// a substring test over the WHOLE document. Any RSS 2.0 feed carrying an
// element whose name merely starts with "feed" was handed to the Atom parser,
// which then found no <entry> and returned zero items with nothing logged --
// the feed just silently vanished. Real feeds do this: CNBC ships
// <feed_asset>, FeedBurner ships <feedburner:*>. A tighter test like
// /<feed[\s>]/ is still wrong, because a <feed> element can legitimately
// appear inside an RSS <description> or a CDATA block. The format is a
// property of the root element, so that is what we look at.
//
// The scan skips the XML declaration, processing instructions, comments and
// DOCTYPE so that a "<feed" mentioned inside a comment cannot decide the route.
function rootElementName(xml) {
    var raw = rootElementRaw(xml);
    var colon = raw.indexOf(":");
    return (colon === -1 ? raw : raw.substr(colon + 1)).toLowerCase();
}

// The root element's namespace prefix, lowercased ("atom" for <atom:feed>), or
// "" when the root carries no prefix. parseAtomFeed uses this to normalise a
// fully prefixed Atom document before its regexes run.
function rootElementPrefix(xml) {
    var raw = rootElementRaw(xml);
    var colon = raw.indexOf(":");
    return colon === -1 ? "" : raw.substr(0, colon).toLowerCase();
}

// Shared scanner: the root element's tag name exactly as written, prefix
// included, or "" if the document has no element.
function rootElementRaw(xml) {
    if (!xml)
        return "";

    var i = 0;
    while (i < xml.length) {
        var lt = xml.indexOf("<", i);
        if (lt === -1)
            return "";

        var next = xml.charAt(lt + 1);
        if (next === "?") {
            var pi = xml.indexOf("?>", lt + 2);
            if (pi === -1)
                return "";
            i = pi + 2;
        } else if (next === "!") {
            if (xml.substr(lt + 2, 2) === "--") {
                var comment = xml.indexOf("-->", lt + 4);
                if (comment === -1)
                    return "";
                i = comment + 3;
            } else {
                var decl = xml.indexOf(">", lt + 2);
                if (decl === -1)
                    return "";
                i = decl + 1;
            }
        } else {
            var m = /^<([A-Za-z_][A-Za-z0-9_.\-]*(?::[A-Za-z_][A-Za-z0-9_.\-]*)?)/
                .exec(xml.substr(lt, 128));
            if (!m) {
                i = lt + 1;
                continue;
            }
            return m[1];
        }
    }
    return "";
}

function parseFeed(xml, sourceName, sourceUrl) {
    var root = rootElementName(xml);

    if (root === "feed")
        return parseAtomFeed(xml, sourceName, sourceUrl);
    // "rss" is RSS 0.9x/2.0; "rdf" is RSS 1.0, whose root is <rdf:RDF> and
    // whose entries are <item> elements, so the RSS parser handles both.
    if (root === "rss" || root === "rdf")
        return parseRssFeed(xml, sourceName, sourceUrl);

    // Unrecognised or unparseable root (a wrapper element, a truncated
    // download). Rather than guess, route on which container element is
    // actually present; ties and empty documents fall through to RSS, which
    // is what the old code did for everything that wasn't Atom.
    if (/<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml))
        return parseAtomFeed(xml, sourceName, sourceUrl);
    return parseRssFeed(xml, sourceName, sourceUrl);
}

// Removes items sharing the same id, keeping the FIRST occurrence.
function dedupeItems(items) {
    var seen = {};
    var out = [];
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var key = it && it.id !== undefined ? String(it.id) : "";
        if (Object.prototype.hasOwnProperty.call(seen, key)) continue;
        seen[key] = true;
        out.push(it);
    }
    return out;
}

// CONTRACT (v2.4 §4.1): Miniflux entries flow through this function into the
// SAME Item shape RSS/Atom items use, with a distinct id prefix ("m:") so a
// Miniflux id can never collide with makeItemId's "g:"/"l:"/"h:" outputs.
//
// `json` is the ALREADY-JSON.parse'd `GET /v1/entries` response body (an
// object with an `entries` array). `defaultSourceUrl` fills each Item's
// `sourceUrl` (Miniflux entries don't carry the widget's configured server
// URL, only their own per-entry `feed` object).
//
// Return shape deliberately deviates from parseFeed's plain array: reconciling
// server read/starred status into local state (ReaderState.reconcileServerStatus)
// needs that status per entry, and that decision belongs in pure, tested code
// rather than inline QML. Returns { items: Item[], serverStatus: [{id, status, starred}] }.
// Never throws: malformed/missing input yields the empty shape.
function parseMinifluxEntries(json, defaultSourceUrl) {
    var empty = { items: [], serverStatus: [] };

    if (!json || typeof json !== "object")
        return empty;

    var entries = json.entries;
    if (!entries || entries.length === undefined)
        return empty;

    var items = [];
    var serverStatus = [];

    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (!entry || entry.id === undefined || entry.id === null)
            continue;

        var itemId = "m:" + String(entry.id);
        var title = cleanText(entry.title || "");
        var link = entry.url || "";
        var content = entry.content || entry.summary || "";
        var description = cleanText(stripHtml(content));
        var publishedAt = entry.published_at || "";
        var timestamp = publishedAt ? (new Date(publishedAt).getTime() || 0) : 0;
        var source = entry.feed ? (entry.feed.title || "") : "";

        items.push({
            id: itemId,
            title: title,
            link: link,
            description: description,
            dateStr: publishedAt,
            timestamp: timestamp,
            source: source,
            sourceUrl: defaultSourceUrl || "",
            imageUrl: minifluxEntryImage(entry),
            audioUrl: minifluxEntryAudio(entry)
        });

        serverStatus.push({
            id: itemId,
            status: entry.status,
            starred: !!entry.starred
        });
    }

    return { items: items, serverStatus: serverStatus };
}

// Miniflux keeps the thumbnail in `entry.enclosures` (mime_type image/*), not
// inline in content; fall back to an <img> in the content/summary only if
// there's no such enclosure. Ported from PR #6's minifluxEntryImage, now
// living here (pure, testable) instead of duplicated in QML. `block=""` is
// passed to extractImageUrl since there is no XML block to scan for
// media:/enclosure tags -- Miniflux already gives us entry.enclosures directly.
function minifluxEntryImage(entry) {
    var enclosures = entry.enclosures || [];
    for (var k = 0; k < enclosures.length; k++) {
        var enc = enclosures[k];
        var mimeType = (enc && enc.mime_type) || "";
        if (mimeType.indexOf("image/") === 0 && enc.url && isSafeUrl(enc.url))
            return enc.url;
    }
    return extractImageUrl("", entry.content || entry.summary || "");
}

// Decodes the standard XML entities in an already-extracted attribute value.
// &amp; is decoded LAST, matching cleanText's ordering: it must not run
// first, or a literal "&lt;" written by an encoder that escaped "&" before
// "<" would collapse in one step to "<" instead of surviving as text.
// (buildOpml's escapeXmlAttr encodes "&" first for the same reason in
// reverse, so encode/decode are symmetric round-trips of each other.)
function decodeXmlEntities(text) {
    if (!text) return "";
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
    text = text.replace(/&#(\d+);/g, function (m, dec) {
        return String.fromCharCode(parseInt(dec, 10));
    });
    text = text.replace(/&amp;/g, "&");
    return text;
}

// XML-escapes a value for use inside a double-quoted attribute. Order
// matters: "&" must be escaped FIRST, or the "&" introduced by escaping
// "<"/">"/etc would itself get re-escaped into "&amp;lt;" and so on.
function escapeXmlAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// Same escaping, for element text content (<title>...</title>) rather than
// an attribute value -- quotes don't need escaping there, but leaving them
// unescaped is also harmless, so this just reuses escapeXmlAttr.
function escapeXmlText(value) {
    return escapeXmlAttr(value);
}

function parseOpml(xml) {
    var feeds = [];
    var outlineRegex = /<outline[^>]*xmlUrl=["']([^"']+)["'][^>]*>/gi;
    var match;
    while ((match = outlineRegex.exec(xml)) !== null) {
        var fullTag = match[0];
        var url = decodeXmlEntities(match[1]);

        var titleAttr = fullTag.match(/\btitle=["']([^"']*)["']/i);
        var textAttr = fullTag.match(/\btext=["']([^"']*)["']/i);
        var rawName = titleAttr ? titleAttr[1] : (textAttr ? textAttr[1] : url);
        var name = decodeXmlEntities(rawName);

        // Gated here, at the parse boundary, exactly as imageUrl and audioUrl
        // already are. An OPML file is attacker-influenced input like any other
        // feed content, and unlike a hand-typed feed it never passes through
        // validateFeedUrl -- the import path pushes straight into the feed
        // list, and every enabled feed's url then becomes a curl argument on
        // every refresh, unattended. A value shaped like a curl flag has no
        // business getting that far.
        if (!isSafeUrl(url))
            continue;

        feeds.push({ name: name, url: url });
    }
    return feeds;
}

// Inverse of parseOpml: turns the widget's feed array into an OPML 2.0
// document. feeds is [{ name, url, enabled }] -- the same shape
// DankRssWidgetSettings.qml keeps. `enabled` is deliberately ignored: OPML
// is an interchange format for "the feeds I subscribe to", and enabled/
// disabled is local UI state about how THIS widget currently displays them,
// not a property of the feed itself. Exporting only the enabled subset
// would silently drop feeds from a file the user explicitly asked to back
// up or hand to another reader.
//
// options.dateCreated is taken as a plain string/value to embed verbatim
// (e.g. the caller passes `new Date().toUTCString()`), never read from the
// clock in here -- this file does no I/O and nothing time-dependent, so a
// given input always produces the same output, which is what makes the
// round-trip test (and any test at all) deterministic. Omitting it entirely
// when not supplied avoids emitting a fake/misleading date.
function buildOpml(feeds, options) {
    options = options || {};
    var title = (options && options.title) || "Dank RSS Widget Feeds";
    var list = Array.isArray(feeds) ? feeds : [];

    var lines = [];
    for (var i = 0; i < list.length; i++) {
        var feed = list[i];
        if (!feed || !feed.url) continue; // garbage entries are skipped, not thrown

        var name = feed.name || feed.url;
        lines.push(
            '        <outline text="' + escapeXmlAttr(name) + '" title="' + escapeXmlAttr(name) +
            '" type="rss" xmlUrl="' + escapeXmlAttr(feed.url) + '"/>'
        );
    }

    var head = '    <head>\n        <title>' + escapeXmlText(title) + '</title>\n';
    if (options.dateCreated) {
        head += '        <dateCreated>' + escapeXmlText(options.dateCreated) + '</dateCreated>\n';
    }
    head += '    </head>\n';

    var body = '    <body>\n' + (lines.length ? lines.join("\n") + "\n" : "") + '    </body>\n';

    return '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n' + head + body + '</opml>\n';
}

// ─── feed autodiscovery ───
//
// Given a site's raw HTML, finds the <link rel="alternate"> feed(s) declared
// in its <head>, the same way a browser or feed reader's "subscribe" button
// does. Kept deliberately independent of HtmlExtract.js's tokenizer even
// though the approach (quote-aware scan to the tag's ">", then a
// quote-or-unquoted attribute regex) is the same one HtmlExtract.js uses --
// cross-module require() doesn't work under QML (see file header), so this
// is a second, small, purpose-built copy rather than a shared import. If a
// third module ever needs the same tag scanning, it's worth promoting to a
// function both modules take as an argument; for two call sites duplicating
// ~15 lines, that indirection isn't worth it yet.

var FEED_LINK_TYPE_LABELS = {
    "application/rss+xml": "rss",
    "application/atom+xml": "atom",
    "application/json": "json"
};

// Isolates the document's <head>...</head> so a <link> mentioned in a
// comment, a code sample in the body, or a template string in a <script>
// later on the page can't be mistaken for a real feed declaration. Falls
// back to "everything before <body>" for pages missing a <head> tag
// entirely -- broken markup autodiscovery has to tolerate in the wild.
function extractHeadSection(html) {
    if (!html) return "";
    var headOpen = /<head[\s>]/i.exec(html);
    if (!headOpen) {
        var bodyOpen = /<body[\s>]/i.exec(html);
        return bodyOpen ? html.slice(0, bodyOpen.index) : html;
    }
    var rest = html.slice(headOpen.index);
    var headClose = /<\/head\s*>/i.exec(rest);
    return headClose ? rest.slice(0, headClose.index) : rest;
}

// Quote-aware scan from just past "<link" to the tag's closing ">", so a
// quoted attribute value that happens to contain ">" can't end the tag
// early. Mirrors HtmlExtract.js's scanTagEnd -- see the note above.
function scanLinkTagEnd(html, pos) {
    var quote = null;
    for (var i = pos; i < html.length; i++) {
        var c = html.charAt(i);
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ">") {
            var selfClosed = i > pos && html.charAt(i - 1) === "/";
            return { end: i, attrsStr: html.slice(pos, selfClosed ? i - 1 : i) };
        }
    }
    return { end: -1, attrsStr: "" };
}

// Attribute values may be double-quoted, single-quoted, or bare
// (rel=alternate) per HTML5, and real-world <link> tags use all three.
function parseLinkAttrs(attrsStr) {
    var attrs = {};
    var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    var m;
    while ((m = re.exec(attrsStr)) !== null) {
        var name = m[1].toLowerCase();
        var value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
        attrs[name] = value;
    }
    return attrs;
}

// Resolves an href found in a page against that page's own URL. Same
// algorithm as HtmlExtract.js's resolveHref (absolute / protocol-relative /
// root-relative / directory-relative, with ../ and ./ collapsed by hand
// since this file, like that one, runs under QML's JS engine and has no
// URL class to lean on) -- duplicated for the same cross-module reason
// noted above. Safety is NOT this function's job: isSafeUrl (already in
// this file) is the single allowlist every caller here runs the result
// through afterwards.
function resolveFeedUrl(href, baseUrl) {
    var h = String(href || "").trim();
    if (!h) return "";

    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;

    if (h.indexOf("//") === 0) {
        var schemeMatch = String(baseUrl || "").match(/^([a-z][a-z0-9+.-]*):/i);
        return schemeMatch ? schemeMatch[1] + ":" + h : "";
    }

    if (h.charAt(0) === "#") return "";

    var originMatch = String(baseUrl || "").match(/^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)/i);
    var origin = originMatch ? originMatch[1] : "";
    if (!origin) return "";

    if (h.charAt(0) === "/") return origin + h;

    var pathOnly = String(baseUrl).replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/?#]+/i, "").replace(/[?#].*$/, "");
    var dir = pathOnly.replace(/[^\/]*$/, "");
    if (dir.charAt(0) !== "/") dir = "/" + dir;

    var joined = dir + h;
    var parts = joined.split("/");
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (seg === "" || seg === ".") continue;
        if (seg === "..") { stack.pop(); continue; }
        stack.push(seg);
    }
    return origin + "/" + stack.join("/");
}

// A link's title or href suggesting it's a feed of COMMENTS ("/comments/feed",
// "Comments Feed", WordPress's default comment-feed link) is the actual
// failure mode worth guarding against here: it validates and parses exactly
// like a real feed, so nothing else in this pipeline would catch someone
// getting subscribed to a stream of comment notifications when they meant
// to subscribe to the site.
function looksLikeCommentsFeed(title, href) {
    return /comment/i.test(title || "") || /comment/i.test(href || "");
}

// Finds every <link rel="alternate" type="application/{rss,atom}+xml|json">
// in html's <head>, resolves each href against baseUrl, and returns
// { title, url, type } objects with the best subscription candidate first.
//
// Ranking: RSS/Atom before JSON Feed, because every backend and the OPML
// import path in this widget already speaks RSS/Atom, while JSON Feed
// support is exploratory at best in most readers a user's OPML file might
// end up in -- prefer the format everything downstream actually consumes.
// Within that, a comments-feed link (see looksLikeCommentsFeed) sinks below
// every non-comments link regardless of format, since subscribing someone
// to comments when they wanted the site is strictly worse than getting the
// format preference "wrong". Ties otherwise keep the document's own order.
function discoverFeeds(html, baseUrl) {
    if (!html) return [];

    var headHtml = extractHeadSection(html);
    var candidates = [];
    var seen = {};

    var tagStart = /<link\b/gi;
    var m;
    while ((m = tagStart.exec(headHtml)) !== null) {
        var scan = scanLinkTagEnd(headHtml, m.index + 5);
        if (scan.end === -1) break;
        tagStart.lastIndex = scan.end + 1;

        var attrs = parseLinkAttrs(scan.attrsStr);

        var rel = String(attrs.rel || "").toLowerCase().split(/\s+/);
        var isAlternate = false;
        for (var r = 0; r < rel.length; r++) {
            if (rel[r] === "alternate") { isAlternate = true; break; }
        }
        if (!isAlternate) continue;

        var mime = String(attrs.type || "").toLowerCase();
        var typeLabel = FEED_LINK_TYPE_LABELS[mime];
        if (!typeLabel) continue;

        if (!attrs.href) continue;
        var resolved = resolveFeedUrl(attrs.href, baseUrl);
        if (!resolved || !isSafeUrl(resolved)) continue;

        if (Object.prototype.hasOwnProperty.call(seen, resolved)) continue;
        seen[resolved] = true;

        var title = attrs.title ? cleanText(attrs.title) : "";

        candidates.push({
            title: title,
            url: resolved,
            type: typeLabel,
            isComment: looksLikeCommentsFeed(title, attrs.href),
            formatRank: typeLabel === "json" ? 0 : 1
        });
    }

    // Array.prototype.sort's stability isn't guaranteed on every JS engine
    // this file runs under (QML's is pre-ES2019 V4), so ties are broken on
    // original index explicitly rather than relied on implicitly.
    var indexed = candidates.map(function (c, idx) { return { c: c, idx: idx }; });
    indexed.sort(function (a, b) {
        if (a.c.isComment !== b.c.isComment) return a.c.isComment ? 1 : -1;
        if (a.c.formatRank !== b.c.formatRank) return b.c.formatRank - a.c.formatRank;
        return a.idx - b.idx;
    });

    return indexed.map(function (x) {
        return { title: x.c.title, url: x.c.url, type: x.c.type };
    });
}

// Request descriptor for fetching siteUrl and running discoverFeeds over the
// result -- no I/O happens in this file (see header); QML executes argv and
// hands the stdout to `parse`. Curl hardening copied verbatim from
// ExportProvider.buildArticleFetchRequest: this is the same situation
// (a GET against an arbitrary user-supplied site, no credentials to leak,
// so -L following redirects is safe and necessary -- AMP/canonical bounces
// are as common on homepages as on articles).
function buildDiscoveryRequest(siteUrl) {
    return {
        argv: [
            "curl", "-sS",
            "--connect-timeout", "5",
            "--max-time", "15",
            "-L",
            "--proto", "=http,https",
            "--proto-redir", "=http,https",
            "--max-redirs", "5",
            "--max-filesize", "5000000",
            "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/1.0",
            "--",
            String(siteUrl)
        ],
        timeoutMs: null,
        parse: function (stdout) {
            return discoverFeeds(stdout, siteUrl);
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        extractTag: extractTag,
        cleanText: cleanText,
        stripHtml: stripHtml,
        htmlToText: htmlToText,
        separateBlocks: separateBlocks,
        getRelativeTime: getRelativeTime,
        extractImageUrl: extractImageUrl,
        isSafeUrl: isSafeUrl,
        extractAudioUrl: extractAudioUrl,
        minifluxEntryAudio: minifluxEntryAudio,
        makeItemId: makeItemId,
        parseRssFeed: parseRssFeed,
        parseAtomFeed: parseAtomFeed,
        parseFeed: parseFeed,
        rootElementName: rootElementName,
        rootElementPrefix: rootElementPrefix,
        stripNamespacePrefix: stripNamespacePrefix,
        parseOpml: parseOpml,
        buildOpml: buildOpml,
        discoverFeeds: discoverFeeds,
        buildDiscoveryRequest: buildDiscoveryRequest,
        dedupeItems: dedupeItems,
        parseMinifluxEntries: parseMinifluxEntries
    };
}
