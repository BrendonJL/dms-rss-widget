// Deliberately simplified Readability, over hand-rolled HTML.
// Consumed by BOTH QML (`import "HtmlExtract.js" as HtmlExtract`) and Node (`require`).
//
// IMPORTANT: no `.pragma library` line here -- it is invalid JavaScript and
// breaks Node's require(). Keep this file pure ES5/basic-ES6: no QML
// globals, no Qt APIs, no I/O, no require() of sibling modules.
//
// QML's JS engine has no DOMParser, and this module must also run under
// Node for tests, so extraction is string processing: a tokenizer (state
// machine, not regex-over-the-whole-document -- nested tags, an attribute
// containing ">", an unclosed <p> and a comment containing "</div>" all
// defeat pattern matching, and they do it silently on exactly the pages
// that matter), a tree builder, a scorer, and a markdown emitter. See
// docs/plans/2026-09-11-phase4c-fulltext-design.md for the design this
// implements (stage 4c-a only -- wiring into export is a separate stage).

// ─── bounds ───
// A 5MB page must terminate quickly, not hang. Cap the input before it ever
// reaches the tokenizer, and cap the token count as a second, independent
// bound (a pathologically tag-dense small input is bounded the same way).
var DEFAULT_MAX_INPUT_LENGTH = 4 * 1024 * 1024; // ~4MB of characters
var DEFAULT_MAX_TOKENS = 80000;

// Fall back to the summary when extraction yields less than this fraction
// of the summary's own length. A worse result than we started with is a
// failure, not an improvement.
var FALLBACK_RATIO = 0.4;

// ─── index-page guard ───
//
// Measured 2026-09-11 against real section fronts (bbc.com/news,
// arstechnica.com/): where Mozilla Readability correctly returns almost
// nothing for an index page, this extractor returned 13k characters of
// headline soup -- a real container won the scoring pass, it just wasn't an
// article. The scoring's link-density penalty alone doesn't catch it,
// because a headline list interleaved with timestamps/bylines outside the
// <a> rarely reaches 100% link density, only "dominated by links".
//
// Two independent signals, either one enough to reject:
//
// 1. Link density over half. An article's inline links are occasional (a
//    citation, a related read); an index page's entire payload IS links, so
//    anything at or above "half the text sits inside <a>" is definitionally
//    navigation, not prose.
var INDEX_LINK_DENSITY_THRESHOLD = 0.5;

// 2. Fragment-dominated text. A headline or teaser is a sentence fragment:
//    no terminal punctuation, and short because it has to fit a listing
//    slot. A real paragraph almost always ends in ./!/?; a page that is
//    mostly bare fragments is a listing, not an article.
//
//    Measured against real pages while tuning this: a plain per-LINE
//    fraction false-positived on legitimate long articles, because a
//    Wikipedia page's trailing navbox ("See also" template links) or an
//    infobox contributes hundreds of short link lines below a handful of
//    long prose paragraphs -- lots of lines, almost no text. Weighting by
//    CHARACTERS instead fixes it: those fragments are individually tiny, so
//    they can dominate a line count while remaining a small fraction of the
//    actual text volume. An index page has the opposite shape -- little
//    else BUT fragments -- so the character-weighted fraction stays high
//    for it and drops for an article with boilerplate stapled on.
//
//    Fenced code blocks are stripped before this runs: a real code sample or
//    a quoted plain-text document (an advisory, a changelog, an email
//    header block) is legitimately full of short "Key: value" lines with no
//    sentence punctuation, and that is a property of preformatted text, not
//    evidence the page is an index.
//
//    80 chars is roughly one headline's worth of text (a full sentence of
//    that length almost always still carries terminal punctuation); 70%
//    keeps an article with a handful of short captions/datelines from
//    tripping, while still catching a page that is overwhelmingly
//    fragments. Markdown headings are excluded (both from the fragment tally
//    and the total): a well-formed article legitimately has several short,
//    unpunctuated section headings, and that is normal structure, not
//    evidence of an index.
var INDEX_SHORT_LINE_MAX_CHARS = 80;
var INDEX_FRAGMENT_CHAR_FRACTION_THRESHOLD = 0.7;

