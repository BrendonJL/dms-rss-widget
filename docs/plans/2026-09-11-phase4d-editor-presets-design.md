# Design: stage 4d — open in any editor

Date: 2026-09-11
Status: implemented — on `develop`, unreleased
Depends on: 4b (export)

Notes export as markdown. Opening one afterwards is currently hardcoded to
three providers — markdown-dir (no open), Obsidian (`obsidian://`), Neovim
(`nvim --server`). Adding VS Code, Zed, Helix, Vim or Emacs should not mean
adding five more branches.

## Adding editors is not five integrations, it is one field

The three providers differ in almost nothing. The **file is identical** in
every case — the same markdown in the same folder. The only editor-specific
behaviour is the command that opens it afterwards, plus Obsidian's wikilinks.

So the open action becomes a **command template** with `{path}` substituted:

| Preset | Template |
|---|---|
| None | *(empty — write the file and stop)* |
| Obsidian | `obsidian://open?vault={vault}&file={file}` (a URI, not a command) |
| VS Code | `code {path}` |
| Zed | `zed {path}` |
| Emacs | `emacsclient -n {path}` |
| Neovim (running instance) | `nvim --server $NVIM --remote {path}` |
| Neovim (terminal) | `kitty nvim {path}` |
| Helix | `kitty hx {path}` |
| Vim | `kitty vim {path}` |
| Custom | *(whatever the user types)* |

The preset fills the field; the field stays editable. That is the difference
between supporting an editor and supporting the user's setup.

## The real distinction is GUI versus terminal, not brand

VS Code, Zed and Emacs ship a launcher that takes a path and does the right
thing. Helix, Vim and terminal Neovim do not — they need a terminal emulator
wrapped around them, and **which terminal is the user's business**. A
hardcoded "Helix" provider would have to guess, and would be wrong for most
people. A template lets each user state what their setup actually is.

The presets above assume `kitty` because that is what this machine runs. They
are a starting point to edit, not a claim about anyone's system, and the field
description should say so.

## Security: substitution, not string building

`{path}` is substituted as **its own argv element**, never concatenated into a
shell string. The template is trusted local config; the path is derived from
feed content, which is not. `ExportProvider` already sanitises the path, but
argv separation is what makes a filename containing a space, a quote or a
semicolon a non-event rather than a shell injection.

The template is split on whitespace into argv. That means a template cannot
contain a quoted argument with spaces in it — an acceptable limit for the
shape of command this is, and better than invoking a shell to parse it.

`$NVIM` and other environment variables are **not** expanded by us; the
Neovim-remote preset works only where the caller's environment already has it.
Expanding variables ourselves would mean reimplementing shell semantics on
attacker-adjacent input, for one preset's convenience.

## What stays a capability

Obsidian's wikilink tags remain a capability flag, not a template — it changes
the note's *content*, not how it opens. Obsidian also keeps its URI form,
since it is a URL handler rather than an executable.

## Settings

Replace the Provider dropdown's three options with the preset list above.
Selecting a preset fills the command field; editing the field does not change
the preset back. Store `exportOpenCommand` alongside the existing keys.

## Testing

- Templating: `{path}` substituted as one argv element; a path containing
  spaces, quotes and semicolons survives intact; a template with no `{path}`
  is rejected rather than silently opening nothing.
- Every preset parses to a plausible argv.
- Empty template returns null, meaning write-and-stop.
- Obsidian still returns its URI, not an argv.
