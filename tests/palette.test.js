const { test, describe } = require("node:test");
const assert = require("node:assert");

const Palette = require("../Palette.js");

const CONDITIONS = ["deuteranopia", "protanopia", "tritanopia"];

// The "just noticeable difference" line for the redmean colour-distance
// metric (see Palette.js's colourDistance() comment, citing Riemersma's
// low-cost perceptual metric) is commonly put somewhere around 20-30: below
// that, two swatches read as "the same colour, slightly off". We require a
// wide safety margin over that -- 50 -- so a palette barely scraping past
// the JND doesn't count as "distinguishable" for an accessibility feature.
// The actual presets clear this by 6-8x (see the computed distances below),
// which is the point: colour-blind-safe palettes should not be marginal.
const DISTINCT_THRESHOLD = 50;

describe("resolvePalette", () => {
    test('"system" returns the base palette unchanged', () => {
        const base = {
            primary: "#123456",
            secondary: "#abcdef",
            surfaceText: "#ffffff",
            surfaceVariantText: "#eeeeee",
            error: "#ff0000",
            success: "#00ff00",
            warning: "#ffff00",
            outlineVariant: "#999999",
            surfaceContainer: "#111111",
            surfaceContainerHigh: "#222222",
            surfaceContainerHighest: "#333333",
            onPrimary: "#000000",
            onError: "#000000"
        };
        assert.deepStrictEqual(Palette.resolvePalette("system", base), base);
    });

    test("no preset name defaults to system behaviour", () => {
        const base = Palette.DEFAULT_PALETTE;
        assert.deepStrictEqual(Palette.resolvePalette(undefined, base), base);
    });

    test("unknown preset falls back to the base palette rather than throwing", () => {
        const base = Palette.DEFAULT_PALETTE;
        assert.deepStrictEqual(Palette.resolvePalette("not-a-real-preset", base), base);
    });

    test("null base palette resolves to sane built-in defaults, not undefined", () => {
        const resolved = Palette.resolvePalette("system", null);
        for (const role of Palette.ROLE_NAMES) {
            assert.strictEqual(typeof resolved[role], "string", `${role} should be a string`);
            assert.ok(resolved[role].startsWith("#"), `${role} should be a colour`);
        }
    });

    test("partial base palette fills missing roles from the default, keeps the rest", () => {
        const resolved = Palette.resolvePalette("system", { primary: "#ff00ff" });
        assert.strictEqual(resolved.primary, "#ff00ff");
        assert.strictEqual(resolved.secondary, Palette.DEFAULT_PALETTE.secondary);
    });

    test("a malformed colour in the base is treated as missing, not passed through", () => {
        const resolved = Palette.resolvePalette("system", { primary: "not-a-colour" });
        assert.strictEqual(resolved.primary, Palette.DEFAULT_PALETTE.primary);
    });

    test("every CVD preset returns every role as a valid colour", () => {
        for (const condition of CONDITIONS) {
            const resolved = Palette.resolvePalette(condition, {});
            for (const role of Palette.ROLE_NAMES) {
                assert.ok(
                    Palette.contrastRatio(resolved[role], "#000000") !== null,
                    `${condition}.${role} should be a parsable colour`
                );
            }
        }
    });

    test('"custom" with no overrides behaves like "system"', () => {
        const base = Palette.DEFAULT_PALETTE;
        assert.deepStrictEqual(Palette.resolvePalette("custom", base), base);
    });

    test('"custom" applies overrides on top of the base', () => {
        const base = Palette.DEFAULT_PALETTE;
        const resolved = Palette.resolvePalette("custom", base, { primary: "#00ff00" });
        assert.strictEqual(resolved.primary, "#00ff00");
        assert.strictEqual(resolved.secondary, base.secondary);
    });

    test("does not mutate the base palette it is given", () => {
        const base = { primary: "#123456" };
        const snapshot = JSON.stringify(base);
        Palette.resolvePalette("deuteranopia", base);
        Palette.resolvePalette("custom", base, { primary: "#ffffff" });
        assert.strictEqual(JSON.stringify(base), snapshot);
    });
});

describe("applyOverrides", () => {
    test("overrides only recognised roles", () => {
        const base = Palette.DEFAULT_PALETTE;
        const out = Palette.applyOverrides(base, { primary: "#00ff00", notARole: "#ff0000" });
        assert.strictEqual(out.primary, "#00ff00");
        assert.strictEqual(out.notARole, undefined);
    });

    test("ignores malformed colour values rather than poisoning the palette", () => {
        const base = Palette.DEFAULT_PALETTE;
        const out = Palette.applyOverrides(base, { primary: "not-a-colour", secondary: 42 });
        assert.strictEqual(out.primary, base.primary);
        assert.strictEqual(out.secondary, base.secondary);
    });

    test("ignores a null/non-object overrides argument", () => {
        const base = Palette.DEFAULT_PALETTE;
        assert.deepStrictEqual(Palette.applyOverrides(base, null), Palette.applyOverrides(base, {}));
        assert.deepStrictEqual(Palette.applyOverrides(base, undefined), Palette.applyOverrides(base, {}));
    });

    test("does not mutate the palette or the overrides object", () => {
        const base = { ...Palette.DEFAULT_PALETTE };
        const overrides = { primary: "#00ff00" };
        const baseSnapshot = JSON.stringify(base);
        const overridesSnapshot = JSON.stringify(overrides);
        Palette.applyOverrides(base, overrides);
        assert.strictEqual(JSON.stringify(base), baseSnapshot);
        assert.strictEqual(JSON.stringify(overrides), overridesSnapshot);
    });

    test("returns a fresh object, not the same reference as the input palette", () => {
        const base = Palette.DEFAULT_PALETTE;
        const out = Palette.applyOverrides(base, {});
        assert.notStrictEqual(out, base);
    });
});