// Below this many characters of candidate text the fraction above is too
// noisy to trust (a two-line article legitimately can be 100% "short" and
// prove nothing).
var INDEX_MIN_FRAGMENT_CHARS = 200;

// Returns a rejection reason string, or null if the result reads as an
// article. `linkDensity` is the winning container's own linkChars/charCount
// (already computed once during scoring -- not recomputed here).
function indexPageReason(markdown, linkDensity) {
    var linkHeavy = linkDensity > INDEX_LINK_DENSITY_THRESHOLD;

    var withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
    var lines = withoutCode.split("\n")
        .map(function (l) { return l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/^>\s?/, "").trim(); })
        .filter(function (l) { return l.length > 0 && l.charAt(0) !== "#"; });

    var totalChars = 0;
    var fragmentChars = 0;
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        totalChars += l.length;
        var endsWithSentencePunct = /[.!?]["'\u2019\u201d)\]]*$/.test(l);
        if (l.length <= INDEX_SHORT_LINE_MAX_CHARS && !endsWithSentencePunct) fragmentChars += l.length;
    }
    var headlineSoup = totalChars >= INDEX_MIN_FRAGMENT_CHARS &&
        (fragmentChars / totalChars) > INDEX_FRAGMENT_CHAR_FRACTION_THRESHOLD;

    if (!linkHeavy && !headlineSoup) return null;

    var bits = [];
    if (linkHeavy) bits.push("link density " + Math.round(linkDensity * 100) + "%");
    if (headlineSoup) bits.push("mostly short unpunctuated text");
    return "looks like an index page, not an article (" + bits.join(", ") + ")";
}

// ─── tag tables ───

var RAW_TEXT_TAGS = { script: 1, style: 1, noscript: 1, iframe: 1, textarea: 1 };

var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
};

// Dropped outright, subtree and all: chrome that is never article content.
var DROP_TAGS = {
    script: 1, style: 1, nav: 1, header: 1, footer: 1, aside: 1, form: 1,
    noscript: 1, iframe: 1
};

// Elements whose class or id names them as boilerplate get dropped the same
// way as DROP_TAGS, regardless of which tag they are.
var DROP_CLASS_RE = /share|comment|promo|related|newsletter|subscribe|cookie|banner|advert/i;

// Opening one of these implicitly closes an open <p> ancestor (this mirrors
// the HTML5 "paragraph closes" list, trimmed to what matters here). This is
// what makes an unclosed <p> followed by another block element behave the
// way a browser would, instead of nesting forever.
var AUTOCLOSE_P = {
    address: 1, article: 1, aside: 1, blockquote: 1, div: 1, dl: 1,
    fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1,
    h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, main: 1,
    menu: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, table: 1, ul: 1
};

// Candidate containers for the winning-article scoring pass.
var CANDIDATE_TAGS = { article: 1, main: 1, div: 1, section: 1 };

// Tags treated as inline when emitting markdown -- they contribute to the
// current paragraph buffer rather than starting a new block.
var INLINE_TAGS = {
    a: 1, b: 1, strong: 1, i: 1, em: 1, code: 1, span: 1, small: 1, sub: 1,
    sup: 1, u: 1, s: 1, strike: 1, mark: 1, abbr: 1, cite: 1, q: 1, time: 1,
    label: 1, br: 1, wbr: 1
};

// ─── entities / whitespace ───

function decodeEntities(text) {
    if (!text) return "";
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    text = text.replace(/&nbsp;/g, " ");
    text = text.replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
    });
    text = text.replace(/&#(\d+);/g, function (m, dec) {
        return String.fromCharCode(parseInt(dec, 10));
    });
    return text;
}

function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ");
}

function repeat(str, times) {
    return times <= 0 ? "" : new Array(times + 1).join(str);
}

// ─── tokenizer ───
// Emits a flat stream of { type: "open"|"close"|"text", tag, attrs }.
// Quote-aware: an attribute value containing ">" cannot end the tag early.
// Comments (including ones containing "</div>") are skipped whole, never
// tokenized. script/style/noscript/iframe/textarea content is consumed as
// raw text up to their literal closing tag, so markup-like text inside
// <script> never gets mistaken for real tags.

