// Quality oracle for HtmlExtract.js.
//
// Runs Mozilla's Readability -- the algorithm behind Firefox Reader View -- in
// headless Chromium over real article pages, then compares our own extractor
// against it. Readability needs a DOM, which is why it runs in a browser here.
//
// Nothing in this directory ships with the plugin. It is a TEST ORACLE: the
// browser and Readability exist to tell us how good our zero-dependency
// extractor is, so the answer is measured rather than guessed.
//
//   node tests/oracle/run-oracle.js            # use cached pages
//   node tests/oracle/run-oracle.js --fetch    # re-download the page set
//
// Pages are cached under tests/oracle/cache/ and are NOT committed -- they are
// news articles, not ours to vendor.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const CACHE = path.join(HERE, "cache");
const REPO = path.join(HERE, "..", "..");

function findChromium() {
    const candidates = [
        process.env.CHROMIUM,
        path.join(process.env.HOME, ".nix-profile/bin/chromium"),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome"
    ].filter(Boolean);
    for (const c of candidates) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) { /* next */ }
    }
    return null;
}

// Deliberately varied: different publishers, different CMSes, a wiki, a
// long-form piece, a docs page. An extractor tuned on one publisher's markup
// overfits to it, and that is invisible until it meets another.
const URLS = [
    // Real ARTICLES only. An earlier run mixed in section fronts (bbc.com/news,
    // arstechnica.com/, theguardian.com/international) and scored badly on them
    // -- correctly, since the right answer for an index page is "this is not an
    // article", not "extract the headline list". Those belong in the
    // index-page test below, not in the quality comparison.
    "https://en.wikipedia.org/wiki/RSS",
    "https://lwn.net/Articles/964143/",
    "https://danluu.com/input-lag/",
    "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article",
    "https://en.wikipedia.org/wiki/Atom_(web_standard)",
    "https://www.gutenberg.org/files/74/74-h/74-h.htm",
    "https://go.dev/blog/slog",
    "https://www.kernel.org/doc/html/latest/process/howto.html",
    "https://fasterthanli.me/articles/a-rust-match-made-in-hell",
    "https://ciechanow.ski/curves-and-surfaces/",
    "https://en.wikipedia.org/wiki/Web_feed",
    "https://www.theguardian.com/global-development/2026/sep/02/bangladesh-india-barclays-bank-legal-complaint-backing-polluting-rampal-power-plant-sundarbans",
    "https://simonwillison.net/2024/Jan/1/",
    "https://blog.codinghorror.com/the-php-singularity/",
    "https://martinfowler.com/articles/patterns-of-distributed-systems/write-ahead-log.html",
    "https://overreacted.io/a-complete-guide-to-useeffect/",
    "https://eev.ee/blog/2016/07/31/constructive-criticism/",
    "https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/",
    "https://blog.regehr.org/archives/1520",
    "https://apenwarr.ca/log/20211231"
];

function slug(url) {
    return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80);
}

function fetchPage(url, dest) {
    execFileSync("curl", [
        "-sS", "-L", "--proto", "=http,https", "--proto-redir", "=http,https",
        "--max-redirs", "5", "--max-filesize", "5000000",
        "--connect-timeout", "10", "--max-time", "45",
        "-A", "Mozilla/5.0 (X11; Linux x86_64) DankRssWidget/oracle",
        "-o", dest, url
    ], { stdio: ["ignore", "ignore", "pipe"] });
}

// Readability mutates the document it is given, so the runner parses a fresh
// copy from a string rather than operating on the live page.
function buildRunner(rawHtml) {
    const readability = fs.readFileSync(path.join(HERE, "Readability.js"), "utf8");
    return `<!doctype html><meta charset="utf-8"><body><pre id="out"></pre><script>
${readability}
</script><script>
var RAW = ${JSON.stringify(rawHtml).replace(/<\/script/gi, "<\\/script")};
var out = document.getElementById("out");
try {
  var doc = new DOMParser().parseFromString(RAW, "text/html");
  var base = doc.createElement("base");
  base.href = "https://example.invalid/";
  doc.head && doc.head.appendChild(base);
  var article = new Readability(doc).parse();
  out.textContent = (article && article.textContent) ? article.textContent : "";
} catch (e) {
  out.textContent = "";
}
</script>`;
}

