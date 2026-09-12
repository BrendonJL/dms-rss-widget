// Colour theme presets for the Dank RSS Widget.
//
// PURE, same discipline as KeyMap.js / ChainRunner.js: no Qt APIs, no I/O,
// no Date.now(), no randomness, no require()-ing a sibling module. Loaded by
// both QML (`import "Palette.js" as Palette`) and Node (`require()`), so
// there is no `.pragma library` line -- that is not valid JavaScript and
// breaks require() outright.
//
// WHY THIS EXISTS: the widget currently takes every colour from DMS's
// matugen-generated `Theme` singleton (docs/plans/BACKLOG.md, "Colour theme
// presets"). `Theme` is a `pragma Singleton` shared process-wide -- a plugin
// must never write to `Theme.*`, since that would leak into the whole shell
// (bar, popups, other plugins). This module therefore never touches Theme at
// all: it takes a base palette as an ARGUMENT (the QML side reads Theme and
// passes its values in) and returns a resolved one.
//
// The widget's owner has deuteranopia. A matugen theme has no reason to
// preserve contrast between hues a given person cannot distinguish, and the
// widget signals state (error/success, read/unread) with colour. The three
// colour-vision-deficiency presets below exist to fix exactly that.
//
//   var resolved = Palette.resolvePalette(settings.colourPreset, themeColours);
//   var withOverrides = Palette.applyOverrides(resolved, settings.customColours);

// The semantic roles the widget actually uses, named to match DMS's own
// matugen/Theme token names so the QML rename (docs/plans/BACKLOG.md) is
// mechanical: role name in Palette.js == property name on Theme.
var ROLE_NAMES = [
    "primary",
    "secondary",
    "surfaceText",
    "surfaceVariantText",
    "error",
    "success",
    "warning",
    "outlineVariant",
    "surfaceContainer",
    "surfaceContainerHigh",
    "surfaceContainerHighest",
    "onPrimary",
    "onError"
];

// Sane built-in default, used to fill in a missing/partial base palette so a
// caller never gets `undefined` colours. Values mirror Theme.qml's own dark
// theme fallbacks (/usr/share/quickshell/dms/Common/Theme.qml) so a widget
// that never received a real Theme snapshot still looks like DMS. Theme.qml
// has no literal default for outlineVariant (it derives one from `outline`,
// which we don't have here) or onError, so those two are reasonable M3-ish
// neutrals rather than a value lifted from Theme.qml.
var DEFAULT_PALETTE = {
    primary: "#42a5f5",
    secondary: "#8ab4f8",
    surfaceText: "#e3e8ef",
    surfaceVariantText: "#c4c7c5",
    error: "#f2b8b5",
    success: "#4caf50",
    warning: "#ff9800",
    outlineVariant: "#938f99",
    surfaceContainer: "#1e2023",
    surfaceContainerHigh: "#292b2f",
    surfaceContainerHighest: "#343740",
    onPrimary: "#ffffff",
    onError: "#000000"
};

// --- Colour parsing -------------------------------------------------------
//
// Accepts #rgb, #rrggbb and 8-digit hex. Qt (and therefore QML colour
// strings) uses #AARRGGBB, not CSS's #RRGGBBAA, so an 8-digit string here is
// read as alpha-first. That is a deliberate, documented choice, not an
// oversight -- this module runs inside a Qt/QML host.
//
// Returns {r, g, b, a} with each channel 0-255, or null if the string isn't
// a recognised colour. Alpha is parsed but never used by contrastRatio() or
// simulate(): both treat colours as opaque, since blending against a
// specific background is the caller's job, not this module's.
function parseColour(colour) {
    if (typeof colour !== "string") return null;
    var s = colour.trim();
    if (s.charAt(0) !== "#") return null;
    s = s.slice(1);

    if (/^[0-9a-fA-F]{3}$/.test(s)) {
        var r3 = s.charAt(0), g3 = s.charAt(1), b3 = s.charAt(2);
        return {
            r: parseInt(r3 + r3, 16),
            g: parseInt(g3 + g3, 16),
            b: parseInt(b3 + b3, 16),
            a: 255
        };
    }
    if (/^[0-9a-fA-F]{6}$/.test(s)) {
        return {
            r: parseInt(s.slice(0, 2), 16),
            g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16),
            a: 255
        };
    }
    if (/^[0-9a-fA-F]{8}$/.test(s)) {
        // #AARRGGBB (Qt convention).
        return {
            a: parseInt(s.slice(0, 2), 16),
            r: parseInt(s.slice(2, 4), 16),
            g: parseInt(s.slice(4, 6), 16),
            b: parseInt(s.slice(6, 8), 16)
        };
    }
    return null;
}