function scanTagEnd(html, pos) {
    var quote = null;
    var len = html.length;
    for (var i = pos; i < len; i++) {
        var c = html.charAt(i);
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ">") {
            var selfClosed = i > pos && html.charAt(i - 1) === "/";
            return { end: i, attrsStr: html.slice(pos, selfClosed ? i - 1 : i), selfClosed: selfClosed };
        }
    }
    return { end: -1, attrsStr: "", selfClosed: false };
}

function parseAttrs(attrsStr) {
    var attrs = {};
    var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/g;
    var m;
    while ((m = re.exec(attrsStr)) !== null) {
        var name = m[1].toLowerCase();
        var value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
        attrs[name] = value;
    }
    return attrs;
}

function tokenize(html, maxTokens) {
    var tokens = [];
    var i = 0;
    var len = html.length;
    maxTokens = maxTokens || DEFAULT_MAX_TOKENS;

    while (i < len && tokens.length < maxTokens) {
        var lt = html.indexOf("<", i);
        if (lt === -1) {
            tokens.push({ type: "text", text: html.slice(i) });
            break;
        }
        if (lt > i) tokens.push({ type: "text", text: html.slice(i, lt) });

        var next = html.charAt(lt + 1);

        if (next === "!" && html.substr(lt, 4) === "<!--") {
            var endC = html.indexOf("-->", lt + 4);
            i = endC === -1 ? len : endC + 3;
            continue;
        }
        if (next === "!" || next === "?") {
            var endD = html.indexOf(">", lt + 2);
            i = endD === -1 ? len : endD + 1;
            continue;
        }
        if (next === "/") {
            var mc = /^<\/\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(html.substr(lt, 64));
            if (!mc) { i = lt + 1; continue; }
            var closeScan = scanTagEnd(html, lt + 2);
            if (closeScan.end === -1) { i = len; break; }
            tokens.push({ type: "close", tag: mc[1].toLowerCase() });
            i = closeScan.end + 1;
            continue;
        }

        var mo = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.substr(lt, 64));
        if (!mo) {
            // "<" not followed by a valid tag name -- literal character.
            tokens.push({ type: "text", text: "<" });
            i = lt + 1;
            continue;
        }
        var tagName = mo[1].toLowerCase();
        var scan = scanTagEnd(html, lt + 1 + mo[1].length);
        if (scan.end === -1) { i = len; break; } // unterminated tag at EOF

        var attrs = parseAttrs(scan.attrsStr);
        tokens.push({ type: "open", tag: tagName, attrs: attrs, selfClosed: scan.selfClosed });
        i = scan.end + 1;

        if (RAW_TEXT_TAGS[tagName] && !scan.selfClosed) {
            var closeRe = new RegExp("<\\/\\s*" + tagName + "\\s*>", "i");
            var rest = html.slice(i);
            var cm = closeRe.exec(rest);
            if (cm) {
                if (cm.index > 0) tokens.push({ type: "text", text: rest.slice(0, cm.index) });
                tokens.push({ type: "close", tag: tagName });
                i += cm.index + cm[0].length;
            } else {
                tokens.push({ type: "text", text: rest });
                i = len;
            }
        }
    }

    return tokens;
}

// ─── tree builder ───
// Text nodes are plain { text: "..." }; element nodes are
// { tag, attrs, children }. Dropped subtrees (DROP_TAGS, boilerplate
// class/id) never enter the tree at all.

function isBoilerplateClass(attrs) {
    if (!attrs) return false;
    var cls = attrs["class"] || "";
    var id = attrs["id"] || "";
    return DROP_CLASS_RE.test(cls) || DROP_CLASS_RE.test(id);
}