function readabilityText(chromium, rawHtml) {
    const runner = path.join(CACHE, "_runner.html");
    fs.writeFileSync(runner, buildRunner(rawHtml));
    const dom = execFileSync(chromium, [
        "--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000",
        "--dump-dom", "file://" + runner
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    if (!m) return "";
    return m[1]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

function normalise(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
}

// Similarity on word multisets. Not a diff: our extractor emits markdown and
// Readability emits text, so punctuation and layout differ legitimately. What
// matters is whether we captured the same PROSE.
function overlap(ours, theirs) {
    const bag = (s) => {
        const m = new Map();
        normalise(s).toLowerCase().split(" ").filter(w => w.length > 3)
            .forEach(w => m.set(w, (m.get(w) || 0) + 1));
        return m;
    };
    const a = bag(ours), b = bag(theirs);
    if (b.size === 0) return null;
    let shared = 0, total = 0;
    for (const [w, n] of b) {
        total += n;
        shared += Math.min(n, a.get(w) || 0);
    }
    return total === 0 ? null : shared / total;
}

function main() {
    const chromium = findChromium();
    if (!chromium) {
        console.log("SKIP: no chromium found (set CHROMIUM=/path/to/chromium)");
        process.exit(0);
    }
    fs.mkdirSync(CACHE, { recursive: true });
    const wantFetch = process.argv.includes("--fetch");

    let extract;
    try {
        extract = require(path.join(REPO, "HtmlExtract.js"));
    } catch (e) {
        console.log("SKIP: HtmlExtract.js not present yet (" + e.code + ")");
        process.exit(0);
    }

    console.log("chromium: " + chromium);
    console.log("comparing HtmlExtract against Mozilla Readability\n");
    console.log("  ours/oracle chars   overlap  page");
    console.log("  -----------------   -------  ----");

    const scores = [];
    for (const url of URLS) {
        const file = path.join(CACHE, slug(url) + ".html");
        if (wantFetch || !fs.existsSync(file)) {
            try { fetchPage(url, file); }
            catch (e) { console.log("  fetch failed          ----     " + url); continue; }
        }
        const raw = fs.readFileSync(file, "utf8");
        if (raw.length < 500) { console.log("  too small             ----     " + url); continue; }

        let theirs = "";
        try { theirs = readabilityText(chromium, raw); }
        catch (e) { console.log("  oracle failed         ----     " + url); continue; }

        let ours = "";
        try { ours = extract.extractArticle(raw, {}).markdown || ""; }
        catch (e) { console.log("  OURS THREW            ----     " + url + "  " + e.message); continue; }

        const ov = overlap(ours, theirs);
        const label = url.replace(/^https?:\/\//, "").slice(0, 46);
        if (ov === null) {
            console.log("  " + String(normalise(ours).length).padStart(6) + "/     0   (oracle empty)  " + label);
            continue;
        }
        scores.push({ url: label, ov, ours: normalise(ours).length, theirs: normalise(theirs).length });
        console.log("  " + String(normalise(ours).length).padStart(6) + "/" +
            String(normalise(theirs).length).padEnd(6) + "  " +
            (ov * 100).toFixed(0).padStart(5) + "%   " + label);
    }

    if (scores.length === 0) { console.log("\nno comparable pages"); process.exit(0); }
    scores.sort((a, b) => a.ov - b.ov);
    const mean = scores.reduce((s, x) => s + x.ov, 0) / scores.length;
    const median = scores[Math.floor(scores.length / 2)].ov;
    console.log("\npages compared: " + scores.length);
    console.log("mean overlap:   " + (mean * 100).toFixed(1) + "%");
    console.log("median overlap: " + (median * 100).toFixed(1) + "%");
    console.log("\nworst five:");
    scores.slice(0, 5).forEach(s =>
        console.log("  " + (s.ov * 100).toFixed(0).padStart(3) + "%  " +
            s.ours + "/" + s.theirs + "  " + s.url));
}

main();
