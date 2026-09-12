# Design: stage 1c — settings UI for Google Reader

Date: 2026-09-09
Status: implemented — shipped in 2.4.0
Depends on: Phase 1a/1b (both done)

Google Reader works but is reachable only by hand-editing `plugin_settings.json`.
This makes it a real option, and finishes the job Phase 0 deliberately left.

## Two changes, and only one of them is about Google Reader

### 1. A third source mode and its connection section

`sourceModeSetting` gains `{ label: "Google Reader", value: "greader" }`, and a
Connection section appears for it with **Server URL**, **Username**,
**Password** and **Test Connection**, mirroring the Miniflux one.

The credentials are a *separate* login from the server's web password on
Miniflux — its Google Reader integration has its own username and password,
set under Settings → Integrations. Say so in the field description, because
someone typing their web password will get a bare 401 and no clue why.

**Test Connection** runs `probe` through the same chain machinery as a fetch:
ClientLogin, then `user-info`. Anything less does not prove the credentials
work, since ClientLogin succeeding only proves the *server* is reachable.

### 2. The visibility checks become capability-driven

`DankRssWidgetSettings.qml` carries 17 comparisons of the form
`sourceModeSetting.value === "miniflux"` / `=== "standard"`. That is the same
pattern Phase 0 removed from the widget, still living here because settings
was scoped out. A third mode makes it actively wrong: every
`=== "standard"` that really means "this backend fetches feeds itself" now
silently excludes Google Reader.

Import the backends and ask them, exactly as the widget does:

```qml
readonly property var backends: Backends.createBackends({
    FeedParser: FeedParser, ReaderState: ReaderState, GoogleReader: GoogleReader
})
readonly property var currentBackend: backends[sourceModeSetting.value] || backends.standard
```

Then:

| Section | Was | Becomes |
|---|---|---|
| Feed Management, OPML Import, Quick Add | `=== "standard"` | `!currentBackend.capabilities.serverState` |
| Subscription list (read-only) | `=== "miniflux"` | `currentBackend.capabilities.serverState` |

**Connection sections stay keyed on the mode**, and that is correct rather
than a lapse: a connection form is inherently backend-specific — Miniflux
takes a token, Google Reader takes a username and password. Nothing is
gained by pretending otherwise, and a `capabilities` flag per credential
shape would be a worse abstraction than the string it replaced.

## The trap this stage must avoid

`sourceMode` is persisted. A user on `"greader"` who downgrades to a build
that predates it gets a string no backend matches. The widget already
tolerates this — `backends[sourceMode] || backends.standard` — and the
settings panel must use the same fallback, or it will render a Connection
section for a mode whose backend does not exist and bind to `undefined`.

## Testing

The settings panel is not reachable from `tests/qml/run.sh` (it needs
`qs.Common`, `qs.Widgets` and a live `pluginService`), so this stage is
verified by:

- `qmllint` and `qmlformat` clean.
- A capability-matrix unit test: for each backend id, assert which sections
  *should* be visible, derived from `capabilities` rather than from the QML.
  It cannot prove the QML reads it correctly, but it pins the intended
  mapping so a future capability change has to confront it.
- Manual (Brendon): all three modes selectable; switching to Google Reader
  shows its Connection section and hides Feed Management/OPML/Quick Add;
  Test Connection succeeds against the local Miniflux with the Google Reader
  credentials from `~/secrets/miniflux.env`, and fails informatively with a
  wrong password; switching back to Standard restores the RSS sections with
  feeds intact.

## Out of scope

Per-instance AI feature toggles (Phase 3) and the notes-export settings
(Phase 4) both want settings UI too. They are separate stages; this one adds
a source mode and stops.

---

> **Implemented 2026-09-09.** 17 comparisons → 13. The 13 survivors are all
> Connection-section fields, which is the intended end state.
>
> Two corrections to this doc, made after the fact: the "~40 comparisons"
> figure above was an estimate and wrong — `grep` said 17. And the table
> originally listed a "sort/group by feed" row that does not exist; the only
> sort-related visibility check keys on `sortModeSetting`, not on the source
> mode. Both are recorded rather than quietly edited, because a design doc
> that silently acquires accuracy it never had is worse than one with a
> correction on it.