function buildTree(tokens) {
    var root = { tag: "#root", attrs: {}, children: [] };
    var stack = [root];
    var dropTag = null;
    var dropDepth = 0;

    for (var ti = 0; ti < tokens.length; ti++) {
        var tok = tokens[ti];

        if (dropTag) {
            if (tok.type === "open" && tok.tag === dropTag && !tok.selfClosed && !VOID_TAGS[tok.tag]) {
                dropDepth++;
            } else if (tok.type === "close" && tok.tag === dropTag) {
                dropDepth--;
                if (dropDepth <= 0) dropTag = null;
            }
            continue;
        }

        if (tok.type === "text") {
            if (tok.text !== "") stack[stack.length - 1].children.push({ text: tok.text });
            continue;
        }

        if (tok.type === "open") {
            if (DROP_TAGS[tok.tag] || isBoilerplateClass(tok.attrs)) {
                if (!tok.selfClosed && !VOID_TAGS[tok.tag]) { dropTag = tok.tag; dropDepth = 1; }
                continue;
            }

            if (AUTOCLOSE_P[tok.tag]) {
                var top = stack[stack.length - 1];
                if (top.tag === "p") stack.pop();
            }

            var node = { tag: tok.tag, attrs: tok.attrs, children: [] };
            stack[stack.length - 1].children.push(node);
            if (!tok.selfClosed && !VOID_TAGS[tok.tag]) stack.push(node);
            continue;
        }

        if (tok.type === "close") {
            var idx = -1;
            for (var s = stack.length - 1; s >= 1; s--) {
                if (stack[s].tag === tok.tag) { idx = s; break; }
            }
            if (idx === -1) continue; // stray close tag with no matching open -- ignore
            stack.length = idx; // closes idx and anything left unclosed above it
            continue;
        }
    }

    return root;
}

// ─── scoring ───
// One bottom-up pass annotates every node with aggregate stats so scoring a
// candidate is O(1) instead of re-walking its subtree -- with up to
// DEFAULT_MAX_TOKENS nodes, re-walking per candidate would be quadratic.

function countChar(str, ch) {
    var n = 0;
    for (var i = 0; i < str.length; i++) if (str.charAt(i) === ch) n++;
    return n;
}

function annotateStats(node) {
    var total = { charCount: 0, commaCount: 0, paragraphCount: 0, linkChars: 0 };
    for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (!c.tag) {
            var t = normalizeWhitespace(decodeEntities(c.text));
            total.charCount += t.length;
            total.commaCount += countChar(t, ",");
            continue;
        }
        var childStats = annotateStats(c);
        total.charCount += childStats.charCount;
        total.commaCount += childStats.commaCount;
        total.paragraphCount += childStats.paragraphCount + (c.tag === "p" ? 1 : 0);
        total.linkChars += childStats.linkChars + (c.tag === "a" ? childStats.charCount : 0);
    }
    node._stats = total;
    return total;
}

function collectCandidates(root) {
    var out = [root];
    (function walk(node) {
        for (var i = 0; i < node.children.length; i++) {
            var c = node.children[i];
            if (!c.tag) continue;
            if (CANDIDATE_TAGS[c.tag]) out.push(c);
            walk(c);
        }
    })(root);
    return out;
}

// Link density is the strongest signal separating navigation from prose --
// a nav sidebar is mostly links, an article is mostly prose -- so it is
// applied as a hard multiplicative penalty (squared) rather than a linear
// subtraction. <article>/<main> get a large additive bonus: when a page
// declares where its content is, believe it.
function scoreNode(node) {
    var stats = node._stats;
    if (!stats || stats.charCount === 0) return 0;

    var linkDensity = Math.min(stats.linkChars / stats.charCount, 1);
    var base = stats.charCount + stats.commaCount * 20 + stats.paragraphCount * 30;
    var score = base * Math.pow(1 - linkDensity, 2);

    if (node.tag === "article" || node.tag === "main") score += 500;

    return score;
}

function pickBest(candidates) {
    var best = candidates[0];
    var bestScore = scoreNode(best);
    for (var i = 1; i < candidates.length; i++) {
        var sc = scoreNode(candidates[i]);
        if (sc > bestScore) { bestScore = sc; best = candidates[i]; }
    }
    return best;
}

// ─── markdown emission ───
// Headings, paragraphs, lists, blockquotes, code, inline links and
// emphasis. Images are dropped by default (a note full of hotlinked CDN
// images rots).


