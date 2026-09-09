// Chain runner for the Dank RSS Widget (Phase 1, stage 1b).
//
// Shared, like Backends.js/FeedParser.js/ReaderState.js/GoogleReader.js,
// between QML and the Node test suite:
//   QML  : import "ChainRunner.js" as ChainRunner
//   Node : require("./ChainRunner.js")
//
// IMPORTANT: no `.pragma library` line here -- it is invalid JavaScript and
// would break `require()` in the tests.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness. See docs/plans/2026-09-09-phase1-google-reader-design.md,
// "Stage 1b addendum -- the QML runner".
//
// ─── Why this module exists ────────────────────────────────────────────────
//
// GoogleReader.js's fetchRequests() returns the HEAD of a chain; each link's
// `parse()` may hand back a `nextRequest` instead of finishing. Chasing that
// chain -- and, critically, deciding exactly once when it is over -- is
// arithmetic that would otherwise live in DankRssWidget.qml, which cannot be
// executed by `node --test`. So it lives here instead, where it can be.
//
// The caller (QML) owns running curl and calling `descriptor.parse(stdout)`;
// this module only ever sees the resulting plain object ("parsed"). Usage:
//
//   var chain = ChainRunner.createChain(headDescriptor, 5);
//   // ... QML runs headDescriptor.argv, gets stdout, calls parse(stdout) ...
//   var result = chain.step(parsedResult);
//   if (result.action === "next") {
//       // run result.request.argv, parse it, call chain.step() again --
//       // do NOT touch the pending counter.
//   } else {
//       // "done" or "error" -- decrement the pending counter EXACTLY ONCE.
//   }
//
// ─── The invariant ──────────────────────────────────────────────────────────
//
// A chain returns exactly ONE terminal result ("done" or "error") across its
// life, and this is made structurally true rather than merely tested:
// `terminated` latches the first time step() returns "done" or "error", and
// every step() call after that THROWS instead of computing (or replaying) a
// second terminal result. A caller that has already decremented its pending
// counter once and then calls step() again -- a bug -- gets a loud, immediate
// exception rather than a second terminal result that would silently
// decrement the counter twice and finalise a fetch cycle early on partial
// results. Replaying the cached terminal result was considered and rejected
// for exactly this reason: it would let a double-decrement through silently
// instead of surfacing the caller's mistake.
//
// A chain that exceeds maxLinks (default 5, matching GoogleReader.js's own
// MAX_CHAIN_LINKS) terminates with "error", never "next" -- so QML never
// needs its own link-count arithmetic or its own infinite-loop guard.

var DEFAULT_MAX_LINKS = 5;

function createChain(descriptor, maxLinks) {
    var cap = (typeof maxLinks === "number" && maxLinks > 0) ? maxLinks : DEFAULT_MAX_LINKS;

    // descriptor (the chain's first request) counts as link 1. It is kept
    // only for parity with the documented createChain(descriptor, maxLinks)
    // signature and possible future debugging -- step() does not need its
    // contents, since the caller already has it and runs it itself.
    var linkCount = 1;
    var terminated = false;
    var session = null;

    function terminalResult(action, extra) {
        terminated = true;
        var result = {
            action: action,
            request: null,
            items: [],
            serverStatus: [],
            error: null,
            session: session
        };
        for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key))
                result[key] = extra[key];
        }
        return result;
    }

    return {
        step: function (parsed) {
            if (terminated)
                throw new Error("ChainRunner: step() called after a terminal result was already returned");

            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                return terminalResult("error", { error: "ChainRunner: malformed parse result" });

            if (parsed.session && typeof parsed.session === "object")
                session = parsed.session;

            if (parsed.error)
                return terminalResult("error", { error: parsed.error });

            if (parsed.nextRequest) {
                if (linkCount + 1 > cap)
                    return terminalResult("error", { error: "ChainRunner: chain link limit exceeded" });

                linkCount += 1;
                return {
                    action: "next",
                    request: parsed.nextRequest,
                    items: [],
                    serverStatus: [],
                    error: null,
                    session: session
                };
            }

            return terminalResult("done", {
                items: parsed.items || [],
                serverStatus: parsed.serverStatus || []
            });
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createChain: createChain,
        DEFAULT_MAX_LINKS: DEFAULT_MAX_LINKS
    };
}