function isValidColour(colour) {
    return parseColour(colour) !== null;
}

function toHex2(n) {
    var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return h.length === 1 ? "0" + h : h;
}

function rgbToHex(r, g, b) {
    return "#" + toHex2(r) + toHex2(g) + toHex2(b);
}

// --- WCAG 2.1 contrast ratio ----------------------------------------------
//
// Relative luminance formula from WCAG 2.1 ("Relative Luminance"), including
// the 0.03928 linearisation threshold specified there (a later erratum in
// some secondary sources uses 0.04045 to match the sRGB spec exactly; this
// module follows the WCAG 2.1 text itself since that is the standard being
// tested against).
function srgbChannelToLinear(c) {
    var cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb) {
    var r = srgbChannelToLinear(rgb.r);
    var g = srgbChannelToLinear(rgb.g);
    var b = srgbChannelToLinear(rgb.b);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.1 contrast ratio: (L1 + 0.05) / (L2 + 0.05), L1 the lighter colour.
// Returns null (rather than throwing) if either colour can't be parsed.
function contrastRatio(colourA, colourB) {
    var a = parseColour(colourA);
    var b = parseColour(colourB);
    if (!a || !b) return null;

    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    var lighter = Math.max(la, lb);
    var darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
}

// --- Colour-vision-deficiency simulation -----------------------------------
//
// Approximate dichromacy simulation via fixed 3x3 matrices applied in linear
// RGB, from Machado, Oliveira & Fairchild, "A Physiologically-based Model
// for Simulation of Color Vision Deficiency" (IEEE TVCG, 2009). These are
// the same matrices widely reused by browser devtools and CVD-simulation
// tools (e.g. Chromium's rendering emulation) for 100%-severity dichromacy,
// applied directly to linear sRGB rather than round-tripping through LMS
// space per-pixel -- Machado et al.'s point is that the two are equivalent
// for a fixed severity, which is all "simulate a preset's own condition"
// needs here.
var CVD_MATRICES = {
    protanopia: [
        [0.152286, 1.052583, -0.204868],
        [0.114503, 0.786281, 0.099216],
        [-0.003882, -0.048116, 1.051998]
    ],
    deuteranopia: [
        [0.367322, 0.860646, -0.227968],
        [0.280085, 0.672501, 0.047413],
        [-0.011820, 0.042940, 0.968881]
    ],
    tritanopia: [
        [1.255528, -0.076749, -0.178779],
        [-0.078411, 0.930809, 0.147602],
        [0.004733, 0.691367, 0.303900]
    ]
};

function linearToSrgbChannel(c) {
    var v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, v * 255));
}

// Approximates how `colour` appears to someone with `condition`
// (deuteranopia/protanopia/tritanopia). Unknown condition or unparsable
// colour returns the input colour unchanged (never throws) -- "no
// simulation" is a safe, honest fallback.
function simulate(colour, condition) {
    var rgb = parseColour(colour);
    var matrix = CVD_MATRICES[condition];
    if (!rgb || !matrix) return colour;

    // sRGB -> linear (reuse the WCAG linearisation; close enough for an
    // approximation, and keeps this module to one gamma convention).
    var r = srgbChannelToLinear(rgb.r);
    var g = srgbChannelToLinear(rgb.g);
    var b = srgbChannelToLinear(rgb.b);

    var rr = matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b;
    var gg = matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b;
    var bb = matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b;

    return rgbToHex(
        linearToSrgbChannel(Math.max(0, Math.min(1, rr))),
        linearToSrgbChannel(Math.max(0, Math.min(1, gg))),
        linearToSrgbChannel(Math.max(0, Math.min(1, bb)))
    );
}