// Resolve an href against the page it came from.
//
// Extracted articles are full of site-relative links ("/news/articles/x").
// They work on the site and are dead in a markdown file, which reads as text
// that looks like a link and goes nowhere -- worse than no link, because the
// reader tries it. Given the article's own URL we can make them real.
//
// No URL class here: this runs in QML's JS engine as well as Node, so it is
// string work, like everything else in this file.
//
// Returns "" when the href cannot be made absolute, and the caller then emits
// the link TEXT without a target. Losing a link is fine; a dead one is not.
function resolveHref(href, baseUrl) {
    var h = String(href || "").trim();
    if (!h) return "";

    // Already absolute, or a scheme we deliberately allow through as-is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return isSafeHref(h) ? h : "";

    // Protocol-relative: inherit the base's scheme.
    if (h.indexOf("//") === 0) {
        var scheme = baseMatch(baseUrl, /^([a-z][a-z0-9+.-]*):/i);
        return scheme ? scheme + ":" + h : "";
    }

    // In-page anchors point into a document the note does not contain.
    if (h.charAt(0) === "#") return "";

    var origin = baseMatch(baseUrl, /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)/i);
    if (!origin) return "";

    if (h.charAt(0) === "/") return origin + h;

    // Relative to the base's directory.
    var pathOnly = String(baseUrl).replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/?#]+/i, "").replace(/[?#].*$/, "");
    var dir = pathOnly.replace(/[^\/]*$/, "");
    if (dir.charAt(0) !== "/") dir = "/" + dir;

    var joined = dir + h;
    // Collapse ./ and ../ without a URL parser.
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

function baseMatch(baseUrl, re) {
    var m = String(baseUrl || "").match(re);
    return m ? m[1] : "";
}
function isSafeHref(href) {
    if (typeof href !== "string") return false;
    var trimmed = href.trim();
    if (trimmed === "") return false;
    if (/^javascript:/i.test(trimmed)) return false;
    if (/^data:/i.test(trimmed)) return false;
    if (/^vbscript:/i.test(trimmed)) return false;
    return true;
}

function collectRawText(node) {
    var out = "";
    for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        out += c.tag ? collectRawText(c) : decodeEntities(c.text);
    }
    return out;
}

// Renders node's children as a single inline string (used for paragraph /
// heading / link / list-item text). Unknown non-inline tags are flattened
// rather than dropped, so a stray block tag inside inline context still
// contributes its text.
function emitInline(node, opts) {
    var out = "";
    for (var i = 0; i < node.children.length; i++) {
        var c = node.children[i];
        if (!c.tag) { out += decodeEntities(c.text); continue; }
        if (c.tag === "img") continue;
        if (c.tag === "br" || c.tag === "wbr") { out += "\n"; continue; }
        if (c.tag === "a") {
            var linkText = normalizeWhitespace(emitInline(c, opts)).trim();
            if (!linkText) continue;
            var href = c.attrs && c.attrs.href;
            var abs = resolveHref(href, opts && opts.baseUrl);
            out += abs ? "[" + linkText + "](" + abs + ")" : linkText;
            continue;
        }
        if (c.tag === "strong" || c.tag === "b") {
            var bt = normalizeWhitespace(emitInline(c, opts)).trim();
            out += bt ? "**" + bt + "**" : "";
            continue;
        }
        if (c.tag === "em" || c.tag === "i") {
            var it = normalizeWhitespace(emitInline(c, opts)).trim();
            out += it ? "*" + it + "*" : "";
            continue;
        }
        if (c.tag === "code") {
            var ct = normalizeWhitespace(emitInline(c, opts)).trim();
            out += ct ? "`" + ct + "`" : "";
            continue;
        }
        out += emitInline(c, opts) + " ";
    }
    return out;
}

function emitList(node, ordered, depth, opts) {
    var lines = [];
    var idx = 1;
    var indent = repeat("  ", depth);
    for (var i = 0; i < node.children.length; i++) {
        var li = node.children[i];
        if (!li.tag || li.tag !== "li") continue;
        var content = emitBlockChildren(li.children, depth + 1, opts);
        if (!content) continue;
        var parts = content.split("\n\n");
        var marker = ordered ? (idx + ". ") : "- ";
        lines.push(indent + marker + parts[0].replace(/\n/g, " "));
        for (var k = 1; k < parts.length; k++) lines.push(indent + "  " + parts[k].replace(/\n/g, " "));
        idx++;
    }
    return lines.join("\n");
}

