# Design: Phase 4 — notes / export provider

Date: 2026-09-08
Status: implemented (4a, 4b, 4c, 4d) — on `develop`, unreleased
Depends on: nothing. Blocks Phase 5 (reader/annotation app).

> **Status:** stages 4a–4d are all implemented, on `develop` and unreleased.
> 4a is `ExportProvider.js` plus the QML DI round-trip
> (`tests/qml/export-provider.qml`); 4b wired it into the widget (the `e`
> binding, the selection-bar action, the Notes Export settings section, and
> one `FileView` per note); 4c added `HtmlExtract.js` and optional full-text
> extraction; 4d replaced the three fixed provider behaviours with a `{path}`
> open-command template plus editor presets. Two things below were **changed**
> in the course of that: tags are written to the frontmatter only (not
> repeated in the body), and `exportKind` is now the id of an open preset
> rather than a value that fully determines behaviour by itself.

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

### Where the action lives

**The selection bar**, next to Save and Mark read, plus `e` on the keyboard
acting on the selection when there is one and the cursor row otherwise — the
same rule `m` and `s` follow.

Not a per-row button: the row already carries a checkbox, a read toggle and a
bookmark, and a fourth control earns its place only if it is used as often as
those. Not a right-click menu either — that is designed but unbuilt, and this
stage should not block on it.

### Settings

Notes export is **global, not per-instance**. Unlike AI feature toggles, there
is one vault; three widget instances writing to three different folders is a
misfeature, not a feature.

- **Provider** — Markdown directory / Obsidian / Neovim
- **Folder** — absolute path, or vault-relative for Obsidian
- **Vault name** — Obsidian only, needed for the `obsidian://` callback
- **Filename template** — default `{title}.md`
- **Tags** — applied to every note

Show the action only when a folder is set. With nothing configured the widget
must be silent: no affordance, no error, no prompt.

### Writing more than one note

A bulk export of twelve selected articles is twelve writes. `FileView` writes
to one `path` at a time, so they must be **sequential** — set path, `setText`,
wait, next. Firing twelve at one `FileView` races them and some will be lost or
land in the wrong file.

Report once at the end ("12 notes written"), not twelve times. A failure names
the first article that failed and how many succeeded before it; do not abandon
the rest silently, and do not emit a toast per failure.

### Errors

`buildNote` returns `{ error }` when a path escapes the export root — a hostile
feed title, the case that module exists to prevent. Surface it as one toast
naming the article. That path should be unreachable in practice; if a user ever
sees it, it is a bug report worth having.

### Testing

`FileView` is not reachable from `tests/qml/run.sh` (it needs `Quickshell.Io`),
so 4b's write path is verified by:

- Unit: the sequential-queue logic, if it can be extracted as a pure reducer
  over a list of pending writes. If it cannot be extracted cleanly, do not
  contort the code to make it testable — say so and leave it to review.
- Manual (Brendon): export one article and confirm the file appears with
  correct frontmatter; export a multi-item selection and confirm every file
  lands; unset the folder and confirm the action disappears entirely.

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

---

> **Correction, 2026-09-11.** The "Settings" section above says notes export is
> global rather than per-instance. That was written without knowing how DMS
> stores plugin settings, and it is wrong in a way worth recording.
>
> `DesktopPluginWrapper.qml`'s `loadPluginData` reads the widget instance's own
> config and falls back to the shared store; `savePluginData` writes to the
> instance config only. Global-as-default, instance-as-override. **Every**
> setting this plugin has is already per-instance for an instanced widget.
>
> Making one section global required bypassing the plugin API to write
> `SettingsData` directly, which also broke it away from the shared settings
> components — `SelectionSetting` is wired to the instance-scoped path, so the
> provider dropdown could not use it and looked different from every other
> selector in the panel.
>
> So export settings follow the same mechanism as everything else. The stated
> rationale — there is one vault — still holds as a preference; it just is not
> worth one section that works and looks unlike the rest of the panel. If
> per-instance vault paths ever actually bite, the fix belongs in DMS's
> settings model, not in a workaround here.
