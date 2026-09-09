# Design: Phase 4 — notes / export provider

Date: 2026-09-08
Status: 4a ready to implement
Depends on: nothing. Blocks Phase 5 (reader/annotation app).

## Principle

**Obsidian is not an integration. It is a directory of markdown files.** Build
the file writer first and treat Obsidian as a configured instance of it, and
Neovim, Logseq, a plain notes folder and everything else come nearly free.

Providers:

- **Markdown directory** — the base case: a path, a filename template, YAML
  frontmatter. Every markdown tool on earth reads this.
- **Obsidian** — the above plus vault awareness: vault-relative paths,
  wikilink-style tags, and an optional `obsidian://open?vault=…&file=…`
  callback to jump to the note after writing.
- **Neovim** — the above plus an optional `nvim --server … --remote` to open the
  file in a running instance.

**Evernote is not planned.** Its local API was retired; the only paths left are
email-in and manual import, neither of which fits this interface.

## THE SECURITY PROBLEM, which is the real work here

**Feed content is untrusted, attacker-controlled input, and this feature turns
it into filesystem paths.** Everything below follows from that.

An article title is chosen by whoever runs the feed. If the filename template is
`{title}.md` and the title is `../../../.bashrc`, a naive implementation writes
outside the export directory and silently overwrites a shell profile. Subscribe
to a hostile feed, hit "send to notes", lose your dotfiles.

Non-negotiable rules for the path builder, each with a test:

1. **The result must be inside the export directory. Verify, do not assume.**
   Sanitising and *then* re-checking containment catches classes of bug that
   sanitising alone does not.
2. Strip path separators (`/`, `\`) and NUL from every templated value — do not
   merely reject them, since rejecting turns a hostile feed into a broken
   feature rather than a safe one.
3. Reject or rewrite `.` and `..` as whole components.
4. No leading `.` (hidden files) and no leading `-` (argument injection if a
   path is ever passed to a command).
5. Strip `:` — breaks on other filesystems and is meaningful on some.
6. Clamp to **255 bytes**, not characters. `NAME_MAX` is a byte limit, and a
   title of CJK or emoji hits it at ~85 characters. Truncate on a character
   boundary so the result is still valid UTF-8.
7. Empty after sanitising → fall back to the item id, never to an empty name.

**YAML frontmatter is the second injection surface.** A title containing `: `,
or starting with `-`, `[`, `{`, `&`, `*`, `!`, `|`, `>`, `#`, or `%`, breaks
Obsidian's parser or changes the document's meaning. Quote and escape every
templated value; do not concatenate raw strings into YAML. Test with a title
that is itself valid YAML.

**Collisions.** Two articles can share a title. Appending a disambiguator is
required; silently overwriting a previous note is data loss.

## Stage 4a — `ExportProvider.js` (pure, testable)

Same discipline as `Backends.js` and `AiProvider.js`: no `.pragma library`,
`var`, guarded `module.exports`, no I/O.

```js
createExportProvider(config)   // { kind, root, vault, filenameTemplate, tags }
    .buildNote(article, annotations)  -> { relPath, content } | { error }
    .capabilities                     -> { openAfterWrite, wikilinks }
    .openRequest(relPath)             -> descriptor | null
```

`buildNote` is a pure function from data to a path plus a string, which is why
every rule above is testable without touching a filesystem.

## Stage 4b — the QML side

Writing is `Quickshell.Io`'s `FileView` with `setText()`, `blockWrites: true`
and `atomicWrites: true` — verified: DMS writes its own caches exactly this way
(`/usr/share/quickshell/dms/Common/CacheData.qml:282-302`). No shell, no `Proc`.

Atomic writes matter here beyond crash-safety: a half-written note in a vault
is worse than no note, because Obsidian will index and sync the truncated file.

## Testing

Unit, all pure:

- Every path rule above, each with a hostile input: `../../../.bashrc`,
  `a/b`, `..`, `.hidden`, `-rf`, `C:`, a 300-character CJK title, an empty
  title, a title that is entirely separators.
- Containment: assert the resolved path is a child of the export root, for
  every hostile input.
- YAML: a title containing `: `, one starting with `-`, one with quotes, one
  with a newline. Parse the emitted frontmatter back and assert the title
  survives intact.
- Collision: two articles, same title, different ids → different paths.
- Annotation rendering: highlights as blockquotes, notes beneath them, an
  article with no annotations still produces a valid note.
- Provider differences: Obsidian emits wikilink tags, markdown-dir does not.

Plus the QML DI round-trip in `tests/qml/`, as with the other two modules.
