# Staged CI changes

Claude cannot write to `.github/workflows/` — a security hook blocks all
workflow-file writes. Proposed changes are staged here for a human to move.

`tests.yml.proposed` (2026-09-08) vs. the live `tests.yml`:

1. **`.pragma library` check now globs `./*.js`** instead of naming
   `FeedParser.js ReaderState.js`. The list silently stopped covering
   `Backends.js` the day it was added, leaving the exact hole the check exists
   to close.
2. **New `qmllint` job.** QML had no automated checking of any kind; a syntax
   error in ~3000 lines ships today. qmllint cannot resolve `qs.*`/`Quickshell`
   imports in CI and emits warnings for them — expected, and not failures, since
   it exits 0 on warnings and nonzero only on a real parse error. Verified
   locally against both QML files (exit 0) before proposing.

To apply:

    cp docs/ci/tests.yml.proposed .github/workflows/tests.yml

**Then do NOT mark `qmllint` required yet.** Branch protection on `main` lists
required contexts literally (`manifest`, `node 20`, `node 22`, `node 24`); a
required check that never reports hangs every PR. Let it run unrequired on a PR
or two, confirm it reports, then add it.
