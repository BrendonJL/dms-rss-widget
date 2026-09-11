import QtQml
import "ExportProvider.js" as ExportProvider

QtObject {
    Component.onCompleted: {
        var code = 40;                       // 40 = never got started
        try {
            var provider = ExportProvider.createExportProvider({
                kind: "obsidian", root: "/home/user/vault", vault: "MyVault",
                filenameTemplate: "{title}", tags: ["news"]
            });
            code = 41;                       // 41 = factory returned wrong shape
            if (!provider || !provider.buildNote || !provider.openRequest || !provider.capabilities) { Qt.exit(code); return; }

            code = 42;                       // 42 = capabilities wrong
            if (provider.capabilities.openAfterWrite !== true || provider.capabilities.wikilinks !== true) { Qt.exit(code); return; }

            code = 43;                       // 43 = hostile title escaped the root / threw
            var result = provider.buildNote({ id: "id-1", title: "../../../.bashrc", link: "https://x/1", source: "Feed", dateStr: "2026-09-08" }, []);
            if (!result || result.error || !result.relPath) { Qt.exit(code); return; }
            if (result.relPath.indexOf("/") !== -1 || result.relPath.indexOf("..") !== -1) { Qt.exit(code); return; }

            code = 44;                       // 44 = YAML frontmatter did not round-trip a hostile title
            var yamlResult = provider.buildNote({ id: "id-2", title: "Breaking: \"News\"", link: "https://x/2", source: "Feed", dateStr: "2026-09-08" }, []);
            if (!yamlResult || yamlResult.error) { Qt.exit(code); return; }
            if (yamlResult.content.indexOf("title: \"Breaking: \\\"News\\\"\"") === -1) { Qt.exit(code); return; }

            code = 45;                       // 45 = collision suffixing broken
            var a = provider.buildNote({ id: "id-a", title: "Same" }, []);
            var b = provider.buildNote({ id: "id-b", title: "Same" }, []);
            if (!a || !b || a.relPath === b.relPath) { Qt.exit(code); return; }

            code = 46;                       // 46 = obsidian wikilink tag missing from body
            var tagResult = provider.buildNote({ id: "id-3", title: "Tagged" }, []);
            if (tagResult.content.indexOf("[[news]]") === -1) { Qt.exit(code); return; }

            code = 47;                       // 47 = openRequest wrong shape
            var open = provider.openRequest(tagResult.relPath);
            if (!open || open.url.indexOf("obsidian://open?vault=MyVault") !== 0) { Qt.exit(code); return; }

            Qt.exit(55);                     // 55 = full chain worked
        } catch (e) {
            Qt.exit(60);                     // 60 = threw
        }
    }
}
