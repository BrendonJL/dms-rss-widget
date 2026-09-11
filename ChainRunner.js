// Chain runner for the Dank RSS Widget.
//
// See README.md's "Architecture" section for the QML/Node dual-load
// mechanism and the `.pragma library` rule (kept once, in FeedParser.js).
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness. Full context: docs/plans/2026-09-09-phase1-google-reader-
// design.md, "Stage 1b addendum -- the QML runner".
//
// GoogleReader.js's fetchRequests() returns only the HEAD of a chain; each
// link's parse() may hand back a `nextRequest` instead of finishing. This
// module chases that chain and decides exactly once when it is over, so
// that arithmetic doesn't have to live in DankRssWidget.qml (which
// `node --test` cannot execute). The caller (QML) owns running curl and
// calling `descriptor.parse(stdout)`; this module only ever sees the
// resulting plain object ("parsed"). Usage:
//
//   var chain = ChainRunner.createChain(headDescriptor, 5);
//   var result = chain.step(parsedResult);
//   if (result.action === "next") {
//       // run result.request.argv, parse it, call chain.step() again --
//       // do NOT touch the pending counter.
//   } else {
//       // "done" or "error" -- decrement the pending counter EXACTLY ONCE.
//   }

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
            // A chain returns exactly ONE terminal result ("done"/"error")
            // across its life -- enforced here, not just tested. Replaying
            // the cached result on a repeat call was rejected: it would let
            // a caller that already decremented its pending counter call
            // step() again (a bug) and silently double-decrement instead of
            // throwing loudly.
            if (terminated)
                throw new Error("ChainRunner: step() called after a terminal result was already returned");

            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                return terminalResult("error", { error: "ChainRunner: malformed parse result" });

            if (parsed.session && typeof parsed.session === "object")
                session = parsed.session;

            if (parsed.error)
                return terminalResult("error", { error: parsed.error });

            if (parsed.nextRequest) {
                // A chain that exceeds `cap` (default 5, matching
                // GoogleReader.js's own MAX_CHAIN_LINKS) terminates with
                // "error", never "next" -- so a server that keeps handing
                // back nextRequest forever cannot loop QML, and QML needs no
                // link-count arithmetic of its own.
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
