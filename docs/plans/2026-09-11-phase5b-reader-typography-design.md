# Design: stage 5b — reader typography

Date: 2026-09-11
Status: implemented — on `develop`, unreleased
Depends on: Phase 5 (the window exists)

From reading a real article in it. The window is right; what it renders is not
typeset.

## What is wrong, from a screenshot

1. **The title appears twice** — once in the window header, then again as the
   body's `# Heading`, because `HtmlExtract` emits the article title as an H1.
   The second one is enormous: Qt scales `h1` hard, and at a 68-character
   measure it wrapped over five lines.
2. **Heading and body metrics disagree.** `lineHeight` applies inside a block;
   Qt's own per-level heading metrics do not follow it, so spacing changes
   depending on what a block happens to contain.
3. **Byline and section links open the body** — "Analysis", "Ben Doherty" —
   rendered as blue links before the first paragraph.

The font being monospace was **not** a bug: it is `Theme.fontFamily`, and this
user's DMS font is Maple Mono by choice. It stays the default.

## Two separate jobs, kept separate

### Normalise the content

A pure function over the extracted markdown, testable, in `HtmlExtract.js`:

- **Drop a leading H1 that duplicates the article title.** Compare
  case-insensitively on collapsed whitespace; drop only when it matches, since
  an article whose first heading genuinely differs should keep it.
- **Demote remaining headings** so the body's top level is H2. The window
  header is the H1; a body H1 competes with it.
- **Drop link-only lines before the first paragraph** — section tags and
  bylines. After the first real paragraph, leave everything alone: a link-only
  line mid-article is the promo case, already handled, and anything else is
  content.

### Own the typography

Stop letting `Text.MarkdownText` decide what a heading looks like. The body is
already split into blocks for paragraph spacing, so classify each block and
apply explicit metrics:

| Block | Size | Weight | Line height |
|---|---|---|---|
| h2 | `bodyFontSize * 1.35` | Medium | 1.3 |
| h3 | `bodyFontSize * 1.15` | Medium | 1.3 |
| paragraph | `bodyFontSize` | Normal | 1.55 |
| list item | `bodyFontSize` | Normal | 1.5 |
| blockquote | `bodyFontSize` | Normal, italic | 1.5 |
| code | `bodyFontSize * 0.9`, mono | Normal | 1.4 |

Relative to `bodyFontSize` rather than absolute, so the whole scale moves
together when the reader's font size changes.

Code blocks use `Theme.monoFontFamily` regardless of the body font — code is
the one thing that genuinely needs it.

## The font setting

Default stays `Theme.fontFamily`: the desktop's font is the right default and
this user likes it.

Add `readerFontFamily` — empty means follow the theme, otherwise a family
name. A plain text field, not a font picker: Qt has no font-list API here
worth the complexity, and a wrong name falls back to the default harmlessly.
Describe it as "leave empty to follow your DMS font".

## Out of scope, recorded for later

**Colour themes.** Everything is currently matugen, matching the system. Worth
offering: a few presets, **colour-blind-safe palettes**, and custom colours.

This is accessibility, not decoration — the widget's owner is colour-blind, and
a generated palette has no reason to respect contrast between the hues a given
person cannot distinguish. Red/green state colours (an error row against an ok
row, unread against read) are exactly where a generated theme can produce two
colours that are identical to a deuteranope.

When built: do not rely on hue alone for any state. Every state that uses
colour should also differ in shape, weight or an icon. That is the fix that
helps regardless of which palette is selected, and it is cheaper than palettes.
