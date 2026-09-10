// Local AI provider interface for the Dank RSS Widget.
//
// See README.md's "Architecture" section for the QML/Node dual-load
// mechanism and the `.pragma library` rule (kept once, in FeedParser.js).
// See docs/plans/2026-09-08-phase3-ai-provider-design.md for the full design.
//
// This is the OpenAI-compatible chat API, not "an ollama integration": a
// provider is { label, baseUrl, model, apiKey, timeoutMs } and nothing more.
// POST {baseUrl}/chat/completions, read choices[0].message.content. Presets
// below are a data table, not code paths -- adding a runtime later is a
// table row. No dependency-injection factory: unlike Backends.js this
// module needs no sibling modules to build its requests.
//
// Everything here stays PURE: no Qt APIs, no I/O, no Date.now(), no
// randomness. Every *Request function returns a request descriptor
// ({ argv, parse, timeoutMs }) or null when the call is a no-op (not
// configured, or nothing to send). QML alone spawns `argv` and hands stdout
// to `parse`.
//
// MEASURED ON THIS MACHINE (RTX 2070 Super, qwen3:8b, 2026-09-08 -- see the
// design doc's Measurements section, which is load-bearing, not illustrative):
//   - GET  {baseUrl}/models           -> 200, OpenAI-shaped {object,data:[...]}
//   - POST {baseUrl}/chat/completions -> 200, standard
//     {choices:[{message:{role,content},finish_reason}],usage:{...}}
//   - A reasoning model (qwen3:8b) returns its reasoning in a SEPARATE
//     message.reasoning field and leaves message.content clean. Reading
//     content is correct with or without a reasoning model -- there is
//     nothing to strip, so this file does NOT write a <think>-stripping
//     regex.
//   - Neither `/no_think` nor `chat_template_kwargs.enable_thinking` changes
//     anything through ollama's OpenAI shim (both were tried against the
//     live endpoint). Shipping a knob that silently does nothing is worse
//     than not shipping it, so neither is emitted here. The real fix for
//     "too much thinking" is model choice (a non-reasoning instruct model),
//     which is a UI/config concern, not this file's.

// Sane fallback when a provider config doesn't set its own timeoutMs.
// Chat completions are a generation workload, not a status API call --
// ~5s was measured for a ~120-word article on this machine, and a digest
// call fans that out over many items, so this is deliberately generous
// compared to Backends.js's fetch/Miniflux timeouts.
var DEFAULT_TIMEOUT_MS = 60000;

// A /models GET is not a generation workload -- it answers in well under a
// second on a healthy runtime. Sharing the generation-sized default just made
// an unreachable or firewalled host hang for a minute before saying so.
var PROBE_TIMEOUT_MS = 8000;

var SUMMARISE_SYSTEM_PROMPT =
    "Summarise the article the user gives you in two concise sentences. " +
    "Respond with only the summary -- no preamble, no headings.";

var DIGEST_SYSTEM_PROMPT =
    "You are given a numbered list of article titles and descriptions from " +
    "the last 24 hours. Write a short digest (a few sentences, or a short " +
    "bulleted list) highlighting the most notable items. Respond with only " +
    "the digest -- no preamble.";

// ─── presets ───
//
// A table, not code paths. baseUrl already includes the OpenAI-compatible
// "/v1" prefix each runtime serves it under, so callers append plain
// "/models" and "/chat/completions".
//
// Provenance, stated honestly: **only ollama is measured** -- verified live
// against this machine (GET /v1/models -> 200, OpenAI-shaped). vLLM,
// llama.cpp and LM Studio are each that project's own documented default
// port, taken on faith and not exercised against a running instance. Treat
// a bug report about any of those three as plausibly a wrong default here.

var PRESETS = {
    ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1" },
    vllm: { label: "vLLM", baseUrl: "http://localhost:8000/v1" },
    llamacpp: { label: "llama.cpp", baseUrl: "http://localhost:8080/v1" },
    lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
    custom: { label: "Custom", baseUrl: "" }
};

