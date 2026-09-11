# Design: Phase 5 — reading window

Date: 2026-09-11 (rewritten; supersedes the annotation-app design of the same day)
Status: design only, blocked on judging extraction quality
Depends on: 4c (extraction), 4b (export)

A window that shows one article properly. The widget triages; this reads.

## What changed, and why the first design was wrong

The original Phase 5 was a reader **and annotation** app: highlights, margin
notes, an annotation store, and a fuzzy-anchoring module to re-locate
highlights after an article was refetched. Anchoring was called "the whole risk
of this phase", staged first and alone because if it could not be made reliable
the phase needed rethinking.

It has been rethought, on a better principle: **let the text editor do the text
editing.** Notes are exported as markdown and opened in Obsidian, Neovim, VS
Code or whatever the user runs. Highlighting happens there, in the file, and
how it renders is the editor's business.

That deletes the hard parts outright. There is no pointer into refetched text
to maintain, so there is no anchoring problem, no orphaned-highlight
degradation, no annotation store, and no cap-per-article storage question.
`Anchor.js` will not be written.

What remains is the part that was never the risk: showing prose well.

## Why a window at all, if the editor reads it

Because not everything is worth saving. The widget's rows are a list; deciding
whether an article deserves a place in your vault needs more than a two-line
summary and less than a full export-and-switch. This is the surface between
"skim the headline" and "commit it to my notes".

## The content is the same; the presentation is not

The window shows exactly what `HtmlExtract` produced — the same markdown that
gets exported. It will not read better because the text is better. It reads
better because the widget deliberately destroys structure and this does not.

`htmlToText` flattens everything for the list, correctly: a row rendering `<h2>`
and `<ul>` would be worse than useless. Here, **Qt renders the markdown
natively** — `textFormat: Text.MarkdownText`, verified working on Qt 6.11 with
headings, bold, links, lists, blockquotes and code. No library, no dependency.

Then typography, which is where reading comfort actually comes from:

- **Measure of 60-75 characters.** The single largest factor, and the one the
  widget structurally cannot provide: it is sized for a desktop corner, not for
  prose.
- Line height around 1.5; the list needs tighter.
- 16-18px body text, against the list's 11px.
- Real paragraph spacing, a centred column, honest margins.
- The DMS theme's colours, so it belongs to the desktop.

## Scope

- **5a** — the window: layout, typography, scrolling, DMS theming.
- **5b** — keyboard, reusing `KeyMap.js`'s vocabulary: `j`/`k` scroll, `o`
  opens externally, `e` exports, `s` saves, `Esc` closes.
- **5c** — opened from the widget on a key and on a row action, showing the
  cursor row.

No annotation. No highlight capture. If reading in the window makes the user
want to mark something up, the answer is `e` — export it and open it in the
editor, which is better at this than we will ever be.

## What would make it fail

**Extraction quality**, which is now the critical path rather than a
nice-to-have. This window displays what `HtmlExtract` produces at reading size,
so anything it gets wrong is magnified rather than hidden. Judge the extracted
markdown before building this; a bigger view of a bad extraction is worse than
no view.

**Scope creep.** A reading window can absorb infinite work — themes, fonts,
reading positions, sync, per-site rules. It should be plain and unconfigurable
until it is pleasant to read, and gain options only after.
