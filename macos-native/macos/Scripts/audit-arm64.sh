#!/bin/zsh
# Audit Apple Silicon binary architecture for the app and installed CLI entry points.
# Shell/script wrappers and downloaded native addons require further manual inspection.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo 'Run natively on an Apple Silicon Mac.' >&2; exit 2
fi
APP="${1:-dist/AIROOMNative.app}"
APPBIN="$APP/Contents/MacOS/AIROOMNative"
if [[ ! -x "$APPBIN" ]]; then echo "Missing $APPBIN" >&2; exit 2; fi
if [[ "$(/usr/bin/lipo -archs "$APPBIN")" != 'arm64' ]]; then echo 'App contains non-arm64 architecture.' >&2; exit 1; fi
printf 'App: %s (arm64 only)\n' "$APPBIN"
for command in claude codex node; do
  exe="$(command -v "$command" || true)"
  if [[ -z "$exe" ]]; then echo "$command: not installed (skip)"; continue; fi
  # zsh ties $path to $PATH, so use a different name; :A resolves symlinks.
  exe="${exe:A}"
  desc="$(/usr/bin/file -b "$exe")"
  if [[ "$desc" == *'Mach-O'* ]]; then
    archs="$(/usr/bin/lipo -archs "$exe")"
    if [[ " ${archs} " != *' arm64 '* ]]; then echo "$command: x86_64 ONLY: $exe" >&2; exit 1; fi
    echo "$command: $exe ($archs)"
  else
    echo "$command: $exe ($desc) — script/wrapper: inspect interpreter and native dependencies"
  fi
done
printf 'Direct executables checked. Vendor subprocesses and native .node modules remain separate checks.\n'