function emitBlockElement(node, depth, opts) {
    switch (node.tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
            var level = parseInt(node.tag.charAt(1), 10);
            var htext = normalizeWhitespace(emitInline(node, opts)).trim();
            return htext ? repeat("#", level) + " " + htext : "";
        }
        case "p": {
            return normalizeWhitespace(emitInline(node, opts)).trim();
        }
        case "blockquote": {
            var inner = emitBlockChildren(node.children, depth, opts);
            return inner ? inner.split("\n").map(function (l) { return "> " + l; }).join("\n") : "";
        }
        case "ul":
            return emitList(node, false, depth, opts);
        case "ol":
            return emitList(node, true, depth, opts);
        case "pre": {
            var raw = collectRawText(node).replace(/^\n+|\n+$/g, "");
            return raw.trim() ? "```\n" + raw + "\n```" : "";
        }
        case "hr":
            return "---";
        default:
            // div, section, article, main, table/tr/td/th, figure, etc.:
            // no markdown shape of their own, so their children are emitted
            // as ordinary blocks.
            return emitBlockChildren(node.children, depth, opts);
    }
}

// Walks node's children, buffering consecutive text/inline content into
// paragraphs and flushing to a distinct block whenever a real block-level
// element is hit. This is what makes "div soup" (loose text directly under
// a <div>, no <p> at all) come out as paragraphs instead of one run-on blob.
function emitBlockChildren(children, depth, opts) {
    var blocks = [];
    var buffer = "";
    for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (!c.tag) { buffer += decodeEntities(c.text); continue; }
        if (c.tag === "img") continue;
        if (INLINE_TAGS[c.tag]) { buffer += emitInline({ children: [c] }, opts); continue; }

        var bufTrim = normalizeWhitespace(buffer).trim();
        if (bufTrim) blocks.push(bufTrim);
        buffer = "";

        var blockMd = emitBlockElement(c, depth, opts);
        if (blockMd) blocks.push(blockMd);
    }
    var tailTrim = normalizeWhitespace(buffer).trim();
    if (tailTrim) blocks.push(tailTrim);
    return blocks.join("\n\n");
}


// Drop promo sections spliced into the article body.
//
// Publishers put "recommended stories" widgets between paragraphs, inside the
// same container as the prose, with no class the boilerplate filter catches.
// Two shapes, handled separately because they carry different evidence.
//
// 1. A LABELLED SECTION. Al Jazeera emits:
//
//        ## Recommended Stories
//        - list 1 of 3 [BRICS summit: Is the bloc truly...](...)
//
//    The heading is the publisher stating outright that what follows is not
//    the article. That is explicit intent, not a guess, so it is the strongest
//    signal available -- drop the heading and everything under it until the
//    next heading of the same or higher level.
//
// 2. AN UNLABELLED SHORT LIST of nothing but headline links, interrupting
//    prose. No heading to go on, so all three conditions must hold: every item
//    link-only, at most PROMO_MAX_ITEMS, and prose on both sides. A long run of
//    link-only blocks is a reference list and real content -- danluu's
//    input-lag article has 56 of them and every one belongs.
var PROMO_MAX_ITEMS = 5;

var PROMO_HEADING = /^#{1,6}\s*(recommended|related|more (from|on|stories)|read more|you may (also )?like|most read|popular|trending|sponsored|promoted|from our|elsewhere on)\b/i;

function headingLevel(block) {
    var m = String(block || "").match(/^(#{1,6})\s/);
    return m ? m[1].length : 0;
}

function isLinkOnlyItem(line) {
    // Some publishers prefix screen-reader text ("list 1 of 3"), which is not
    // part of the headline and should not stop this matching.
    return /^\s*[-*]\s*(list \d+ of \d+\s*)?\[[^\]]*\]\([^)]*\)\s*$/i.test(line);
}

function isPromoList(block) {
    var lines = String(block || "").split("\n").filter(function (l) { return l.trim() !== ""; });
    if (lines.length === 0 || lines.length > PROMO_MAX_ITEMS) return false;
    for (var i = 0; i < lines.length; i++) {
        if (!isLinkOnlyItem(lines[i])) return false;
    }
    return true;
}

function isProseBlock(block) {
    var t = String(block || "").trim();
    if (!t) return false;
    if (/^[#>\-*`|]/.test(t)) return false;
    if (/^\s*\[[^\]]*\]\([^)]*\)\s*$/.test(t)) return false;
    return t.length > 80;
}

