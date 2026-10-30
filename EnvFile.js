// Credentials file support: parses systemd EnvironmentFile syntax and
// resolves server secrets, file over settings per key.
//
// PURE: no I/O. The widget and settings panel read the file with a FileView
// and pass its text to parse(). See docs/plans/2026-10-30-credentials-file-design.md.

// Setting name -> env-file key. Only secrets; URLs stay in settings.
var CREDENTIAL_KEYS = {
    minifluxToken: "MINIFLUX_TOKEN",
    greaderUsername: "GREADER_USERNAME",
    greaderPassword: "GREADER_PASSWORD",
    aiApiKey: "AI_API_KEY"
};

var KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Returns a plain object of KEY -> value. Unsupported: escapes, line
// continuations and $VAR expansion; values are taken literally.
function parse(text) {
    var env = {};
    if (typeof text !== "string")
        return env;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line[0] === "#" || line[0] === ";")
            continue;
        if (line.indexOf("export ") === 0)
            line = line.slice(7).trim();
        var eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        var key = line.slice(0, eq).trim();
        if (!KEY_PATTERN.test(key))
            continue;
        var value = line.slice(eq + 1).trim();
        if (value.length >= 2) {
            var q = value[0];
            if ((q === "\"" || q === "'") && value[value.length - 1] === q)
                value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

// Expands a leading "~" or "~/"; "~user" is left as is. Returns "" for empty input.
function expandHome(path, home) {
    var p = typeof path === "string" ? path.trim() : "";
    if (!home)
        return p;
    if (p === "~")
        return home;
    if (p.indexOf("~/") === 0)
        return home.replace(/\/$/, "") + p.slice(1);
    return p;
}

// settings: the CREDENTIAL_KEYS settings from pluginData.
// env: the result of parse(). Returns the same keys plus
// sources: { <key>: "file" | "settings" | "none" }.
function resolveCredentials(settings, env) {
    var s = settings || {};
    var e = env || {};
    var result = { sources: {} };
    for (var name in CREDENTIAL_KEYS) {
        var fromFile = e[CREDENTIAL_KEYS[name]];
        var fromSettings = s[name];
        if (typeof fromFile === "string" && fromFile !== "") {
            result[name] = fromFile;
            result.sources[name] = "file";
        } else if (typeof fromSettings === "string" && fromSettings !== "") {
            result[name] = fromSettings;
            result.sources[name] = "settings";
        } else {
            result[name] = "";
            result.sources[name] = "none";
        }
    }
    return result;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        CREDENTIAL_KEYS: CREDENTIAL_KEYS,
        parse: parse,
        expandHome: expandHome,
        resolveCredentials: resolveCredentials
    };
}
