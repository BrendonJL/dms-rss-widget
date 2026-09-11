import QtQml
import "AiProvider.js" as AiProvider

QtObject {
    Component.onCompleted: {
        var code = 40;                       // 40 = never got started
        try {
            var provider = AiProvider.createAiProvider({
                label: "Ollama", baseUrl: "http://localhost:11434/v1",
                model: "qwen3:8b", apiKey: "SEKRET-KEY", timeoutMs: 5000
            });
            code = 41;                       // 41 = factory returned wrong shape
            if (!provider || !provider.isConfigured || !provider.probeRequest ||
                !provider.summariseRequest || !provider.digestRequest) { Qt.exit(code); return; }

            code = 42;                       // 42 = isConfigured wrong
            if (provider.isConfigured() !== true) { Qt.exit(code); return; }

            code = 43;                       // 43 = probeRequest wrong shape
            var probe = provider.probeRequest();
            if (!probe || !probe.argv || !probe.parse) { Qt.exit(code); return; }

            code = 44;                       // 44 = apiKey leaked outside its own argv element
            var hits = 0;
            for (var i = 0; i < probe.argv.length; i++)
                if (String(probe.argv[i]).indexOf("SEKRET-KEY") !== -1) hits++;
            if (hits !== 1) { Qt.exit(code); return; }

            code = 45;                       // 45 = summariseRequest wrong / parse threw
            var summarise = provider.summariseRequest({ title: "T", description: "D" });
            if (!summarise || !summarise.argv || !summarise.parse) { Qt.exit(code); return; }
            var parsed = summarise.parse(JSON.stringify({
                choices: [{ message: { role: "assistant", content: "ok", reasoning: "should be ignored" } }]
            }));
            if (!parsed || parsed.text !== "ok" || parsed.error !== null) { Qt.exit(code); return; }

            code = 46;                       // 46 = digestRequest wrong / null on non-empty items
            var digest = provider.digestRequest([{ title: "A" }, { title: "B" }]);
            if (!digest || !digest.argv || !digest.parse) { Qt.exit(code); return; }

            code = 47;                       // 47 = PRESETS table missing/wrong
            if (!AiProvider.PRESETS || !AiProvider.PRESETS.ollama ||
                AiProvider.PRESETS.ollama.baseUrl !== "http://localhost:11434/v1") { Qt.exit(code); return; }

            Qt.exit(55);                     // 55 = full chain worked
        } catch (e) {
            Qt.exit(60);                     // 60 = threw
        }
    }
}
