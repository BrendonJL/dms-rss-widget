# CI

CI runs on every push to `main` and every pull request. Four jobs:

| Job | Checks |
|---|---|
| `node 20` / `22` / `24` | `node --test tests/*.test.js` on each Node version |
| `manifest` | `plugin.json` is valid JSON with the required fields; its version has a `### <version>` heading in `CHANGELOG.md`; no `.pragma library` in the shared JS modules |
| `qml-syntax` | Every `.qml` file parses, via `qmlformat` |

The workflow lives in `.github/workflows/tests.yml`. A mirror is kept at
`docs/ci/tests.yml.proposed` in the repo, because the assistant working on this
project cannot write to `.github/workflows/` — a security hook blocks all
workflow-file writes, so changes are staged there for a human to copy:

```bash
cp docs/ci/tests.yml.proposed .github/workflows/tests.yml
```

Diff the two before trusting either.

## Why the changelog check exists

The DMS registry crawls version and author straight out of `plugin.json`. A
bumped manifest with no changelog entry ships a version nobody can read about;
an unbumped manifest ships changes the registry never shows. The `manifest` job
fails either way.

It reads `CHANGELOG.md`. It previously read `README.md`, which is where the
changelog used to live.

## Why the `.pragma` check globs

The shared JS modules are `require()`d by the Node tests, so a stray
`.pragma library` line breaks the suite without breaking the widget. The check
used to list filenames, and silently stopped covering `Backends.js` the day that
file was added. It globs `./*.js` now.

## QML checking: two failed attempts, then the right tool

**qmllint does not work in this repo's CI, and cannot be made to.** It is a type
checker, and the types it would check against live in the DMS shell, which is
not installable on a GitHub runner. Recorded so nobody spends a third round of
CI minutes rediscovering it.

- **Attempt 1** passed locally (Qt 6.11 via Nix) and failed in CI. Not a code
  difference — a version difference. Unresolved imports are warnings on 6.11 and
  fatal on Ubuntu's older Qt.
- **Attempt 2** disabled the noisy categories and probed `--help` for support.
  Still failed: the runner's `qt6-declarative-dev-tools` ships the binary
  *without* the QML module tree, so qmllint cannot load its own builtins
  (`Failed to find the following builtins: jsroot.qmltypes`), and the category
  flags were not honoured anyway.

Every error in both runs traced to one missing dependency. `qs.Common`,
`qs.Widgets` and `Quickshell` cannot resolve, after which `Theme` is unqualified,
`StyledText` is an unknown type, and by cascade even `Rectangle` appears not to
support `color`. None of it was about the code.

**The fix is `qmlformat`, not qmllint.** It parses without resolving anything,
so it needs no module tree, and it ships in the same package. It proves exactly
one thing — the file is syntactically valid QML — which is also the only thing
qmllint could ever have proven in this environment.

That is a small claim, and worth having anyway: a QML syntax error currently
ships silently and breaks the widget at load, with no other tripwire in this
repo.

The job **self-tests first**: it feeds `qmlformat` a deliberately malformed file
and fails the build if that is *accepted*. A syntax checker that cannot fail is
worse than no checker, and a broken tool would otherwise pass every file
silently — which is exactly how the first two attempts would have gone unnoticed
had they failed open instead of closed.

Verified locally in both directions: clean on every `.qml` file, exit 1 on a
malformed property and on a stray closing brace.

**For real semantic checking, run qmllint locally**, where a full Qt and the DMS
shell are present:

```bash
qmllint DankRssWidget.qml
```

## Branch protection

**Do not mark a job a required context until it has reported green at least
once.** Branch protection lists contexts literally, and one that never reports
blocks every PR with no visible cause. The QML job is named `qml-syntax`, renamed
from `qmllint`, so the old context will never report again.

## See also

- [Development](Development.md) — the three test tiers and what each one catches
