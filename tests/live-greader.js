// NOT part of `node --test tests/*.test.js` -- it is tests/live-greader.js,
// not *.test.js, deliberately: it needs a real Google-Reader-API-enabled
// server and would fail in CI. Run by hand against a local instance:
//   node tests/live-greader.js
// Reads GREADER_USERNAME / GREADER_PASSWORD / MINIFLUX_URL from
// ~/secrets/miniflux.env (Miniflux's Google Reader API integration is
// enabled for user `admin`, with its OWN password, separate from the web
// login password).
//
// Modelled on tests/live-miniflux.js: every curl invocation below comes from
// GoogleReader.js's own argv -- nothing here hand-writes a request. This
// drives the FULL chain end to end: ClientLogin -> token -> items/ids ->
// items/contents, then mark read/unread and star/unstar with server-side
// verification after each mutation, exactly as live-miniflux.js does for
// the Miniflux backend.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const REPO = require("node:path").join(__dirname, "..");
const FeedParser = require(REPO + "/FeedParser.js");
const ReaderState = require(REPO + "/ReaderState.js");
const { createGoogleReaderBackend } = require(REPO + "/GoogleReader.js");

const env = Object.fromEntries(
  fs.readFileSync(process.env.HOME + "/secrets/miniflux.env", "utf8")
    .split("\n").filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const config = {
  greaderUrl: env.MINIFLUX_URL,
  greaderUsername: env.GREADER_USERNAME,
  greaderPassword: env.GREADER_PASSWORD,
  maxItems: 20,
  showStarred: false
};

const backend = createGoogleReaderBackend({ FeedParser, ReaderState });

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) fail++;
}

// Runs one curl argv and hands the raw stdout to the descriptor's own
// parse(). `execFileSync` never sees a nonzero exit here -- these requests
// never use --fail-with-body, so curl always exits 0 and the HTTP status
// lives in the "-w" trailer parse() itself decodes.
function run(descriptor) {
  const out = execFileSync(descriptor.argv[0], descriptor.argv.slice(1), {
    encoding: "utf8", timeout: descriptor.timeoutMs || 30000
  });
  return descriptor.parse(out);
}

// Drives an ENTIRE fetch chain (following nextRequest) to completion,
// exactly like the eventual QML runner will, and returns the terminal
// parse result. Caps at MAX_CHAIN_LINKS + 1 iterations as a test-side
// belt-and-braces guard against this test itself looping if the module
// has a bug.
function runChain(reqs) {
  let result = null;
  let descriptor = reqs[0];
  let guard = 0;
  while (descriptor) {
    if (++guard > 10) throw new Error("live-greader.js: chain did not terminate");
    result = run(descriptor);
    descriptor = result.nextRequest;
  }
  return result;
}

console.log("configState:", JSON.stringify(backend.configState(config)));
check("configState ok", backend.configState(config).ok);

// --- cold start: no session at all, chain must run ClientLogin -> token ->
// items/ids -> items/contents and hand back both tokens ---
let reqs = backend.fetchRequests(config, null);
check("fetchRequests (cold) returns exactly one descriptor (the chain head)", reqs.length === 1, "got " + reqs.length);
check("cold start descriptor is ClientLogin", reqs[0].argv.join(" ").includes("/accounts/ClientLogin"));

let res = runChain(reqs);
check("cold chain completed without error", res && !res.error, res && res.error);
check("cold chain reports back a cached session", !!(res && res.session && res.session.authToken && res.session.postToken));

let session = res.session;

check("fetch returned items", res.items && res.items.length > 0, res.items && ("n=" + res.items.length));
check("serverStatus is populated", Array.isArray(res.serverStatus) && res.serverStatus.length > 0);

const first = res.items[0];
console.log("  sample item:", JSON.stringify(first.title).slice(0, 66), "| id:", first.id, "| source:", first.source);
check("ids carry the r: prefix", String(first.id).startsWith("r:"), String(first.id));

// --- warm start: with a cached session, the chain must skip straight to
// items/ids (no ClientLogin, no token round trip) ---
let warmReqs = backend.fetchRequests(config, session);
check("warm start descriptor skips straight to items/ids", warmReqs[0].argv.join(" ").includes("/reader/api/0/stream/items/ids"));
let warmRes = runChain(warmReqs);
check("warm chain completed without error", warmRes && !warmRes.error, warmRes && warmRes.error);

// --- mutate on the server, then read it back through a second fetch ---
const rawId = String(first.id).slice(2); // strip the "r:" prefix, same convention as Miniflux's "m:"

run(backend.markReadRequest(config, session, [rawId]));
let after = runChain(backend.fetchRequests(config, session));
let stillThere = after.items.some(i => i.id === first.id);
check("markRead removed the item from the unread (xt=read) view", !stillThere);

run(backend.markUnreadRequest(config, session, [rawId]));
after = runChain(backend.fetchRequests(config, session));
check("markUnread put it back in the unread view", after.items.some(i => i.id === first.id));

run(backend.toggleStarRequest(config, session, rawId, false));
let starred = runChain(backend.fetchRequests(Object.assign({}, config, { showStarred: true }), session));
check("toggleStar(false) starred it server-side", starred.items.some(i => i.id === first.id),
  "starred n=" + starred.items.length);

run(backend.toggleStarRequest(config, session, rawId, true));
let unstarred = runChain(backend.fetchRequests(Object.assign({}, config, { showStarred: true }), session));
check("toggleStar(true) unstarred it again", !unstarred.items.some(i => i.id === first.id));

// --- the post-token trap: an edit-tag call the module itself would never
// construct (no cached postToken) so drive the wire format by hand, proving
// the design doc's documented 401-with-no-explanation is still real ---
{
  const argv = [
    "curl", "-sS", "-w", "\nHTTPSTATUS:%{http_code}", "-X", "POST",
    "-H", "Authorization: GoogleLogin auth=" + session.authToken,
    "--data-urlencode", "i=" + rawId,
    "--data-urlencode", "a=user/-/state/com.google/read",
    config.greaderUrl + "/reader/api/0/edit-tag"
  ];
  const out = execFileSync(argv[0], argv.slice(1), { encoding: "utf8" });
  const status = out.slice(out.lastIndexOf("HTTPSTATUS:") + "HTTPSTATUS:".length);
  check("edit-tag without T= (post token) is rejected with 401", status === "401", "status=" + status);
}

console.log(fail === 0 ? "\nALL LIVE CHECKS PASSED" : "\n*** " + fail + " FAILED ***");
process.exit(fail === 0 ? 0 : 1);
