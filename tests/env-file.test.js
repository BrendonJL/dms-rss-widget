const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const EnvFile = require("../EnvFile.js");
const { parse, expandHome, resolveCredentials } = EnvFile;

describe("parse", () => {
    test("reads KEY=VALUE lines", () => {
        assert.deepEqual(parse("A=1\nB=two\n"), { A: "1", B: "two" });
    });

    test("skips blank lines and # / ; comments", () => {
        assert.deepEqual(parse("# note\n\n; other\n  # indented\nA=1"), { A: "1" });
    });

    test("trims whitespace around key and value", () => {
        assert.deepEqual(parse("  A =  spaced value  \n"), { A: "spaced value" });
    });

    test("strips one matching pair of quotes", () => {
        assert.deepEqual(parse("A=\"x y\"\nB='z'\nC=\"unbalanced\nD='\"mixed\"'"), {
            A: "x y",
            B: "z",
            C: "\"unbalanced",
            D: "\"mixed\""
        });
    });

    test("keeps = inside the value", () => {
        assert.deepEqual(parse("URL=postgres://u:p@h/db?sslmode=disable"), {
            URL: "postgres://u:p@h/db?sslmode=disable"
        });
    });

    test("accepts an export prefix", () => {
        assert.deepEqual(parse("export A=1"), { A: "1" });
    });

    test("handles CRLF line endings", () => {
        assert.deepEqual(parse("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
    });

    test("ignores lines without = and invalid key names", () => {
        assert.deepEqual(parse("garbage\n1BAD=x\nBAD-KEY=y\nOK_1=z"), { OK_1: "z" });
    });

    test("later duplicates win", () => {
        assert.deepEqual(parse("A=1\nA=2"), { A: "2" });
    });

    test("non-string input yields an empty map", () => {
        assert.deepEqual(parse(undefined), {});
        assert.deepEqual(parse(null), {});
    });
});

describe("expandHome", () => {
    test("expands a leading ~/", () => {
        assert.equal(expandHome("~/secrets/a.env", "/home/u"), "/home/u/secrets/a.env");
    });

    test("expands a bare ~", () => {
        assert.equal(expandHome("~", "/home/u"), "/home/u");
    });

    test("leaves absolute paths and ~user alone", () => {
        assert.equal(expandHome("/etc/a.env", "/home/u"), "/etc/a.env");
        assert.equal(expandHome("~other/a.env", "/home/u"), "~other/a.env");
    });

    test("trims the path and tolerates missing input", () => {
        assert.equal(expandHome("  ~/a  ", "/home/u"), "/home/u/a");
        assert.equal(expandHome("", "/home/u"), "");
        assert.equal(expandHome(undefined, "/home/u"), "");
    });

    test("without a home, a ~ path is returned unexpanded", () => {
        assert.equal(expandHome("~/a", ""), "~/a");
    });
});

describe("resolveCredentials", () => {
    const settings = { minifluxToken: "s-tok", greaderUsername: "s-user", greaderPassword: "s-pass" };

    test("file values override settings per key", () => {
        const r = resolveCredentials(settings, { MINIFLUX_TOKEN: "f-tok" });
        assert.equal(r.minifluxToken, "f-tok");
        assert.equal(r.greaderUsername, "s-user");
        assert.equal(r.greaderPassword, "s-pass");
        assert.deepEqual(r.sources, { minifluxToken: "file", greaderUsername: "settings", greaderPassword: "settings", aiApiKey: "none" });
    });

    test("an empty file value falls back to settings", () => {
        const r = resolveCredentials(settings, { GREADER_PASSWORD: "" });
        assert.equal(r.greaderPassword, "s-pass");
        assert.equal(r.sources.greaderPassword, "settings");
    });

    test("neither source gives an empty value with source none", () => {
        const r = resolveCredentials({}, {});
        assert.equal(r.minifluxToken, "");
        assert.equal(r.sources.minifluxToken, "none");
    });

    test("tolerates null inputs", () => {
        const r = resolveCredentials(null, null);
        assert.deepEqual(r.sources, { minifluxToken: "none", greaderUsername: "none", greaderPassword: "none", aiApiKey: "none" });
    });

    test("unrelated keys in the file are never surfaced", () => {
        const r = resolveCredentials({}, { POSTGRES_PASSWORD: "x", MINIFLUX_URL: "http://h" });
        assert.deepEqual(Object.keys(r).sort(), ["aiApiKey", "greaderPassword", "greaderUsername", "minifluxToken", "sources"]);
    });

    test("AI_API_KEY overrides the AI key setting", () => {
        const r = resolveCredentials({ aiApiKey: "s-key" }, { AI_API_KEY: "f-key" });
        assert.equal(r.aiApiKey, "f-key");
        assert.equal(r.sources.aiApiKey, "file");
    });

    test("CREDENTIAL_KEYS maps every resolved setting", () => {
        assert.deepEqual(EnvFile.CREDENTIAL_KEYS, {
            minifluxToken: "MINIFLUX_TOKEN",
            greaderUsername: "GREADER_USERNAME",
            greaderPassword: "GREADER_PASSWORD",
            aiApiKey: "AI_API_KEY"
        });
    });
});
