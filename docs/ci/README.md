# Staged CI changes

Claude cannot write to `.github/workflows/` — a security hook blocks all
workflow-file writes. Proposed changes are staged here for a human to move:

    cp docs/ci/tests.yml.proposed .github/workflows/tests.yml

## 2026-09-09 (second revision) — qmllint job

The first version of this job **passed locally and failed in CI**, which is
worth understanding before touching it again.

qmllint cannot resolve `qs.Common`, `qs.Widgets`, `Quickshell` or anything
reached through them, because the DMS shell is not installable in CI. Every
semantic finding then cascades from that single missing dependency: `Theme` is
unqualified, `StyledText` is an unknown type, and by extension even `Rectangle`
appears not to support `color`. None of it says anything about the code.

The failure was a **version difference**, not a code difference. On Qt 6.11
(the local Nix build) qmllint reports those as warnings and exits 0. On the
older Qt that Ubuntu's runner installs, they are fatal.

So the job now:

1. **Disables the categories that depend on the missing modules** — `import`,
   `unqualified`, `missing-type`, `missing-property`, `unresolved-type`,
   `unresolved-alias`, `missing-enum-entry`.
2. **Probes `--help` first** and passes only the flags that binary actually
   supports. These flags have come and gone across Qt releases, and an unknown
   option is itself fatal — which would reproduce the same failure by a new
   route.

### What the check is actually worth

Syntax validation, and nothing semantic. That is a smaller claim than the
first version made, and it is still worth having: a QML syntax error currently
ships silently and breaks the widget at load, with no other tripwire anywhere
in this repo.

Verified both directions locally — clean on every current `.qml` file, and
**exit 255** on a deliberately malformed one. A check that cannot fail is
worse than no check, so if you change the flag set, re-confirm both.

**Do not mark `qmllint` a required context until it has reported green at
least once.** Branch protection lists contexts literally, and one that never
reports blocks every PR with no visible cause.
