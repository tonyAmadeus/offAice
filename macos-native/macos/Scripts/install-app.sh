#!/bin/zsh
# Install dist/AIROOMNative.app into /Applications, replacing the previous copy.
# The old copy is moved to the Trash (restorable), never deleted. User data in
# ~/Library/Application Support/AIROOMNative and the Keychain key are untouched.
# Usage: ./Scripts/install-app.sh [--open]
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="$PWD/dist/AIROOMNative.app"
TARGET="/Applications/AIROOMNative.app"
BUNDLE_ID="dev.airoom.native"

if [[ ! -x "$SOURCE/Contents/MacOS/AIROOMNative" ]]; then
  echo "ERROR: $SOURCE not found. Run ./Scripts/package-app.sh first." >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$SOURCE"

# Quit a running copy so its last state is saved before the bundle is swapped.
if pgrep -f "AIROOMNative.app/Contents/MacOS/AIROOMNative" >/dev/null; then
  echo "Quitting running AIROOM Native..."
  /usr/bin/osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in {1..50}; do
    pgrep -f "AIROOMNative.app/Contents/MacOS/AIROOMNative" >/dev/null || break
    sleep 0.2
  done
  if pgrep -f "AIROOMNative.app/Contents/MacOS/AIROOMNative" >/dev/null; then
    echo "ERROR: AIROOM Native is still running. Quit it manually and retry." >&2
    exit 1
  fi
fi

if [[ -e "$TARGET" ]]; then
  OLD_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$TARGET/Contents/Info.plist" 2>/dev/null || echo old)"
  TRASHED="$HOME/.Trash/AIROOMNative-$OLD_VERSION-$(date +%Y%m%d-%H%M%S).app"
  mv "$TARGET" "$TRASHED"
  echo "Moved previous version to Trash: $TRASHED"
fi

# Move (not copy) so only one AIROOMNative.app exists for Spotlight/Launchpad.
mv "$SOURCE" "$TARGET"
/usr/bin/codesign --verify --deep --strict "$TARGET"
echo "Installed: $TARGET ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$TARGET/Contents/Info.plist"))"

if [[ "${1:-}" == "--open" ]]; then
  /usr/bin/open "$TARGET"
fi
