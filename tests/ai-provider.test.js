const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
    createAiProvider,
    PRESETS
} = require("../AiProvider.js");

function baseConfig(overrides) {
    return Object.assign({
        label: "Ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        apiKey: "",
        timeoutMs: null
    }, overrides || {});
}

// ─── PRESETS ───

describe("PRESETS", () => {
    test("ships a table with the five documented runtimes", () => {
        assert.ok(PRESETS.ollama);
        assert.ok(PRESETS.vllm);
        assert.ok(PRESETS.llamacpp);
        assert.ok(PRESETS.lmstudio);
        assert.ok(PRESETS.custom);
    });

    test("ollama preset matches the measured baseUrl", () => {
        assert.equal(PRESETS.ollama.baseUrl, "http://localhost:11434/v1");
        assert.equal(PRESETS.ollama.label, "Ollama");
    });

    test("vLLM preset matches the documented baseUrl", () => {
        assert.equal(PRESETS.vllm.baseUrl, "http://localhost:8000/v1");
    });

    test("LM Studio preset matches the documented baseUrl", () => {
        assert.equal(PRESETS.lmstudio.baseUrl, "http://localhost:1234/v1");
    });

    test("custom preset has an empty baseUrl for the user to fill in", () => {
        assert.equal(PRESETS.custom.baseUrl, "");
    });
});

// ─── isConfigured ───

describe("isConfigured", () => {
    test("true when baseUrl and model are both set", () => {
        assert.equal(createAiProvider(baseConfig()).isConfigured(), true);
    });

    test("false when baseUrl is missing", () => {
        assert.equal(createAiProvider(baseConfig({ baseUrl: "" })).isConfigured(), false);
    });

    test("false when model is missing", () => {
        assert.equal(createAiProvider(baseConfig({ model: "" })).isConfigured(), false);
    });

    test("false for null/undefined config", () => {
        assert.equal(createAiProvider(null).isConfigured(), false);
        assert.equal(createAiProvider(undefined).isConfigured(), false);
    });

    test("apiKey is NOT required to be configured (ollama needs none)", () => {
        assert.equal(createAiProvider(baseConfig({ apiKey: "" })).isConfigured(), true);
    });
});

// ─── probeRequest ───

describe("probeRequest", () => {
    test("GET {baseUrl}/models, no body, no -d", () => {
        var provider = createAiProvider(baseConfig());
        var req = provider.probeRequest();
        assert.ok(req);
        assert.ok(Array.isArray(req.argv));
        assert.equal(req.argv[req.argv.length - 1], "http://localhost:11434/v1/models");
        assert.equal(req.argv.indexOf("-d"), -1);
        var xIdx = req.argv.indexOf("-X");
        assert.equal(req.argv[xIdx + 1], "GET");
    });

    test("returns null when not configured", () => {
        assert.equal(createAiProvider(baseConfig({ baseUrl: "" })).probeRequest(), null);
    });

    test("parse: reachable, model present", () => {
        var provider = createAiProvider(baseConfig({ model: "qwen3:8b" }));
        var req = provider.probeRequest();
        var body = JSON.stringify({
            object: "list",
            data: [{ id: "qwen3:8b", object: "model" }, { id: "qwen2.5-coder:7b", object: "model" }]
        });
        var result = req.parse(body);
        assert.equal(result.reachable, true);
        assert.equal(result.hasModel, true);
        assert.deepEqual(result.models, ["qwen3:8b", "qwen2.5-coder:7b"]);
        assert.equal(result.error, null);
    });

    test("parse: reachable, model absent from the list", () => {
        var provider = createAiProvider(baseConfig({ model: "not-installed" }));
        var req = provider.probeRequest();
        var result = req.parse(JSON.stringify({ object: "list", data: [{ id: "qwen3:8b" }] }));
        assert.equal(result.reachable, true);
        assert.equal(result.hasModel, false);
    });

    test("parse: malformed JSON", () => {
        var provider = createAiProvider(baseConfig());
        var result = provider.probeRequest().parse("not json");
        assert.equal(result.reachable, false);
        assert.equal(result.hasModel, false);
        assert.deepEqual(result.models, []);
        assert.equal(typeof result.error, "string");
    });

    test("parse: empty stdout (connection refused / no runtime)", () => {
        var provider = createAiProvider(baseConfig());
        var result = provider.probeRequest().parse("");
        assert.equal(result.reachable, false);
        assert.equal(result.hasModel, false);
    });
});

// ─── summariseRequest ───