// ─── shared curl argv builder ───
//
// SECURITY: apiKey is always its own argv element (the "-H" value slot
// curl's own syntax requires), never merged into the URL, the method,
// another header, or the body -- and this function never joins argv into a
// single string for a shell. See tests/ai-provider.test.js's "SECURITY:
// apiKey isolation" suite. When apiKey is falsy (ollama and most local
// runtimes need none) no Authorization header is emitted at all.
function aiCurlArgv(method, url, apiKey, body, timeoutMs) {
    var seconds = Math.ceil((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000);
    var args = [
        "curl", "-sS",
        "--connect-timeout", "5",
        "--max-time", String(seconds),
        "--proto", "=http,https",
        "--proto-redir", "=http,https",
        // No -L, deliberately -- and so no --max-redirs, which is a no-op
        // without it and only reads as protection that is not there. curl
        // re-sends an explicit -H header across a cross-host redirect, so
        // following redirects on an authenticated endpoint would hand the
        // API key to whatever host the redirect names.
        "--max-filesize", "5000000",
        "-X", method
    ];
    if (apiKey)
        args.push("-H", "Authorization: Bearer " + apiKey);
    if (method !== "GET") {
        args.push("-H", "Content-Type: application/json");
        if (body)
            args.push("-d", body);
    }
    args.push(url);
    return args;
}

function isConfigured(config) {
    return !!(config && config.baseUrl && config.model);
}

// ─── response parsing ───
//
// parse for /models. Reports reachability separately from "does it have the
// configured model" so callers (per the design doc's Degradation section)
// can distinguish "nothing is listening" from "listening, wrong model".
function parseModelsResponse(stdout, modelId) {
    var parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (e) {
        return { reachable: false, hasModel: false, models: [], error: "Parse failed" };
    }

    if (!parsed || !Array.isArray(parsed.data))
        return { reachable: false, hasModel: false, models: [], error: "Unexpected response" };

    var models = parsed.data.map(function (m) { return m.id; });
    return { reachable: true, hasModel: models.indexOf(modelId) !== -1, models: models, error: null };
}

// parse for /chat/completions. Reads choices[0].message.content ONLY --
// message.reasoning (present on reasoning models like qwen3) is deliberately
// ignored; content is already clean. An empty content string is not treated
// as an error: it's a real (if useless) 200 response, and it's the caller's
// call what to do with a blank summary.
function parseChatResponse(stdout) {
    var parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (e) {
        return { text: null, error: "Parse failed" };
    }

    if (parsed && parsed.error) {
        var msg = (parsed.error && parsed.error.message) || (typeof parsed.error === "string" ? parsed.error : "Unknown error");
        return { text: null, error: "AI: " + msg };
    }

    if (!parsed || !Array.isArray(parsed.choices) || parsed.choices.length === 0)
        return { text: null, error: "No response from model" };

    var message = parsed.choices[0].message || {};
    var content = typeof message.content === "string" ? message.content : "";
    return { text: content, error: null };
}

// ─── prompt building ───

function summarisePrompt(article) {
    var title = (article && article.title) || "";
    var description = (article && (article.description || article.content)) || "";
    return "Title: " + title + "\n\n" + description;
}

function digestPrompt(items) {
    var lines = [];
    for (var i = 0; i < items.length; i++) {
        var item = items[i] || {};
        var line = (i + 1) + ". " + (item.title || "");
        if (item.description)
            line += " -- " + item.description;
        lines.push(line);
    }
    return lines.join("\n");
}

function chatCompletionsBody(model, systemPrompt, userPrompt) {
    return JSON.stringify({
        model: model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ]
    });
}

// ─── factory ───

function createAiProvider(config) {
    config = config || {};

    return {
        isConfigured: function () {
            return isConfigured(config);
        },

        // GET {baseUrl}/models -- answers "is a runtime reachable and does
        // it have this model?" without generating anything.
        probeRequest: function () {
            if (!isConfigured(config))
                return null;

            var url = config.baseUrl + "/models";
            return {
                argv: aiCurlArgv("GET", url, config.apiKey, null, PROBE_TIMEOUT_MS),
                timeoutMs: PROBE_TIMEOUT_MS,
                parse: function (stdout) { return parseModelsResponse(stdout, config.model); }
            };
        },

        // POST {baseUrl}/chat/completions for a single article. article:
        // { title, description } (description falls back to .content).
        summariseRequest: function (article) {
            if (!isConfigured(config) || !article)
                return null;

            var body = chatCompletionsBody(config.model, SUMMARISE_SYSTEM_PROMPT, summarisePrompt(article));
            var url = config.baseUrl + "/chat/completions";
            return {
                argv: aiCurlArgv("POST", url, config.apiKey, body, config.timeoutMs),
                timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
                parse: parseChatResponse
            };
        },

        // POST {baseUrl}/chat/completions over many items in ONE call
        // (cheaper per-item than summariseRequest looped -- the prompt-size
        // ceiling is the constraint here, not latency). items: array of
        // { title, description }.
        digestRequest: function (items) {
            if (!isConfigured(config) || !items || items.length === 0)
                return null;

            var body = chatCompletionsBody(config.model, DIGEST_SYSTEM_PROMPT, digestPrompt(items));
            var url = config.baseUrl + "/chat/completions";
            return {
                argv: aiCurlArgv("POST", url, config.apiKey, body, config.timeoutMs),
                timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
                parse: parseChatResponse
            };
        }
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createAiProvider: createAiProvider,
        PRESETS: PRESETS
    };
}
