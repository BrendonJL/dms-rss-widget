import QtQml
import "FeedParser.js" as FeedParser
import "ReaderState.js" as ReaderState
import "GoogleReader.js" as GoogleReader
import "Backends.js" as Backends

QtObject {
    Component.onCompleted: {
        var code = 40;                       // 40 = never got started
        try {
            // deps.GoogleReader is the QML-imported module itself, exactly
            // the shape DankRssWidget.qml (stage 1b) will pass -- proves
            // createBackends() registers "greader" via DI, never require().
            var b = Backends.createBackends({ FeedParser: FeedParser, ReaderState: ReaderState, GoogleReader: GoogleReader });
            code = 41;                       // 41 = greader not registered
            if (!b || !b.greader || b.greader.id !== "greader") { Qt.exit(code); return; }

            code = 42;                       // 42 = capabilities missing
            var caps = b.greader.capabilities;
            if (caps.serverState !== true || caps.star !== true || caps.categories !== true) { Qt.exit(code); return; }

            var config = { greaderUrl: "https://gr.example.com", greaderUsername: "u", greaderPassword: "SEKRET-PASS", maxItems: 20, showStarred: false };

            code = 43;                       // 43 = cold-start chain head wrong
            var reqs = b.greader.fetchRequests(config, null);
            if (!reqs || reqs.length !== 1 || !reqs[0].argv || !reqs[0].parse) { Qt.exit(code); return; }
            var req = reqs[0];
            if (req.argv.join(" ").indexOf("/accounts/ClientLogin") === -1) { Qt.exit(44); return; }

            code = 45;                       // 45 = password leaked outside its own argv element
            var hits = 0;
            for (var i = 0; i < req.argv.length; i++)
                if (String(req.argv[i]).indexOf("SEKRET-PASS") !== -1) hits++;
            if (hits !== 1) { Qt.exit(code); return; }

            // THE question: does deps.FeedParser still dispatch from inside the
            // closure two modules deep (GoogleReader.js called from
            // Backends.js), i.e. did the QML namespace survive being passed
            // by value through TWO layers of DI?
            code = 46;                       // 46 = ClientLogin parse threw or returned nothing
            var loginResult = req.parse("Auth=admin/tok\nHTTPSTATUS:200");
            if (!loginResult) { Qt.exit(code); return; }

            code = 47;                       // 47 = chain did not continue to the token link
            if (loginResult.error !== null || !loginResult.nextRequest) { Qt.exit(code); return; }
            if (loginResult.nextRequest.argv.join(" ").indexOf("/reader/api/0/token") === -1) { Qt.exit(code); return; }

            code = 48;                       // 48 = token link parse threw, or didn't reach items/ids
            var tokenResult = loginResult.nextRequest.parse("admin/tok\nHTTPSTATUS:200");
            if (!tokenResult || tokenResult.error !== null || !tokenResult.nextRequest) { Qt.exit(code); return; }
            if (tokenResult.nextRequest.argv.join(" ").indexOf("/reader/api/0/stream/items/ids") === -1) { Qt.exit(code); return; }

            code = 49;                       // 49 = items/ids -> items/contents parse+id-normalisation broke
            var idsResult = tokenResult.nextRequest.parse('{"itemRefs":[{"id":"46"}],"continuation":"1"}\nHTTPSTATUS:200');
            if (!idsResult || idsResult.error !== null || !idsResult.nextRequest) { Qt.exit(code); return; }

            var contentsBody = JSON.stringify({ items: [{
                id: "tag:google.com,2005:reader/item/000000000000002e",
                title: "Hello", canonical: [{ href: "https://x.example/1" }],
                summary: { content: "<p>body</p>" }, published: 1700000000,
                origin: { title: "Feed" }, categories: []
            }]});
            var finalResult = idsResult.nextRequest.parse(contentsBody + "\nHTTPSTATUS:200");
            code = 50;                       // 50 = final item shape/id-normalisation wrong
            if (!finalResult || finalResult.error !== null || finalResult.nextRequest !== null) { Qt.exit(code); return; }
            if (!finalResult.items || finalResult.items.length !== 1 || finalResult.items[0].id !== "r:46" || finalResult.items[0].title !== "Hello") { Qt.exit(code); return; }

            code = 51;                       // 51 = session not reported back on the terminal link
            if (!finalResult.session || finalResult.session.authToken !== "admin/tok" || finalResult.session.postToken !== "admin/tok") { Qt.exit(code); return; }

            code = 52;                       // 52 = configState wrong
            var st = b.greader.configState({});
            if (st.ok !== false || st.reason !== "unconfigured") { Qt.exit(code); return; }
            var stOk = b.greader.configState(config);
            if (stOk.ok !== true || stOk.reason !== null) { Qt.exit(code); return; }

            code = 53;                       // 53 = edit-tag argv wrong
            var session = { authToken: "admin/tok", postToken: "admin/tok" };
            var markReq = b.greader.markReadRequest(config, session, ["46"]);
            if (!markReq || markReq.argv.join(" ").indexOf("/reader/api/0/edit-tag") === -1) { Qt.exit(code); return; }
            if (markReq.argv.indexOf("a=user/-/state/com.google/read") === -1) { Qt.exit(code); return; }

            Qt.exit(55);                     // 55 = full chain worked
        } catch (e) {
            Qt.exit(60);                     // 60 = threw
        }
    }
}
