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

// embedModel is a SUGGESTED default only -- settings UI may offer it as a
// starting point, nothing here reads it automatically. nomic-embed-text is
// the ollama default that was actually pulled and tried on this machine
// alongside qwen3:8b; the others are the same "documented default, not
// measured" honesty as the baseUrls above.
var PRESETS = {
    ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", embedModel: "nomic-embed-text" },
    vllm: { label: "vLLM", baseUrl: "http://localhost:8000/v1", embedModel: "" },
    llamacpp: { label: "llama.cpp", baseUrl: "http://localhost:8080/v1", embedModel: "" },
    lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1", embedModel: "" },
    custom: { label: "Custom", baseUrl: "", embedModel: "" }
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
        // --fail-with-body, for the same reason Backends.js grew it: curl
        // exits 0 on an HTTP 4xx, so a runtime that answered but refused --
        // a wrong API key, a gated reverse proxy, a model that does not
        // exist -- was indistinguishable from a dead socket. Test Connection
        // told the user "could not reach <host>" about a host it had just
        // reached. This makes a 4xx/5xx exit 22 while STILL returning the
        // body, so the parse functions can surface the runtime's own error
        // text instead of a guess. Callers must therefore parse the body on
        // a nonzero exit rather than bailing on the exit code alone.
        "--fail-with-body",
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
    args.push("--", url);
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

// parse for /embeddings. Follows parseChatResponse's convention: errors are
// data, never thrown.
//
// The API returns { data: [{ embedding: [...], index: N }, ...] }. index is
// authoritative -- some runtimes/proxies (and definitely a batched request
// retried through a load balancer) may not return entries in request order,
// and the whole point of a batch call is that the caller matches vectors
// back to articles by position, so trusting array position here would
// silently mismatch article <-> vector. Reindex by .index when it is a
// number; only fall back to array position for a response that omits index
// entirely (a runtime that doesn't send it will send it in order anyway).
function parseEmbeddingsResponse(stdout) {
    var parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (e) {
        return { vectors: null, error: "Parse failed" };
    }

    if (parsed && parsed.error) {
        var msg = (parsed.error && parsed.error.message) || (typeof parsed.error === "string" ? parsed.error : "Unknown error");
        return { vectors: null, error: "AI: " + msg };
    }

    if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0)
        return { vectors: null, error: "No embeddings from model" };

    var vectors = new Array(parsed.data.length);
    for (var i = 0; i < parsed.data.length; i++) {
        var entry = parsed.data[i] || {};
        var idx = typeof entry.index === "number" ? entry.index : i;
        vectors[idx] = Array.isArray(entry.embedding) ? entry.embedding : null;
    }
    return { vectors: vectors, error: null };
}

// ─── embedding text preparation ───
//
// Bounded on purpose: embedding endpoints have their own context/token
// limits, and a full article body can run past 20k characters -- past that
// limit a request either errors outright or gets silently truncated
// server-side, which would embed a partial (and misleadingly-weighted)
// article without any signal that it happened. 2000 characters (~500 tokens
// at the usual ~4 chars/token rule of thumb) comfortably clears every
// embedding model's limit encountered in the design doc's research while
// keeping title + lede, which is what similarity ranking actually needs --
// callers with a runtime known to allow more can override via maxChars.
var DEFAULT_EMBED_TEXT_MAX_CHARS = 2000;

function prepareEmbedText(article, maxChars) {
    var cap = typeof maxChars === "number" && maxChars > 0 ? maxChars : DEFAULT_EMBED_TEXT_MAX_CHARS;
    var title = (article && article.title) || "";
    var description = (article && (article.description || article.content)) || "";
    var text = title + "\n\n" + description;
    return text.length > cap ? text.slice(0, cap) : text;
}

// ─── prompt building ───

function summarisePrompt(article) {
    var title = (article && article.title) || "";
    var description = (article && (article.description || article.content)) || "";
    return "Title: " + title + "\n\n" + description;
}

// The prompt has a HARD character budget, and that is the whole design.
//
// Measured on this machine 2026-09-13: llama3.2:3b advertises a 131072-token
// context, but ollama allocates 4096 at RUNTIME (`/api/ps` reports
// context_length: 4096). Anything beyond that is silently truncated -- no
// error, no warning, just a digest that quietly ignores most of its input.
// Thirty articles with full descriptions already came to roughly 5000 tokens,
// so the digest was being cut off before it ever reached the model's answer.
// The symptom was a digest that looked like it was cherry-picking a handful
// of feeds. It was not choosing; it never saw the rest.
//
// So: titles are the load-bearing part of a digest and are always kept.
// Descriptions are truncated hard, and dropped entirely once the budget runs
// out, because twenty headlines beat five headlines with paragraphs attached.
// Roughly four characters per token puts this comfortably inside 4096 with
// room for the reply.
var DIGEST_CHAR_BUDGET = 9000;
var DIGEST_DESC_CHARS = 140;

