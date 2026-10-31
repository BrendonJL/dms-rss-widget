# Credentials file

## Problem

DMS stores a desktop widget's settings in
`~/.config/DankMaterialShell/settings.json` under
`desktopWidgetInstances[].config`. So `minifluxToken`, `greaderUsername`,
`greaderPassword` and `aiApiKey` sit there in plaintext. That file is commonly tracked in a
dotfiles repo. DMS rewrites it, so it cannot source or include anything, and a
broad commit publishes the secrets.

## Decision

Add a **Credentials file** setting (`credentialsFile`, a path). The widget
reads the file at runtime and settings.json stores only the path.

- **Format:** systemd `EnvironmentFile` syntax, so a single file can also feed a
  Miniflux/FreshRSS container. Rules: `KEY=VALUE` lines, `#` or `;` comment
  lines, and blank lines. Whitespace around the key and the value is trimmed.
  One matching pair of surrounding `"` or `'` is stripped, and an optional
  `export ` prefix is accepted. Not supported: escape sequences, line
  continuations, and variable expansion.
- **Keys (secrets only):** `MINIFLUX_TOKEN`, `GREADER_USERNAME`,
  `GREADER_PASSWORD` and `AI_API_KEY`. Server and AI URLs stay in settings
  because they are not secret, and because there is no common name for them
  across servers (FreshRSS env files use `GREADER_BASE_URL`). `AI_API_KEY`
  rather than `OPENAI_API_KEY`, because the runtime is any OpenAI-compatible
  one, not OpenAI.
- **Precedence: the file wins per key.** A key with a non-empty value in the
  file overrides the matching setting. A missing or empty key falls back to the
  setting, so existing setups keep working and migration can be done one key at
  a time.
- **Path:** a leading `~/` is expanded from `$HOME`, using DMS's own idiom
  (`Quickshell.env("HOME")`).
- **Read failure:** the widget falls back to the settings values and logs the
  path, never the contents. The settings panel shows "Could not read file".

## Where the code lives

- `EnvFile.js`: pure functions `parse(text)`, `expandHome(path, home)` and
  `resolveCredentials(settings, env)`, which returns values plus a per-key
  source of `"file"`, `"settings"` or `"none"`. It does no I/O, under the
  dual-runtime module rules, and is tested under Node.
- `DankRssWidget.qml`: a `FileView` with `blockLoading: true`, so the first
  fetch never runs before the file is read, and `watchChanges: true`, so a
  rotated token takes effect without a restart. The existing
  `minifluxToken`/`greaderUsername`/`greaderPassword`/`aiApiKey` properties
  become resolved values, so the backends and the AI provider see no change.
- `DankRssWidgetSettings.qml`: the path field sits under Source Mode and is
  visible in every mode, because the AI key applies in Standard mode too. It has its own `FileView`. A
  status line names the keys found, never their values. Each overridden field
  gets a text note ("Supplied by credentials file — this field is ignored"), so
  state is not signalled by colour. Test Connection uses the resolved values.

## Rejected

- **Git clean/smudge filter in dotfiles.** It fixes only one person's repo,
  depends on a filter that is easy to lose on a fresh clone, and still leaves
  plaintext in the working tree.
- **File is exclusive once set.** A typo in a key name would silently blank a
  credential, which is worse than falling back.
- **System keyring (`secret-tool`).** Adds a runtime dependency and an async
  lookup before every chain, and does not cover the container that reads the
  same env file.

## Out of scope

The token still travels in curl's argv, which is visible in `/proc` to the same
user. That is unchanged by this design.