// Low-cost approximate perceptual colour distance ("redmean"), Thiadmer
// Riemersma, https://www.compuphase.com/cmetric.htm -- cited here because
// tests need SOME distance metric to prove two simulated colours remain
// visually distinct, and full CIEDE2000 is out of scope for a dependency-
// free module. redmean is the standard cheap stand-in: it weights the R/G/B
// terms by a rough approximation of human luminance sensitivity instead of
// treating RGB as a flat cube, which plain Euclidean RGB distance does not.
// Exposed mainly so the tests can share it with this module rather than
// reimplementing it, but useful to a caller wanting a numeric "how different
// are these two swatches" without a full contrast-ratio comparison.
function colourDistance(colourA, colourB) {
    var a = parseColour(colourA);
    var b = parseColour(colourB);
    if (!a || !b) return null;

    var rMean = (a.r + b.r) / 2;
    var dR = a.r - b.r;
    var dG = a.g - b.g;
    var dB = a.b - b.b;
    return Math.sqrt(
        (2 + rMean / 256) * dR * dR +
        4 * dG * dG +
        (2 + (255 - rMean) / 256) * dB * dB
    );
}

// --- Presets ----------------------------------------------------------------
//
// Every non-neutral hue below is a real value from a published colour-blind-
// safe qualitative palette, not an intuited hex code -- that is the entire
// point of this feature. Neutral/near-achromatic roles (surface text and
// containers) are carried over unchanged from DEFAULT_PALETTE: greyscale-ish
// colours aren't where hue confusion happens, and keeping them stable keeps
// the widget's chrome recognisable across presets.
//
// deuteranopia & protanopia (red-green colour blindness, ~99% of CVD cases
// between them): both confuse the red/green axis, so both draw from Okabe &
// Ito, "Color Universal Design (CUD)" (2008), https://jfly.uni-koeln.de/color/
// -- the standard reference palette for exactly this, explicitly built so
// every colour in the set stays distinguishable under both conditions. The
// headline move: success moves from green to Okabe-Ito's blue (#0072B2),
// error moves from red to Okabe-Ito's vermillion (#D55E00), so the
// error/success pair now differs on the blue-yellow axis red-green CVD does
// not damage, instead of the red-green axis it does.
var DEUTERANOPIA_PALETTE = {
    primary: "#009e73",           // Okabe-Ito bluish green
    secondary: "#f0e442",         // Okabe-Ito yellow
    surfaceText: DEFAULT_PALETTE.surfaceText,
    surfaceVariantText: DEFAULT_PALETTE.surfaceVariantText,
    error: "#d55e00",             // Okabe-Ito vermillion
    success: "#0072b2",           // Okabe-Ito blue
    warning: "#e69f00",           // Okabe-Ito orange
    outlineVariant: DEFAULT_PALETTE.outlineVariant,
    surfaceContainer: DEFAULT_PALETTE.surfaceContainer,
    surfaceContainerHigh: DEFAULT_PALETTE.surfaceContainerHigh,
    surfaceContainerHighest: DEFAULT_PALETTE.surfaceContainerHighest,
    onPrimary: "#000000",
    onError: "#000000"
};

// Protanopia and deuteranopia share the Okabe-Ito assignment above: the
// palette's own design goal is simultaneous safety for both, so there is no
// published reason to pick different hues per condition -- only the
// simulation matrix used to verify them (below, and in the tests) differs.
var PROTANOPIA_PALETTE = {
    primary: DEUTERANOPIA_PALETTE.primary,
    secondary: DEUTERANOPIA_PALETTE.secondary,
    surfaceText: DEFAULT_PALETTE.surfaceText,
    surfaceVariantText: DEFAULT_PALETTE.surfaceVariantText,
    error: DEUTERANOPIA_PALETTE.error,
    success: DEUTERANOPIA_PALETTE.success,
    warning: DEUTERANOPIA_PALETTE.warning,
    outlineVariant: DEFAULT_PALETTE.outlineVariant,
    surfaceContainer: DEFAULT_PALETTE.surfaceContainer,
    surfaceContainerHigh: DEFAULT_PALETTE.surfaceContainerHigh,
    surfaceContainerHighest: DEFAULT_PALETTE.surfaceContainerHighest,
    onPrimary: DEUTERANOPIA_PALETTE.onPrimary,
    onError: DEUTERANOPIA_PALETTE.onError
};

