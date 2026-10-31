import QtQml
import "EnvFile.js" as EnvFile

QtObject {
    Component.onCompleted: {
        var code = 30; // 30 = never got started
        try {
            var env = EnvFile.parse("# c\nexport MINIFLUX_TOKEN=\"tok\"\r\nGREADER_PASSWORD=pw\n");
            code = 31; // 31 = parse result wrong under QML
            if (env.MINIFLUX_TOKEN !== "tok" || env.GREADER_PASSWORD !== "pw") { Qt.exit(code); return; }

            var r = EnvFile.resolveCredentials({ greaderUsername: "u", greaderPassword: "s" }, env);
            code = 32; // 32 = file did not win per key
            if (r.minifluxToken !== "tok" || r.greaderPassword !== "pw" || r.sources.greaderUsername !== "settings") { Qt.exit(code); return; }

            code = 33; // 33 = expandHome wrong under QML
            if (EnvFile.expandHome("~/a.env", "/h") !== "/h/a.env") { Qt.exit(code); return; }

            Qt.exit(55);
        } catch (e) {
            Qt.exit(60); // 60 = threw somewhere unexpected
        }
    }
}
