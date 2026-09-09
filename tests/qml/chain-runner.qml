import QtQml
import "ChainRunner.js" as ChainRunner

QtObject {
    Component.onCompleted: {
        var code = 40; // 40 = never got started
        try {
            var head = { argv: ["curl", "head"] };

            // 1-link chain: immediate done.
            var c1 = ChainRunner.createChain(head, 5);
            var r1 = c1.step({ items: [{ id: "r:1" }], serverStatus: [], error: null, nextRequest: null, session: { authToken: "a", postToken: "p" } });
            code = 41; // 41 = 1-link chain did not terminate "done" correctly
            if (r1.action !== "done" || r1.items.length !== 1 || r1.items[0].id !== "r:1") { Qt.exit(code); return; }
            if (!r1.session || r1.session.authToken !== "a") { Qt.exit(code); return; }

            // 4-link chain (Google Reader cold start): next, next, next, done.
            var c2 = ChainRunner.createChain(head, 5);
            var n1 = c2.step({ items: [], serverStatus: [], error: null, nextRequest: { id: "token" }, session: { authToken: "a", postToken: null } });
            code = 42; // 42 = link 1->2 wrong
            if (n1.action !== "next" || n1.request.id !== "token") { Qt.exit(code); return; }

            var n2 = c2.step({ items: [], serverStatus: [], error: null, nextRequest: { id: "ids" }, session: { authToken: "a", postToken: "p" } });
            code = 43; // 43 = link 2->3 wrong
            if (n2.action !== "next" || n2.request.id !== "ids") { Qt.exit(code); return; }

            var n3 = c2.step({ items: [], serverStatus: [], error: null, nextRequest: { id: "contents" }, session: { authToken: "a", postToken: "p" } });
            code = 44; // 44 = link 3->4 wrong
            if (n3.action !== "next" || n3.request.id !== "contents") { Qt.exit(code); return; }

            var n4 = c2.step({ items: [{ id: "r:46" }], serverStatus: [], error: null, nextRequest: null, session: { authToken: "a", postToken: "p" } });
            code = 45; // 45 = final link did not terminate "done"
            if (n4.action !== "done" || n4.items.length !== 1) { Qt.exit(code); return; }

            // error mid-chain terminates the whole chain.
            var c3 = ChainRunner.createChain(head, 5);
            c3.step({ items: [], serverStatus: [], error: null, nextRequest: { id: "x" }, session: null });
            var eResult = c3.step({ items: [], serverStatus: [], error: "boom", nextRequest: null, session: null });
            code = 46; // 46 = mid-chain error not surfaced as "error"
            if (eResult.action !== "error" || eResult.error !== "boom") { Qt.exit(code); return; }

            // exceeding the cap returns error, never next.
            var c4 = ChainRunner.createChain(head, 1);
            var capResult = c4.step({ items: [], serverStatus: [], error: null, nextRequest: { id: "too far" }, session: null });
            code = 47; // 47 = cap exceeded did not return "error"
            if (capResult.action !== "error") { Qt.exit(code); return; }

            // step() after a terminal result throws.
            code = 48; // 48 = step() after terminal did NOT throw
            var threw = false;
            try {
                c1.step({ items: [], serverStatus: [], error: null, nextRequest: null, session: null });
            } catch (e) {
                threw = true;
            }
            if (!threw) { Qt.exit(code); return; }

            // null/malformed parsed is an error, not a crash.
            var c5 = ChainRunner.createChain(head, 5);
            var badResult = c5.step(null);
            code = 49; // 49 = null parsed crashed or was not "error"
            if (badResult.action !== "error") { Qt.exit(code); return; }

            Qt.exit(55); // 55 = everything worked
        } catch (e) {
            Qt.exit(60); // 60 = threw somewhere unexpected
        }
    }
}