// tritanopia (blue-yellow colour blindness, rare): the red/green axis is
// intact here, so error/success can stay close to conventional red/green --
// the danger for this condition is blue vs. green and yellow vs. violet/pink
// looking alike. Drawn from Paul Tol's "bright" qualitative scheme,
// https://sronpersonalcolour.com/2011/09/22/spanning-a-colour-scale/ and
// https://personal.sron.nl/~pault/ (Tol is the other credible published
// source for CVD-aware qualitative palettes alongside Okabe-Ito). Primary is
// Tol's purple rather than blue specifically to keep it away from success's
// green -- blue/green is the confusable pair for tritanopia.
var TRITANOPIA_PALETTE = {
    primary: "#aa3377",           // Tol bright purple
    secondary: "#4477aa",         // Tol bright blue
    surfaceText: DEFAULT_PALETTE.surfaceText,
    surfaceVariantText: DEFAULT_PALETTE.surfaceVariantText,
    error: "#ee6677",             // Tol bright red
    success: "#228833",           // Tol bright green
    warning: "#ccbb44",           // Tol bright yellow
    outlineVariant: DEFAULT_PALETTE.outlineVariant,
    surfaceContainer: DEFAULT_PALETTE.surfaceContainer,
    surfaceContainerHigh: DEFAULT_PALETTE.surfaceContainerHigh,
    surfaceContainerHighest: DEFAULT_PALETTE.surfaceContainerHighest,
    onPrimary: "#ffffff",
    onError: "#000000"
};

var PRESETS = {
    deuteranopia: DEUTERANOPIA_PALETTE,
    protanopia: PROTANOPIA_PALETTE,
    tritanopia: TRITANOPIA_PALETTE
};

// --- Public API --------------------------------------------------------

// Fills in any missing/invalid role on `base` from DEFAULT_PALETTE, without
// mutating `base`. A malformed value (wrong type, unparsable colour string)
// is treated the same as a missing one, rather than being passed through to
// poison downstream rendering with an invalid colour.
function fillDefaults(base) {
    var out = {};
    var source = base && typeof base === "object" ? base : {};
    for (var i = 0; i < ROLE_NAMES.length; i++) {
        var role = ROLE_NAMES[i];
        var value = source[role];
        out[role] = isValidColour(value) ? value : DEFAULT_PALETTE[role];
    }
    return out;
}

// Returns a fresh palette object with only recognised roles overridden by
// `overrides`; unknown keys and malformed colour values are ignored rather
// than poisoning the result. Never mutates `palette` or `overrides`.
function applyOverrides(palette, overrides) {
    var out = {};
    var source = palette && typeof palette === "object" ? palette : {};
    for (var i = 0; i < ROLE_NAMES.length; i++) {
        var role = ROLE_NAMES[i];
        out[role] = isValidColour(source[role]) ? source[role] : DEFAULT_PALETTE[role];
    }

    if (overrides && typeof overrides === "object") {
        for (var j = 0; j < ROLE_NAMES.length; j++) {
            var r = ROLE_NAMES[j];
            if (isValidColour(overrides[r])) out[r] = overrides[r];
        }
    }
    return out;
}

// Resolves a named preset against a base palette (typically Theme's current
// colours, read and passed in by the QML side -- this module never touches
// Theme itself). "system" (the default, mirroring the "empty follows the
// theme" idiom used by readerFontFamily) and any unrecognised preset name
// both return the base palette unchanged, filled out with defaults where
// incomplete -- following the system theme is the zero-surprise default,
// and an unknown preset must never throw or produce undefined colours.
// "custom" applies `overrides` on top of the base (see applyOverrides).
function resolvePalette(presetName, basePalette, overrides) {
    var base = fillDefaults(basePalette);

    if (!presetName || presetName === "system") return base;
    if (presetName === "custom") return applyOverrides(base, overrides);

    var preset = PRESETS[presetName];
    if (!preset) return base;

    // Presets are complete, self-contained role sets (see comment above
    // each one): they are not merged with `base` because the whole point is
    // a palette whose error/success/primary hues are verified distinguish-
    // able together, which merging in an arbitrary base primary could break.
    var resolved = {};
    for (var i = 0; i < ROLE_NAMES.length; i++) {
        resolved[ROLE_NAMES[i]] = preset[ROLE_NAMES[i]];
    }
    return resolved;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        ROLE_NAMES: ROLE_NAMES,
        DEFAULT_PALETTE: DEFAULT_PALETTE,
        resolvePalette: resolvePalette,
        applyOverrides: applyOverrides,
        contrastRatio: contrastRatio,
        simulate: simulate,
        colourDistance: colourDistance
    };
}
