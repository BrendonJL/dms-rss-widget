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
            imageUrl: extractImageUrl(block, description || "")
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
            imageUrl: extractImageUrl(block, summary || "")
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
            imageUrl: minifluxEntryImage(entry)
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

function parseOpml(xml) {
    var feeds = [];
    var outlineRegex = /<outline[^>]*xmlUrl=["']([^"']+)["'][^>]*>/gi;
    var match;
    while ((match = outlineRegex.exec(xml)) !== null) {
        var fullTag = match[0];
        var url = match[1].replace(/&amp;/g, "&");

        var titleAttr = fullTag.match(/\btitle=["']([^"']*)["']/i);
        var textAttr = fullTag.match(/\btext=["']([^"']*)["']/i);
        var rawName = titleAttr ? titleAttr[1] : (textAttr ? textAttr[1] : url);
        var name = rawName.replace(/&amp;/g, "&");

        feeds.push({ name: name, url: url });
    }
    return feeds;
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
        makeItemId: makeItemId,
        parseRssFeed: parseRssFeed,
        parseAtomFeed: parseAtomFeed,
        parseFeed: parseFeed,
        rootElementName: rootElementName,
        rootElementPrefix: rootElementPrefix,
        stripNamespacePrefix: stripNamespacePrefix,
        parseOpml: parseOpml,
        dedupeItems: dedupeItems,
        parseMinifluxEntries: parseMinifluxEntries
    };
}
