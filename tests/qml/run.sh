#!/usr/bin/env bash
# Run the QML-side smoke tests under a real Qt QML engine, headless.
#
# The design docs used to claim QML could not be executed here. It can. Two
# things are required and BOTH fail silently if missing:
#
#   QT_QPA_PLATFORM=offscreen   - no display needed
#   QML2_IMPORT_PATH=<qt>/qml   - without this the `qml` tool prints only
#                                 "Did not load any objects, exiting." with no
#                                 error, which is almost certainly why this was
#                                 written off as impossible.
#
# console.log does NOT reach stdout through this binary, so each test signals
# its result via a STAGED EXIT CODE: every checkpoint sets a distinct code
# before the risky call, so a failure says how far it got rather than just
# "it broke". Each .qml file documents its own codes.
set -uo pipefail

QT_DIR="${QT_DIR:-$(dirname "$(readlink -f "$(command -v qml 2>/dev/null)")" 2>/dev/null)/..}"
if [ ! -x "$QT_DIR/bin/qml" ]; then
  QT_DIR=$(ls -d /nix/store/*-qtdeclarative-*/ 2>/dev/null | sort -V | tail -1)
fi
if [ ! -x "$QT_DIR/bin/qml" ]; then
  echo "SKIP: no qml runtime found (set QT_DIR)" >&2
  exit 0
fi

cd "$(dirname "$0")"
fail=0
for f in *.qml; do
  # The JS modules live at the repo root; qml resolves imports relative to the
  # .qml file, so link them in rather than duplicating.
  for js in ../../*.js; do ln -sf "$js" "$(basename "$js")" 2>/dev/null; done
  QT_QPA_PLATFORM=offscreen QML2_IMPORT_PATH="$QT_DIR/lib/qt-6/qml" \
    "$QT_DIR/bin/qml" "$f" >/dev/null 2>&1
  code=$?
  if [ "$code" = "55" ]; then
    echo "ok   $f"
  else
    echo "FAIL $f (exit $code -- see the code table in $f)"
    fail=1
  fi
done
rm -f ./*.js
exit $fail
