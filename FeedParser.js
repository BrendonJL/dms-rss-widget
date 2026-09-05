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
            description: cleanText(stripHtml(description || "")),
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

function parseAtomFeed(xml, sourceName, sourceUrl) {
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
            description: cleanText(stripHtml(summary || "")),
            dateStr: updated || "",
            timestamp: updated ? new Date(updated).getTime() || 0 : 0,
            source: sourceName,
            sourceUrl: sourceUrl || "",
            imageUrl: extractImageUrl(block, summary || "")
        });
    }
    return items;
}

function parseFeed(xml, sourceName, sourceUrl) {
    if (xml.indexOf("<feed") !== -1) {
        return parseAtomFeed(xml, sourceName, sourceUrl);
    }
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
        getRelativeTime: getRelativeTime,
        extractImageUrl: extractImageUrl,
        isSafeUrl: isSafeUrl,
        makeItemId: makeItemId,
        parseRssFeed: parseRssFeed,
        parseAtomFeed: parseAtomFeed,
        parseFeed: parseFeed,
        parseOpml: parseOpml,
        dedupeItems: dedupeItems
    };
}
