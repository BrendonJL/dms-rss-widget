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

            var req = b.miniflux.fetchRequest({
                minifluxUrl: "https://mf.example.com",
                minifluxToken: "SEKRET-TOKEN",
                maxItems: 20, showStarred: false
            });
            code = 43;                       // 43 = no request descriptor
            if (!req || !req.argv || !req.parse) { Qt.exit(code); return; }

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

            Qt.exit(55);                     // 55 = full chain worked
        } catch (e) {
            Qt.exit(60);                     // 60 = threw
        }
    }
}