describe("summariseRequest", () => {
    var article = { title: "Big Thing Happens", description: "A thing happened somewhere and it was notable." };

    test("POST {baseUrl}/chat/completions", () => {
        var provider = createAiProvider(baseConfig());
        var req = provider.summariseRequest(article);
        assert.ok(req);
        assert.equal(req.argv[req.argv.length - 1], "http://localhost:11434/v1/chat/completions");
        var xIdx = req.argv.indexOf("-X");
        assert.equal(req.argv[xIdx + 1], "POST");
        assert.notEqual(req.argv.indexOf("-d"), -1);
    });

    test("body includes the article title and description, and the configured model", () => {
        var provider = createAiProvider(baseConfig());
        var req = provider.summariseRequest(article);
        var body = JSON.parse(req.argv[req.argv.indexOf("-d") + 1]);
        assert.equal(body.model, "qwen2.5-coder:7b");
        assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
        var joined = JSON.stringify(body.messages);
        assert.ok(joined.indexOf(article.title) !== -1);
        assert.ok(joined.indexOf(article.description) !== -1);
    });

    test("does NOT emit /no_think or chat_template_kwargs.enable_thinking (measured: neither has any effect through ollama's OpenAI shim)", () => {
        var provider = createAiProvider(baseConfig());
        var req = provider.summariseRequest(article);
        var rawBody = req.argv[req.argv.indexOf("-d") + 1];
        assert.equal(rawBody.indexOf("no_think"), -1);
        assert.equal(rawBody.indexOf("enable_thinking"), -1);
        assert.equal(rawBody.indexOf("chat_template_kwargs"), -1);
    });

    test("returns null when not configured", () => {
        assert.equal(createAiProvider(baseConfig({ model: "" })).summariseRequest(article), null);
    });

    test("returns null when article is missing", () => {
        assert.equal(createAiProvider(baseConfig()).summariseRequest(null), null);
    });

    test("parse: normal response reads choices[0].message.content", () => {
        var provider = createAiProvider(baseConfig());
        var body = JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Two sentence summary here." }, finish_reason: "stop" }],
            usage: { total_tokens: 42 }
        });
        var result = provider.summariseRequest(article).parse(body);
        assert.equal(result.text, "Two sentence summary here.");
        assert.equal(result.error, null);
    });

    test("parse: reasoning-model response uses content, ignores the separate reasoning field", () => {
        // Verified against this machine's ollama (qwen3:8b): reasoning output
        // lives in message.reasoning, message.content stays clean. Do not
        // strip <think> tags -- there is nothing to strip here.
        var provider = createAiProvider(baseConfig());
        var body = JSON.stringify({
            choices: [{
                message: {
                    role: "assistant",
                    content: "The clean final answer.",
                    reasoning: "Let me think step by step about how to phrase this... <think> internal chatter </think>"
                },
                finish_reason: "stop"
            }]
        });
        var result = provider.summariseRequest(article).parse(body);
        assert.equal(result.text, "The clean final answer.");
        assert.equal(result.text.indexOf("think"), -1);
        assert.equal(result.error, null);
    });

    test("parse: empty choices array", () => {
        var provider = createAiProvider(baseConfig());
        var result = provider.summariseRequest(article).parse(JSON.stringify({ choices: [] }));
        assert.equal(result.text, null);
        assert.equal(typeof result.error, "string");
    });

    test("parse: malformed JSON", () => {
        var provider = createAiProvider(baseConfig());
        var result = provider.summariseRequest(article).parse("{not json");
        assert.equal(result.text, null);
        assert.equal(typeof result.error, "string");
    });

    test("parse: HTTP error body (OpenAI-shaped error object, verified against live ollama for an unknown model)", () => {
        var provider = createAiProvider(baseConfig());
        var body = JSON.stringify({ error: { message: "model 'nonexistent-model' not found", type: "not_found_error", param: null, code: null } });
        var result = provider.summariseRequest(article).parse(body);
        assert.equal(result.text, null);
        assert.ok(result.error.indexOf("not found") !== -1);
    });

    test("parse: content is an empty string is not an error -- caller decides what to do with a blank summary", () => {
        var provider = createAiProvider(baseConfig());
        var body = JSON.stringify({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
        var result = provider.summariseRequest(article).parse(body);
        assert.equal(result.text, "");
        assert.equal(result.error, null);
    });
});

// ─── digestRequest ───