function digestPrompt(items) {
    // Two passes, because coverage beats detail for this job.
    //
    // A greedy single pass gives the first few articles their descriptions and
    // then runs out of budget, so a 300-item day becomes a detailed digest of
    // the first forty and silence about the rest -- precisely the "it is
    // missing most of my feeds" complaint this budget exists to fix. Titles
    // for everything first; descriptions only with what is left over.
    var titles = [];
    var used = 0;
    var i;

    for (i = 0; i < items.length; i++) {
        var t = ((items[i] || {}).title || "").trim();
        if (!t)
            continue;
        var line = (titles.length + 1) + ". " + t;
        if (used + line.length + 1 > DIGEST_CHAR_BUDGET)
            break;
        titles.push({ line: line, description: ((items[i] || {}).description || "").trim() });
        used += line.length + 1;
    }

    for (i = 0; i < titles.length; i++) {
        var desc = titles[i].description;
        if (!desc)
            continue;
        if (desc.length > DIGEST_DESC_CHARS)
            desc = desc.slice(0, DIGEST_DESC_CHARS).replace(/\s+\S*$/, "") + "…";
        var addition = " -- " + desc;
        if (used + addition.length > DIGEST_CHAR_BUDGET)
            break;
        titles[i].line += addition;
        used += addition.length;
    }

    var out = [];
    for (i = 0; i < titles.length; i++)
        out.push(titles[i].line);
    return out.join("\n");
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

// Model precedence for an embed call: a per-call options.model wins (a
// caller doing a one-off embed against a different model shouldn't need a
// new provider instance), otherwise config.embedModel. Deliberately NO
// fallback to config.model: that is the CHAT model, usually a generation
// model that doesn't serve /embeddings at all (or serves it badly), and
// silently sending chat-model traffic to /embeddings on the assumption it's
// "close enough" is exactly the kind of wrong-default bug this file's
// PRESETS comment already warns about. Absent an explicit embed model, the
// right answer is "not configured", not a guess.
function resolveEmbedModel(config, options) {
    if (options && options.model)
        return options.model;
    return (config && config.embedModel) || "";
}

function createAiProvider(config) {
    config = config || {};

    return {
        isConfigured: function () {
            return isConfigured(config);
        },

        // Separate from isConfigured() rather than overloading it: a
        // provider can be fully configured for chat (baseUrl + model) with
        // no embedModel set at all, or vice versa -- they are independent
        // capabilities of the same runtime, and other code already depends
        // on isConfigured() meaning "chat is usable". Overloading it would
        // either break that meaning or force every existing caller to pass
        // an options bag it doesn't have. options.model lets a caller check
        // "would THIS specific model work" without mutating config.
        canEmbed: function (options) {
            return !!(config.baseUrl && resolveEmbedModel(config, options));
        },

        // Exposed so callers building a batch can prepare each article's
        // text the same bounded way this file does internally, without
        // duplicating the cap logic.
        prepareEmbedText: function (article, maxChars) {
            return prepareEmbedText(article, maxChars);
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
        },

        // POST {baseUrl}/embeddings for phase 3d's interest ranking:
        // similarity between unread items and starred ones. texts: array of
        // already-prepared strings (see prepareEmbedText above) -- one
        // vector comes back per input, order-preserved by parse() below.
        // options.model overrides config.embedModel for this one call; see
        // resolveEmbedModel's comment for why there is no fallback to the
        // chat model.
        embedRequest: function (texts, options) {
            if (!Array.isArray(texts) || texts.length === 0)
                return null;
            var model = resolveEmbedModel(config, options);
            if (!config.baseUrl || !model)
                return null;

            var body = JSON.stringify({ model: model, input: texts });
            var url = config.baseUrl + "/embeddings";
            return {
                argv: aiCurlArgv("POST", url, config.apiKey, body, config.timeoutMs),
                timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
                parse: parseEmbeddingsResponse
            };
        }
    };
}

// Resolves the base URL actually to be used, given a chosen preset and
// whatever the user typed.
//
// This exists because of a real bug: the settings panel populated the base
// URL field from a preset dropdown's change handler, and on a fresh install
// that handler never fired -- the stored value was absent, so the dropdown
// loaded its default ("ollama"), which EQUALS the default it already held,
// so no change was emitted and nothing was written. The field then showed
// only its placeholder, which looks identical to a filled field, while
// isConfigured() correctly saw an empty string.
//
// The lesson is that a default must be resolvable without an event having
// fired. So: an explicit URL always wins, otherwise the preset supplies one,
// and "custom" supplies nothing because there is nothing sensible to guess.
// Mirrors the reader's effectiveFontFamily ("empty follows the theme").
function resolveBaseUrl(preset, explicitUrl) {
    var typed = typeof explicitUrl === "string" ? explicitUrl.trim() : "";
    if (typed)
        return typed;
    var key = typeof preset === "string" ? preset : "";
    var entry = PRESETS[key];
    return entry ? entry.baseUrl : "";
}

// The embedding model actually in force, given a preset and whatever the user
// typed. Exactly the same shape as resolveBaseUrl, and it exists for exactly
// the same reason: the settings panel resolved a preset default for DISPLAY
// while the widget read the raw stored value, which was never written because
// the user never had to type it. The widget then saw "", decided it could not
// embed, and disabled interest ranking silently.
//
// One resolver, exported, used by both sides. Two places deciding what "empty"
// means is how they disagree.
//
// Named resolvePresetEmbedModel, NOT resolveEmbedModel: an internal
// resolveEmbedModel(config, options) already exists above with a different
// signature, and a second declaration of that name silently replaces it via
// hoisting -- which breaks canEmbed() with no error anywhere.
function resolvePresetEmbedModel(preset, explicitModel) {
    var typed = typeof explicitModel === "string" ? explicitModel.trim() : "";
    if (typed)
        return typed;
    var entry = PRESETS[typeof preset === "string" ? preset : ""];
    return (entry && entry.embedModel) ? entry.embedModel : "";
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        createAiProvider: createAiProvider,
        resolveBaseUrl: resolveBaseUrl,
        resolvePresetEmbedModel: resolvePresetEmbedModel,
        PRESETS: PRESETS
    };
}
