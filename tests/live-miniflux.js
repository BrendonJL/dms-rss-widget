// NOT part of `node --test tests/*.test.js` -- it is tests/live-miniflux.js,
// not *.test.js, deliberately: it needs a real Miniflux server and would fail
// in CI. Run by hand against a local instance:  node tests/live-miniflux.js
// Reads MINIFLUX_URL / MINIFLUX_TOKEN from ~/secrets/miniflux.env.
// This is the check that caught mark-as-read being broken since 2.3.3; the
// unit tests could not, because the argv was well-formed and the SERVER
// rejected it.
// End-to-end check of the Phase 0 Miniflux backend against a REAL Miniflux
// server, by executing the exact argv Backends.js generates. Nothing here
// hand-writes a request: every curl invocation comes from the module.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const REPO = require("node:path").join(__dirname, "..");
const FeedParser = require(REPO + "/FeedParser.js");
const ReaderState = require(REPO + "/ReaderState.js");
const { createBackends } = require(REPO + "/Backends.js");

const env = Object.fromEntries(
  fs.readFileSync(process.env.HOME + "/secrets/miniflux.env", "utf8")
    .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const config = {
  minifluxUrl: env.MINIFLUX_URL,
  minifluxToken: env.MINIFLUX_TOKEN,
  maxItems: 20,
  showStarred: false
};

const backend = createBackends({ FeedParser, ReaderState }).miniflux;

function run(req) {
  if (!req) return null;
  const out = execFileSync(req.argv[0], req.argv.slice(1), {
    encoding: "utf8", timeout: req.timeoutMs || 30000
  });
  return req.parse(out);
}

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) fail++;
}

console.log("configState:", JSON.stringify(backend.configState(config)));
check("configState ok", backend.configState(config).ok);

const reqs = backend.fetchRequests(config);
check("fetchRequests returns exactly one descriptor", reqs.length === 1, "got " + reqs.length);
check("descriptor carries the 30s Proc timeout", reqs[0].timeoutMs === 30000, String(reqs[0].timeoutMs));
check("token occupies exactly one argv element",
  reqs[0].argv.filter(a => a.includes(env.MINIFLUX_TOKEN)).length === 1);

const res = run(reqs[0]);
check("fetch parsed without error", res && !res.error, res && res.error);
check("fetch returned items", res && res.items && res.items.length > 0, res && res.items && ("n=" + res.items.length));

const first = res.items[0];
console.log("  sample item:", JSON.stringify(first.title).slice(0, 66), "| id:", first.id, "| source:", first.source);
check("ids carry the m: prefix", String(first.id).startsWith("m:"), String(first.id));
check("serverStatus is populated", Array.isArray(res.serverStatus) && res.serverStatus.length > 0);

// --- mutate on the server, then read it back through a second fetch ---
const numericId = String(first.id).slice(2);

run(backend.markReadRequest(config, [numericId]));
let after = run(backend.fetchRequests(config)[0]);
let stillThere = after.items.some(i => i.id === first.id);
check("markRead removed the item from the unread feed", !stillThere);

run(backend.markUnreadRequest(config, [numericId]));
after = run(backend.fetchRequests(config)[0]);
check("markUnread put it back", after.items.some(i => i.id === first.id));

run(backend.toggleStarRequest(config, numericId));
const starred = run(backend.fetchRequests({ ...config, showStarred: true })[0]);
check("toggleStar starred it server-side", starred.items.some(i => i.id === first.id),
  "starred n=" + starred.items.length);

run(backend.toggleStarRequest(config, numericId));
const unstarred = run(backend.fetchRequests({ ...config, showStarred: true })[0]);
check("toggleStar again unstarred it", !unstarred.items.some(i => i.id === first.id));

console.log(fail === 0 ? "\nALL LIVE CHECKS PASSED" : "\n*** " + fail + " FAILED ***");
process.exit(fail === 0 ? 0 : 1);
