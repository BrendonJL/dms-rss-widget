# CI

The live workflow is `.github/workflows/tests.yml`. `tests.yml.proposed` in
this directory is the version to apply next; Claude cannot write into
`.github/workflows/`, so changes land here first and a human copies them:

    cp docs/ci/tests.yml.proposed .github/workflows/tests.yml

## PENDING — two new jobs, from the pre-v3 CI review

`tests.yml.proposed` adds `qml-types` and `qml-smoke` to the three jobs that
already exist. Everything else in the file is unchanged.

**`qml-types` is the important one.** It closes the gap that took the widget
down on 2026-09-13: a change assigning `lineHeightMode` to a `TextEdit` (a
`Text`-only property) passed CI and then failed at load, because one bad
property makes the type unavailable, which made `ReaderWindow` unavailable,
which stopped the plugin loading. `qmlformat` is a *syntax* check and had no
opinion about it.

`qmllint` does. It cannot resolve the `qs.*` namespace — Quickshell
synthesises those types and ships no qmldir, so that will never work on a
runner — but it resolves plain QtQuick types, which is where that bug lived.
The job greps its output for `missing-property`, `Could not find property`,
`Cannot assign` and `Type .* unavailable`, and fails only on those. Everything
else is unavoidable noise from types it cannot see; treating it as failure
would make the job permanently red and then ignored.

It carries the same self-test discipline as `qml-syntax`: before checking
anything it feeds qmllint a deliberately bad `TextEdit { lineHeightMode: ... }`
and fails if that is NOT flagged. The filter is a regex over free-text
warnings, and a Qt release rewording a message would otherwise disarm the whole
job silently. Verified locally: the fixture trips, and all nine real `.qml`
files pass.

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