describe("digestRequest", () => {
    var items = [
        { title: "Item One", description: "First description." },
        { title: "Item Two", description: "Second description." }
    ];

    test("POST {baseUrl}/chat/completions, one descriptor over many items", () => {
        var provider = createAiProvider(baseConfig());
        var req = provider.digestRequest(items);
        assert.ok(req);
        assert.equal(req.argv[req.argv.length - 1], "http://localhost:11434/v1/chat/completions");
        var body = JSON.parse(req.argv[req.argv.indexOf("-d") + 1]);
        var joined = JSON.stringify(body.messages);
        assert.ok(joined.indexOf("Item One") !== -1);
        assert.ok(joined.indexOf("Item Two") !== -1);
    });

    test("returns null for an empty or missing item list", () => {
        var provider = createAiProvider(baseConfig());
        assert.equal(provider.digestRequest([]), null);
        assert.equal(provider.digestRequest(null), null);
    });

    test("returns null when not configured", () => {
        assert.equal(createAiProvider(baseConfig({ baseUrl: "" })).digestRequest(items), null);
    });

    test("parse behaves like summariseRequest.parse (same response shape)", () => {
        var provider = createAiProvider(baseConfig());
        var body = JSON.stringify({ choices: [{ message: { content: "Digest text." } }] });
        var result = provider.digestRequest(items).parse(body);
        assert.equal(result.text, "Digest text.");
        assert.equal(result.error, null);
    });
});

// ─── SECURITY: apiKey never concatenated into a larger string ───

describe("SECURITY: apiKey isolation in argv", () => {
    var KEY = "sk-9f3a-DO-NOT-LEAK";
    var article = { title: "T", description: "D" };
    var items = [{ title: "T", description: "D" }];

    function assertKeyIsolated(argv) {
        assert.ok(Array.isArray(argv), "argv must be an array, never a joined command string");

        var withKey = argv.filter(function (el) { return el.indexOf(KEY) !== -1; });
        assert.equal(withKey.length, 1, "apiKey must appear in exactly one argv element");
        assert.equal(withKey[0], "Authorization: Bearer " + KEY,
            "the apiKey's argv element must be exactly its header value, never merged with the url/method/body");

        for (var i = 0; i < argv.length; i++) {
            if (argv[i] === withKey[0]) continue;
            assert.equal(argv[i].indexOf(KEY), -1, "apiKey leaked into an unrelated argv element: " + argv[i]);
        }
    }

    test("probeRequest isolates the apiKey", () => {
        var provider = createAiProvider(baseConfig({ apiKey: KEY }));
        assertKeyIsolated(provider.probeRequest().argv);
    });

    test("summariseRequest isolates the apiKey", () => {
        var provider = createAiProvider(baseConfig({ apiKey: KEY }));
        assertKeyIsolated(provider.summariseRequest(article).argv);
    });

    test("digestRequest isolates the apiKey", () => {
        var provider = createAiProvider(baseConfig({ apiKey: KEY }));
        assertKeyIsolated(provider.digestRequest(items).argv);
    });

    test("a key containing shell metacharacters is still a single opaque argv element", () => {
        var nasty = "abc$(rm -rf /);`echo pwned`;\" ' &";
        var provider = createAiProvider(baseConfig({ apiKey: nasty }));
        var argv = provider.summariseRequest(article).argv;
        assert.ok(Array.isArray(argv));
        assert.ok(argv.indexOf("Authorization: Bearer " + nasty) !== -1);
    });

    test("no Authorization header at all when apiKey is empty (ollama/local runtimes need none)", () => {
        var provider = createAiProvider(baseConfig({ apiKey: "" }));
        var argv = provider.summariseRequest(article).argv;
        var hasAuthHeader = argv.some(function (el) { return typeof el === "string" && el.indexOf("Authorization:") === 0; });
        assert.equal(hasAuthHeader, false);
    });
});

// ─── LIVE, opt-in: actually calls localhost:11434, skips cleanly otherwise ───
//
// Recorded fixtures rot silently against a real API; this test exercises the
// real endpoint when a runtime happens to be running here, and skips (never
// fails) when nothing answers -- so CI, which has no runtime, stays green.

