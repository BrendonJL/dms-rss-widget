# Staged CI changes

> **Status:** the qml-syntax job below is live in `.github/workflows/tests.yml`
> (applied in `ebea5c5`). `tests.yml.proposed` is kept in sync as a mirror, not
> a pending change — diff it against the real workflow before trusting either.

Claude cannot write to `.github/workflows/` — a security hook blocks all
workflow-file writes. Future changes get staged here for a human to move:

    cp docs/ci/tests.yml.proposed .github/workflows/tests.yml

## 2026-09-09 — QML checking: two failed attempts, then the right tool

**qmllint does not work in this repo's CI, and cannot be made to.** It is a
type checker, and the types it would check against live in the DMS shell,
which is not installable on a GitHub runner. Recorded here so nobody spends a
third round of CI minutes rediscovering it:

- **Attempt 1** passed locally (Qt 6.11 via Nix) and failed in CI. Not a code
  difference — a version difference. Unresolved imports are warnings on 6.11
  and fatal on Ubuntu's older Qt.
- **Attempt 2** disabled the noisy categories and probed `--help` for support.
  Still failed: the runner's `qt6-declarative-dev-tools` ships the binary
  *without* the QML module tree, so qmllint cannot load its own builtins
  (`Failed to find the following builtins: jsroot.qmltypes`) and the category
  flags were not honoured anyway.

Every error in both runs traced to one missing dependency. `qs.Common`,
`qs.Widgets` and `Quickshell` cannot resolve, after which `Theme` is
unqualified, `StyledText` is an unknown type, and by cascade even `Rectangle`
appears not to support `color`. None of it was about the code.

**The fix is `qmlformat`, not qmllint.** It parses without resolving anything,
so it needs no module tree, and it ships in the same package. It proves
exactly one thing — the file is syntactically valid QML — which is also the
only thing qmllint could ever have proven in this environment.

That is a small claim, and worth having anyway: a QML syntax error currently
ships silently and breaks the widget at load, with no other tripwire in this
repo.

The job **self-tests first**: it feeds qmlformat a deliberately malformed file
and fails the build if that is *accepted*. A syntax checker that cannot fail
is worse than no checker, and a broken tool would otherwise pass every file
silently — which is exactly how the first two attempts would have gone
unnoticed had they failed open instead of closed.

Verified locally in both directions: clean on every `.qml` file, exit 1 on a
malformed property and on a stray closing brace.

**For real semantic checking, run qmllint locally**, where a full Qt and the
DMS shell are present:

    qmllint DankRssWidget.qml

**Do not mark `qml-syntax` a required context until it has reported green at
least once.** Branch protection lists contexts literally, and one that never
reports blocks every PR with no visible cause. Note the job is renamed from
`qmllint` to `qml-syntax`, so the old context will never report again.
