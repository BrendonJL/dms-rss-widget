# Notes Export

Press `e` on a row, or use the Export button in the selection bar. Like `m` and
`s`, `e` acts on the whole selection when one exists and on the cursor row
otherwise.

The action is hidden entirely until an export folder is set, so a widget with
nothing configured stays silent — and pressing `e` in that state does nothing,
which is why the `?` overlay leaves the binding out too rather than advertising
a feature that silently fails.

## What gets written

A markdown file per article: YAML frontmatter (title, source, link, date, tags,
`extracted: true|false`), the article text, and a link back to the source.

Tags go in the frontmatter **only**. They used to be repeated in the body as
`[[rss]]`; Obsidian and every other markdown tool read them from the
frontmatter, so the body line was only ever something to delete in every note.

Settings: provider, folder, vault name (Obsidian), filename template, tags, and
the open command.

## Providers

| Provider | Behaviour |
|---|---|
| Markdown directory | Writes the file, opens nothing |
| Obsidian | Writes the file, opens it via `obsidian://open?vault={vault}&file={file}`, and uses wikilinks in the body |
| Neovim | Writes the file, opens it in a running instance or a terminal |

Obsidian keeps its URI form and its wikilink capability because it is a URL
handler rather than an executable, and wikilinks change the note's *content*
rather than how it opens.

## Opening the note in an editor

The file written is identical in every case, so only the command that opens it
differs. The open action is a command template with `{path}` substituted:

| Preset | Template |
|---|---|
| None | *(writes the file only)* |
| Obsidian | `obsidian://open?vault={vault}&file={file}` |
| VS Code | `code {path}` |
| Zed | `zed {path}` |
| Emacs | `emacsclient -n {path}` |
| Neovim (running instance) | `nvim --server $NVIM --remote {path}` |
| Neovim (terminal) | `kitty nvim {path}` |
| Helix | `kitty hx {path}` |
| Vim | `kitty vim {path}` |
| Custom | *(whatever you type)* |

Choosing a preset fills the field, and the field stays editable. That is the
difference between supporting an editor and supporting your setup.

The real split is GUI versus terminal rather than brand. VS Code and Zed ship a
launcher that takes a path; Helix and Vim need a terminal wrapped around them,
and which terminal is your business. **The terminal presets say `kitty` because
that is what the author's machine runs** — edit them.

### Safety

`{path}` is substituted as its own argv element and is never concatenated into a
shell string. Verified against a filename containing a semicolon, quotes and
spaces, which lands as exactly one argument.

Environment variables are deliberately **not** expanded. The Neovim-remote
preset works where the caller's environment already has `$NVIM`; expanding it
ourselves would mean reimplementing shell semantics on attacker-adjacent input
for one preset's convenience.

The editor is launched with `Quickshell.execDetached`, not `Proc.runCommand` —
the latter applies a default timeout and killed the editor a few seconds after
it opened.

### Migration

Configs saved before the preset work map `obsidian` and `neovim` to their
equivalent presets. Presence of the `exportOpenCommand` key, not its value, is
what marks a config as legacy, since an object literal always has the key once
it has been through this.

## Full-text extraction

**Off by default.** With it on, export fetches each article's own page and
extracts the body instead of using the feed's summary. It is opt-in because it
makes one outbound request per exported article to whatever site the feed links
to — a reasonable thing to want and an unreasonable thing to do unasked.

`extracted: true|false` in the frontmatter keeps a mangled extraction
distinguishable from a deliberate summary. A page that cannot be fetched, or
that looks like a section front rather than an article, falls back to the
summary automatically and quietly; the batch and its single toast are unchanged.

Extraction quality is measured against Mozilla Readability — see
[Development](Development.md#testsoracle--measured-extraction-quality).

### What it cleans up

- **Relative links are resolved** against the article's own URL. Site-relative
  (`/news/articles/x`), protocol-relative, document-relative and `../` all become
  absolute. In-page anchors and anything unresolvable degrade to plain text,
  keeping the words and dropping the dead target — a link that looks real and
  goes nowhere is worse than no link, because the reader tries it.
- **"Recommended stories" promo blocks are dropped.** A labelled section
  (`## Recommended Stories`) is dropped up to the next heading of the same or
  higher level. An unlabelled bare list of headline links is dropped only when
  all three of link-only items, at most five items, and prose on both sides hold
  — a long run of link-only blocks is a reference list and real content.

## Writing

Writes go through Quickshell's `FileView` with `atomicWrites`, one `FileView`
per note (`preload: false`, destroyed when it finishes). One toast reports the
batch; a failure names the first article that failed and how many succeeded
rather than abandoning the rest.

Filenames carry a hash disambiguator, and the title is clamped with the hash and
extension reserved, so two long titles cannot collide at the 255-byte boundary.

## See also

- [Architecture](Architecture.md)
- [Development](Development.md)