function dropPromoSections(markdown) {
    var blocks = String(markdown || "").split("\n\n");
    var out = [];
    var skipUntilLevel = 0;

    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        var level = headingLevel(block);

        if (skipUntilLevel > 0) {
            // A heading at the same or higher level ends the promo section.
            if (level > 0 && level <= skipUntilLevel) {
                skipUntilLevel = 0;
            } else {
                continue;
            }
        }

        if (level > 0 && PROMO_HEADING.test(block)) {
            skipUntilLevel = level;
            continue;
        }

        if (isPromoList(block) && isProseBlock(blocks[i - 1]) && isProseBlock(blocks[i + 1])) {
            continue;
        }

        out.push(block);
    }
    return out.join("\n\n");
}
function emitMarkdown(node, opts) {
    return emitBlockChildren(node.children, 0, opts).trim();
}

// ─── plain-text length (for the fallback comparison) ───
// Strips markdown syntax back out so a markdown result and a plain-text
// summary are compared on the same basis.
function plainTextLength(text) {
    if (!text) return 0;
    var stripped = String(text)
        .replace(/```[\s\S]*?```/g, function (m) { return m.replace(/```/g, ""); })
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/^\s*[-*]\s+/gm, "")
        .replace(/^\s*\d+\.\s+/gm, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*`_]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return stripped.length;
}

function fallbackResult(summary, reason) {
    var md = summary || "";
    return { markdown: md, textLength: plainTextLength(md), usedFallback: true, reason: reason };
}

// ─── public entry point ───
//
// extractArticle(html, options) -> { markdown, textLength, usedFallback, reason }
//
// options:
//   summary          - the feed's existing summary text/markdown. When
//                       given, extraction that yields less than ~40% of the
//                       summary's plain-text length is rejected in favour of
//                       the summary itself (a worse result than we started
//                       with is a failure, not an improvement).
//   maxInputLength   - override the input-size cap (chars). Default 4MB.
//   maxTokens        - override the token-count cap. Default 80000.
//
// Never throws. Bad, empty, or pathologically large input all resolve to a
// result object, falling back to `summary` (or "" if none was given).
function extractArticle(html, options) {
    options = options || {};
    var summary = typeof options.summary === "string" ? options.summary : "";
    var maxInputLength = options.maxInputLength || DEFAULT_MAX_INPUT_LENGTH;
    var maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;

    if (!html || typeof html !== "string") {
        return fallbackResult(summary, "no html provided");
    }

    var input = html.length > maxInputLength ? html.slice(0, maxInputLength) : html;

    var tokens = tokenize(input, maxTokens);
    var tree = buildTree(tokens);
    annotateStats(tree);

    var candidates = collectCandidates(tree);
    var best = pickBest(candidates);

    var markdown = dropPromoSections(emitMarkdown(best, options));
    var textLength = plainTextLength(markdown);

    if (textLength === 0) {
        return fallbackResult(summary, "extraction produced no text");
    }

    var winnerLinkDensity = best._stats && best._stats.charCount
        ? Math.min(best._stats.linkChars / best._stats.charCount, 1)
        : 0;
    var indexReason = indexPageReason(markdown, winnerLinkDensity);
    if (indexReason) {
        return fallbackResult(summary, indexReason);
    }

    var summaryLen = plainTextLength(summary);
    if (summaryLen > 0 && textLength < summaryLen * FALLBACK_RATIO) {
        return fallbackResult(
            summary,
            "extraction (" + textLength + " chars) below " + Math.round(FALLBACK_RATIO * 100) +
            "% of summary (" + summaryLen + " chars)"
        );
    }

    return { markdown: markdown, textLength: textLength, usedFallback: false, reason: "" };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        extractArticle: extractArticle,
        tokenize: tokenize,
        buildTree: buildTree,
        annotateStats: annotateStats,
        collectCandidates: collectCandidates,
        scoreNode: scoreNode,
        pickBest: pickBest,
        emitMarkdown: emitMarkdown,
        plainTextLength: plainTextLength,
        decodeEntities: decodeEntities,
        isSafeHref: isSafeHref,
        indexPageReason: indexPageReason
    };
}