describe("contrastRatio", () => {
    test("white on black is 21:1", () => {
        assert.ok(Math.abs(Palette.contrastRatio("#ffffff", "#000000") - 21) < 0.01);
    });

    test("black on white is also 21:1 (order doesn't matter)", () => {
        assert.ok(Math.abs(Palette.contrastRatio("#000000", "#ffffff") - 21) < 0.01);
    });

    test("a colour against itself is 1:1", () => {
        assert.strictEqual(Palette.contrastRatio("#42a5f5", "#42a5f5"), 1);
        assert.strictEqual(Palette.contrastRatio("#000000", "#000000"), 1);
    });

    test("accepts 3-digit hex", () => {
        assert.ok(Math.abs(Palette.contrastRatio("#fff", "#000") - 21) < 0.01);
    });

    test("accepts 8-digit hex as #AARRGGBB (Qt convention), ignoring alpha", () => {
        // Fully-opaque white on fully-opaque black, alpha channel first.
        assert.ok(Math.abs(Palette.contrastRatio("#ffffffff", "#ff000000") - 21) < 0.01);
    });

    test("returns null rather than throwing for an unparsable colour", () => {
        assert.strictEqual(Palette.contrastRatio("not-a-colour", "#000000"), null);
        assert.strictEqual(Palette.contrastRatio("#000000", undefined), null);
    });
});

describe("simulate", () => {
    test("returns the input unchanged for an unknown condition", () => {
        assert.strictEqual(Palette.simulate("#ff0000", "achromatopsia"), "#ff0000");
    });

    test("returns the input unchanged for an unparsable colour", () => {
        assert.strictEqual(Palette.simulate("not-a-colour", "deuteranopia"), "not-a-colour");
    });

    test("black and white are unaffected by any dichromacy simulation", () => {
        // All three CVD matrices are identity-like on the achromatic axis:
        // a dichromat still sees black as black and white as white, only
        // hue discrimination is lost. This is a sanity check on the
        // matrices themselves, not on any palette choice.
        for (const condition of CONDITIONS) {
            assert.strictEqual(Palette.simulate("#000000", condition), "#000000");
            assert.strictEqual(Palette.simulate("#ffffff", condition), "#ffffff");
        }
    });
});

describe("colour-vision-deficiency safety (the headline requirement)", () => {
    for (const condition of CONDITIONS) {
        test(`${condition}: error and success remain distinct after simulate()`, () => {
            const palette = Palette.resolvePalette(condition, {});
            const simulatedError = Palette.simulate(palette.error, condition);
            const simulatedSuccess = Palette.simulate(palette.success, condition);
            const distance = Palette.colourDistance(simulatedError, simulatedSuccess);

            assert.ok(
                distance >= DISTINCT_THRESHOLD,
                `${condition}: error (${palette.error} -> ${simulatedError}) and success ` +
                    `(${palette.success} -> ${simulatedSuccess}) are only ${distance.toFixed(1)} apart ` +
                    `after simulation (need >= ${DISTINCT_THRESHOLD})`
            );
        });

        test(`${condition}: primary is distinct from error and success after simulate()`, () => {
            const palette = Palette.resolvePalette(condition, {});
            const simulatedPrimary = Palette.simulate(palette.primary, condition);
            const simulatedError = Palette.simulate(palette.error, condition);
            const simulatedSuccess = Palette.simulate(palette.success, condition);

            assert.ok(
                Palette.colourDistance(simulatedPrimary, simulatedError) >= DISTINCT_THRESHOLD,
                `${condition}: primary too close to error after simulation`
            );
            assert.ok(
                Palette.colourDistance(simulatedPrimary, simulatedSuccess) >= DISTINCT_THRESHOLD,
                `${condition}: primary too close to success after simulation`
            );
        });
    }

    // The un-simulated (i.e. non-colour-blind) reading of the same pair must
    // also stay distinct -- a palette that only works once you're already
    // colour-blind would be a strange kind of regression for everyone else.
    for (const condition of CONDITIONS) {
        test(`${condition}: error and success are distinct without any simulation too`, () => {
            const palette = Palette.resolvePalette(condition, {});
            const distance = Palette.colourDistance(palette.error, palette.success);
            assert.ok(distance >= DISTINCT_THRESHOLD);
        });
    }
});