describe("LIVE ollama (opt-in, self-skipping)", () => {
    function pingOllama() {
        return new Promise(function (resolve) {
            var req = http.get("http://localhost:11434/v1/models", { timeout: 1000 }, function (res) {
                var data = "";
                res.on("data", function (chunk) { data += chunk; });
                res.on("end", function () { resolve({ up: true, status: res.statusCode, body: data }); });
            });
            req.on("error", function () { resolve({ up: false }); });
            req.on("timeout", function () { req.destroy(); resolve({ up: false }); });
        });
    }

    test("probeRequest against a real ollama, or skip if nothing is listening on 11434", async (t) => {
        var ping = await pingOllama();
        if (!ping.up) {
            t.skip("no runtime reachable on localhost:11434");
            return;
        }

        var provider = createAiProvider({
            label: "Ollama", baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5-coder:7b", apiKey: "", timeoutMs: 5000
        });
        var result = provider.probeRequest().parse(ping.body);
        assert.equal(result.reachable, true);
        assert.ok(Array.isArray(result.models) && result.models.length > 0);
    });

    test("summariseRequest against a real ollama with a fast non-reasoning model, or skip", async (t) => {
        var ping = await pingOllama();
        if (!ping.up) {
            t.skip("no runtime reachable on localhost:11434");
            return;
        }

        var provider = createAiProvider({
            label: "Ollama", baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5-coder:7b", apiKey: "", timeoutMs: 30000
        });
        var article = {
            title: "Local test article",
            description: "This is a short local test paragraph used only to confirm the live chat/completions round trip works end to end against a real ollama instance."
        };
        var req = provider.summariseRequest(article);
        var bodyStr = req.argv[req.argv.indexOf("-d") + 1];

        var stdout = await new Promise(function (resolve, reject) {
            var httpReq = http.request("http://localhost:11434/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                timeout: 30000
            }, function (res) {
                var data = "";
                res.on("data", function (chunk) { data += chunk; });
                res.on("end", function () { resolve(data); });
            });
            httpReq.on("error", reject);
            httpReq.on("timeout", function () { httpReq.destroy(); reject(new Error("timeout")); });
            httpReq.write(bodyStr);
            httpReq.end();
        });

        var result = req.parse(stdout);
        assert.equal(result.error, null);
        assert.equal(typeof result.text, "string");
        assert.ok(result.text.length > 0, "expected a non-empty summary from the live model");
    });

    // Shape-only: a model's prose is not a fixture, so this never asserts on
    // wording. It exercises summariseRequest end-to-end against a real,
    // fast, non-reasoning model and confirms parse() reads message.content
    // ONLY -- an actual separate message.reasoning field (if the runtime
    // sends one) must never end up concatenated into result.text.
    test("summariseRequest against real ollama: result.text is clean, message.reasoning (if any) is not folded in, or skip", { timeout: 20000 }, async (t) => {
        var ping = await pingOllama();
        if (!ping.up) {
            t.skip("no runtime reachable on localhost:11434");
            return;
        }

        var provider = createAiProvider({
            label: "Ollama", baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5-coder:7b", apiKey: "", timeoutMs: 15000
        });
        var article = {
            title: "Small fixture article",
            description: "A short paragraph about a cat that sat on a mat, used only to give the model something brief to summarise."
        };
        var req = provider.summariseRequest(article);
        var bodyStr = req.argv[req.argv.indexOf("-d") + 1];

        var stdout = await new Promise(function (resolve, reject) {
            var httpReq = http.request("http://localhost:11434/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                timeout: 15000
            }, function (res) {
                var data = "";
                res.on("data", function (chunk) { data += chunk; });
                res.on("end", function () { resolve(data); });
            });
            httpReq.on("error", reject);
            httpReq.on("timeout", function () { httpReq.destroy(); reject(new Error("timeout")); });
            httpReq.write(bodyStr);
            httpReq.end();
        });

        var result = req.parse(stdout);
        assert.equal(result.error, null, "expected no error from a live, reachable, correctly-modeled request");
        assert.equal(typeof result.text, "string");
        assert.ok(result.text.length > 0, "expected a non-empty summary from the live model");

        // Independently re-parse the raw response to see what the runtime
        // actually sent, then check parse()'s output against it directly --
        // this is what would catch a regression that concatenates reasoning
        // into content.
        var raw = JSON.parse(stdout);
        var message = (raw.choices && raw.choices[0] && raw.choices[0].message) || {};
        assert.equal(result.text, message.content, "result.text must be exactly message.content, nothing appended");
        if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
            assert.equal(result.text.indexOf(message.reasoning), -1,
                "message.reasoning must never be concatenated into the summary text");
        }
    });
});

