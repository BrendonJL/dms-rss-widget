import QtQml
import "FeedParser.js" as FeedParser
import "ReaderState.js" as ReaderState
import "Backends.js" as Backends

QtObject {
    Component.onCompleted: {
        var code = 40;                       // 40 = never got started
        try {
            var b = Backends.createBackends({ FeedParser: FeedParser, ReaderState: ReaderState });
            code = 41;                       // 41 = factory returned wrong shape
            if (!b || !b.standard || !b.miniflux) { Qt.exit(code); return; }

            code = 42;                       // 42 = capabilities missing
            if (b.miniflux.capabilities.serverState !== true) { Qt.exit(code); return; }

            var reqs = b.miniflux.fetchRequests({
                minifluxUrl: "https://mf.example.com",
                minifluxToken: "SEKRET-TOKEN",
                maxItems: 20, showStarred: false
            });
            code = 43;                       // 43 = no request descriptor array
            if (!reqs || reqs.length !== 1 || !reqs[0].argv || !reqs[0].parse) { Qt.exit(code); return; }
            var req = reqs[0];

            code = 44;                       // 44 = token leaked outside its own argv element
            var hits = 0;
            for (var i = 0; i < req.argv.length; i++)
                if (String(req.argv[i]).indexOf("SEKRET-TOKEN") !== -1) hits++;
            if (hits !== 1) { Qt.exit(code); return; }

            // THE question: does deps.FeedParser still dispatch from inside the
            // closure, i.e. did the QML namespace survive being passed by value?
            code = 45;                       // 45 = parse threw or returned nothing
            var parsed = req.parse(JSON.stringify({ total: 1, entries: [{
                id: 42, title: "Hello", url: "https://x.example/1",
                content: "<p>body</p>", published_at: "2026-09-08T00:00:00Z",
                status: "unread", starred: false, feed: { title: "Feed" }, enclosures: []
            }]}));
            if (!parsed) { Qt.exit(code); return; }

            code = 46;                       // 46 = parsed, but not the expected item
            var items = parsed.items || parsed;
            if (!items || items.length !== 1 || items[0].title !== "Hello") { Qt.exit(code); return; }

            code = 47;                       // 47 = miniflux meta should be null
            if (req.meta !== null) { Qt.exit(code); return; }

            code = 48;                       // 48 = miniflux configState wrong
            var mfState = b.miniflux.configState({ minifluxUrl: "", minifluxToken: "x" });
            if (mfState.ok !== false || mfState.reason !== "unconfigured") { Qt.exit(code); return; }
            var mfStateOk = b.miniflux.configState({ minifluxUrl: "https://mf.example.com" });
            if (mfStateOk.ok !== true || mfStateOk.reason !== null) { Qt.exit(code); return; }

            code = 49;                       // 49 = standard fetchRequests array/order/meta wrong
            var stdReqs = b.standard.fetchRequests({ feeds: [
                { url: "https://a.example/f.xml", name: "A" },
                { url: "https://b.example/f.xml", name: "B", enabled: false },
                { url: "https://c.example/f.xml", name: "C" }
            ]});
            if (!stdReqs || stdReqs.length !== 2) { Qt.exit(code); return; }
            if (stdReqs[0].meta.url !== "https://a.example/f.xml" || stdReqs[1].meta.url !== "https://c.example/f.xml") { Qt.exit(code); return; }

            code = 50;                       // 50 = standard configState wrong
            var stdEmpty = b.standard.configState({ feeds: [] });
            if (stdEmpty.ok !== false || stdEmpty.reason !== "unconfigured") { Qt.exit(code); return; }
            var stdAllDisabled = b.standard.configState({ feeds: [{ url: "https://a.example/f.xml", enabled: false }] });
            if (stdAllDisabled.ok !== false || stdAllDisabled.reason !== "empty") { Qt.exit(code); return; }
            var stdOk = b.standard.configState({ feeds: [{ url: "https://a.example/f.xml" }] });
            if (stdOk.ok !== true || stdOk.reason !== null) { Qt.exit(code); return; }

            Qt.exit(55);                     // 55 = full chain worked
        } catch (e) {
            Qt.exit(60);                     // 60 = threw
        }
    }
}
