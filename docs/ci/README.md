# CI

The live workflow is `.github/workflows/tests.yml`. `tests.yml.proposed` in
this directory is the version to apply next; Claude cannot write into
`.github/workflows/`, so changes land here first and a human copies them:

    cp docs/ci/tests.yml.proposed .github/workflows/tests.yml

## PENDING — one new job, from the pre-v3 CI review

`tests.yml.proposed` adds **`qml-smoke`** to the three jobs that already exist.
Everything else is unchanged.

**A qmllint job was attempted and abandoned — for the third time.** The reason
is worth keeping so nobody tries a fourth. Ubuntu's `qt6-declarative-dev-tools`
ships the binary without a usable QML module tree, so qmllint cannot resolve
QtQuick, and on some versions cannot load its own builtins. Everything it
reports afterwards is a cascade from that: 120 false positives across this
repo, including `Qt.rgba` and `Qt.openUrlExternally` reading as missing
properties. Installing `qml6-module-qtquick` and friends did not fix it.

The last attempt carried a self-test — feed qmllint a deliberately bad property
and fail if it is NOT flagged. It was not flagged. **The self-test worked
exactly as designed and proved the checker is useless there**, which is the
honest outcome. A permanently red job is worse than no job: a check nobody can
act on is a check everybody learns to ignore.

qmllint DOES work locally, where a full Qt exists, and has already caught a real
bug there — `lineHeightMode` on a `TextEdit`, which stopped the whole widget
loading. Run it before pushing QML; the invocation and its filter are in
`docs/wiki/Development.md`.

**`qml-smoke`** runs `tests/qml/run.sh` — six tests under a real headless
engine, about two seconds. It catches what neither the formatter nor the
linter can: wiring that resolves and type-checks and is still wrong. One
caveat worth knowing — the script has been proven against a Nix Qt, not
against Ubuntu's `qt6-declarative-dev-tools`, and it **skips cleanly (exit 0)**
when it cannot find a runtime. So a green tick alone does not prove it ran;
grep the log for `SKIP:` the first time.

Deliberately NOT added: the extraction oracle. Its value is proven — it has
caught a `ReferenceError` that 689 unit tests missed, and a silent quality
drop from 91.1% to 62.6% — but its fixtures are gitignored and not ours to
redistribute, so CI would have to fetch live from Wikipedia, LWN, the Guardian
and several personal blogs on every PR. For a single maintainer, a gate that
fails over a dead link gets disabled, which is worse than not having it. If it
ever goes in, it belongs on a schedule reporting a number, not on the PR path.

## APPLIED — the changelog check reads `CHANGELOG.md`

The `manifest` job's "version has a changelog entry" step greps for
`### <version>` matching `plugin.json`. It used to read `README.md`, because
that is where the changelog lived; the README was later split, with the detail
going to the wiki and the changelog to `CHANGELOG.md`.

**This has been applied.** The live `.github/workflows/tests.yml` and
`docs/ci/tests.yml.proposed` both grep `CHANGELOG.md` and are identical on this
step. This section stayed marked PENDING long after the change landed, and a
review of CI read it, believed the job was broken, and reported a live outage
that did not exist. A stale "PENDING" is worse than no note — it is a claim
about the present.

The check itself is unchanged otherwise, including the reason it exists: the DMS
registry crawls version and author straight out of `plugin.json`, so a bumped
manifest with no changelog entry ships a version nobody can read about.

The narrative wiki copy of this page is `docs/wiki/CI.md`; keep the two in step
when the workflow changes.

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