// The argv tests above assert structure (method, url, body) but would not
// notice a dropped hardening flag -- exactly the class of silent security
// regression that has no other tripwire. Assert the set explicitly.
describe("SECURITY: curl hardening flags", () => {
    var provider = createAiProvider({
        baseUrl: "http://localhost:11434/v1", model: "m"
    });

    function flagPairs(argv) {
        var seen = {};
        for (var i = 0; i < argv.length - 1; i++)
            if (String(argv[i]).indexOf("--") === 0)
                seen[argv[i]] = argv[i + 1];
        return seen;
    }

    [
        ["probe", function () { return provider.probeRequest(); }],
        ["summarise", function () { return provider.summariseRequest({ title: "t", description: "d" }); }],
        ["digest", function () { return provider.digestRequest([{ title: "t", description: "d" }]); }]
    ].forEach(function (pair) {
        test(pair[0] + " carries the hardening flags", () => {
            var f = flagPairs(pair[1]().argv);
            assert.equal(f["--connect-timeout"], "5");
            assert.equal(f["--proto"], "=http,https");
            assert.equal(f["--proto-redir"], "=http,https");
            assert.equal(f["--max-filesize"], "5000000");
            assert.ok(f["--max-time"], "--max-time must always be set");
        });
    });

    // Redirects are deliberately NOT followed on an authenticated endpoint:
    // curl re-sends an explicit -H across a cross-host redirect, which would
    // hand the API key to whatever host the redirect names.
    test("no -L on any request", () => {
        [provider.probeRequest(), provider.summariseRequest({ title: "t", description: "d" })]
            .forEach(function (req) {
                assert.equal(req.argv.indexOf("-L"), -1, "-L would leak the apiKey across a redirect");
            });
    });

    test("probe uses a short timeout, not the generation-sized default", () => {
        var argv = provider.probeRequest().argv;
        assert.equal(argv[argv.indexOf("--max-time") + 1], "8");
    });
});

// ─── resolveBaseUrl ───
//
// Regression cover for a shipped bug: the settings panel filled the base URL
// from the preset dropdown's CHANGE handler, so on a fresh install -- where
// the dropdown loads its default and therefore never changes -- nothing was
// ever written. The field showed a placeholder that looked exactly like a
// value, and Test Connection reported "enter a base URL and model" against
// what the user could see was a filled form. Resolution must not depend on
// an event having fired.

describe("resolveBaseUrl", () => {
    const { resolveBaseUrl, PRESETS } = require("../AiProvider.js");

    test("a preset resolves even when nothing was ever typed or stored", () => {
        assert.equal(resolveBaseUrl("ollama", ""), "http://localhost:11434/v1");
        assert.equal(resolveBaseUrl("ollama", undefined), "http://localhost:11434/v1");
        assert.equal(resolveBaseUrl("ollama", null), "http://localhost:11434/v1");
    });

    test("every non-custom preset resolves to its own documented base URL", () => {
        Object.keys(PRESETS).forEach(function (key) {
            assert.equal(resolveBaseUrl(key, ""), PRESETS[key].baseUrl, key);
        });
    });

    test("an explicitly typed URL always wins over the preset", () => {
        assert.equal(resolveBaseUrl("ollama", "http://gpu-box:9999/v1"), "http://gpu-box:9999/v1");
    });

    test("custom resolves to empty, because there is nothing sensible to guess", () => {
        assert.equal(resolveBaseUrl("custom", ""), "");
    });

    test("custom still honours whatever the user typed", () => {
        assert.equal(resolveBaseUrl("custom", "http://10.0.0.5:8000/v1"), "http://10.0.0.5:8000/v1");
    });

    test("whitespace-only input counts as empty and falls back to the preset", () => {
        assert.equal(resolveBaseUrl("ollama", "   "), "http://localhost:11434/v1");
    });

    test("surrounding whitespace is trimmed off a real URL", () => {
        assert.equal(resolveBaseUrl("ollama", "  http://localhost:1234/v1  "), "http://localhost:1234/v1");
    });

    test("an unknown or missing preset resolves to empty rather than throwing", () => {
        assert.equal(resolveBaseUrl("nonesuch", ""), "");
        assert.equal(resolveBaseUrl(undefined, ""), "");
        assert.equal(resolveBaseUrl(null, null), "");
    });

    test("the resolved preset URL is enough to make a provider configured", () => {
        const { createAiProvider } = require("../AiProvider.js");
        const p = createAiProvider({ baseUrl: resolveBaseUrl("ollama", ""), model: "qwen3:8b" });
        assert.equal(p.isConfigured(), true);
    });
});