describe("text-role contrast (WCAG AA, 4.5:1)", () => {
    // Pairings checked: the two text roles (surfaceText, surfaceVariantText)
    // against every surface container they are actually drawn on, plus the
    // two "on X" roles against their own container colour, for every CVD
    // preset. The plain "system" default is not asserted here: those values
    // are carried over unchanged from Theme.qml's own existing defaults
    // (see Palette.js's DEFAULT_PALETTE comment) which this feature does not
    // change -- the accessibility guarantee this module adds is for the CVD
    // presets specifically.
    const AA_NORMAL_TEXT = 4.5;

    for (const condition of CONDITIONS) {
        test(`${condition}: surfaceText is AA against all three surface containers`, () => {
            const p = Palette.resolvePalette(condition, {});
            for (const surface of ["surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest"]) {
                const ratio = Palette.contrastRatio(p.surfaceText, p[surface]);
                assert.ok(ratio >= AA_NORMAL_TEXT, `${condition}: surfaceText vs ${surface} is ${ratio}`);
            }
        });

        test(`${condition}: surfaceVariantText is AA against surfaceContainer`, () => {
            const p = Palette.resolvePalette(condition, {});
            const ratio = Palette.contrastRatio(p.surfaceVariantText, p.surfaceContainer);
            assert.ok(ratio >= AA_NORMAL_TEXT, `${condition}: surfaceVariantText vs surfaceContainer is ${ratio}`);
        });

        test(`${condition}: onPrimary is AA against primary`, () => {
            const p = Palette.resolvePalette(condition, {});
            const ratio = Palette.contrastRatio(p.onPrimary, p.primary);
            assert.ok(ratio >= AA_NORMAL_TEXT, `${condition}: onPrimary vs primary is ${ratio}`);
        });

        test(`${condition}: onError is AA against error`, () => {
            const p = Palette.resolvePalette(condition, {});
            const ratio = Palette.contrastRatio(p.onError, p.error);
            assert.ok(ratio >= AA_NORMAL_TEXT, `${condition}: onError vs error is ${ratio}`);
        });
    }
});

describe("no function mutates its inputs", () => {
    test("resolvePalette, applyOverrides and simulate leave their arguments untouched", () => {
        const base = { primary: "#123456", secondary: "#abcdef" };
        const overrides = { primary: "#00ff00" };
        Object.freeze(base);
        Object.freeze(overrides);

        assert.doesNotThrow(() => {
            Palette.resolvePalette("deuteranopia", base);
            Palette.resolvePalette("custom", base, overrides);
            Palette.applyOverrides(base, overrides);
            Palette.simulate("#ff0000", "deuteranopia");
        });
    });
});

// ─── The aesthetic presets, and what they cost ───
//
// These are ordinary colour schemes, not CVD palettes, and they are offered
// only because this widget never signals state by hue alone. What must NOT
// happen is one of them quietly claiming to be safe when it is not, so
// isCvdSafe is computed from the simulated colours rather than declared.

describe("aesthetic presets", () => {
    const P = require("../Palette.js");
    const AESTHETIC = ["nord", "gruvbox", "catppuccin", "dracula", "solarized"];
    const CVD = ["deuteranopia", "protanopia", "tritanopia"];

    test("every preset resolves a complete set of roles", () => {
        P.PRESET_NAMES.forEach(function (name) {
            const pal = P.resolvePalette(name, P.DEFAULT_PALETTE);
            P.ROLE_NAMES.forEach(function (role) {
                assert.match(pal[role], /^#[0-9a-fA-F]{6}$/, name + "." + role + " = " + pal[role]);
            });
        });
    });

    test("the three CVD palettes are safe for the condition they are named for", () => {
        CVD.forEach(function (name) {
            assert.equal(P.isCvdSafe(name, name), true, name + " must be safe for " + name);
        });
    });

    test("Solarized is honestly reported as unsafe for deuteranopia", () => {
        // Measured 43 on the redmean scale against a threshold of 50. It is
        // offered anyway, but it must never claim otherwise -- this test
        // exists so that a future palette tweak cannot silently flip the
        // claim without someone noticing.
        assert.equal(P.isCvdSafe("solarized", "deuteranopia"), false);
    });

    test("isCvdSafe is computed, not declared -- an unknown preset is not safe", () => {
        assert.equal(P.isCvdSafe("nonesuch", "deuteranopia"), false);
        assert.equal(P.isCvdSafe(null, "deuteranopia"), false);
    });

    test("every aesthetic preset still has readable body text on its own surface", () => {
        AESTHETIC.forEach(function (name) {
            const pal = P.resolvePalette(name, P.DEFAULT_PALETTE);
            const ratio = P.contrastRatio(pal.surfaceText, pal.surfaceContainer);
            assert.ok(ratio >= 4.5, name + " surfaceText on surfaceContainer is only " + ratio.toFixed(2) + ":1");
        });
    });

    test("aesthetic presets do not mutate the base they were given", () => {
        const base = JSON.parse(JSON.stringify(P.DEFAULT_PALETTE));
        P.resolvePalette("dracula", base);
        assert.deepEqual(base, P.DEFAULT_PALETTE);
    });
});
