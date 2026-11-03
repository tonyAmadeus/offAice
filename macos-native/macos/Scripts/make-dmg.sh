#!/bin/zsh
# Wrap dist/AIROOMNative.app in a drag-to-install disk image.
# Usage: ./Scripts/package-app.sh && ./Scripts/make-dmg.sh
# The image is signed with the same identity as the app but NOT notarized:
# on another Mac, Gatekeeper asks before the first launch (System Settings →
# Privacy & Security → Open Anyway).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$PWD/dist/AIROOMNative.app"
if [[ ! -x "$APP/Contents/MacOS/AIROOMNative" ]]; then
  echo "ERROR: $APP is missing; run ./Scripts/package-app.sh first." >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$APP"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG="$PWD/dist/AIROOMNative-$VERSION.dmg"

# Stage the app next to an Applications link, then build a compressed, read-only image.
STAGING="$(mktemp -d "$PWD/dist/.dmg-staging.XXXXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
/usr/bin/ditto "$APP" "$STAGING/AIROOMNative.app"
ln -s /Applications "$STAGING/Applications"

rm -f "$DMG"
/usr/bin/hdiutil create -quiet -volname "AIROOM Native" -srcfolder "$STAGING" -fs HFS+ -format UDZO -ov "$DMG"

IDENTITY="${AIROOM_SIGN_IDENTITY:-$(/usr/bin/security find-identity -p codesigning 2>/dev/null | /usr/bin/awk '/"Apple Development:/ {print $2; exit}')}"
if [[ -n "$IDENTITY" ]]; then
  /usr/bin/codesign --force --sign "$IDENTITY" "$DMG"
  /usr/bin/codesign --verify "$DMG"
fi
/usr/bin/hdiutil verify -quiet "$DMG"

printf 'Built: %s (%s)\n' "$DMG" "$(/usr/bin/du -h "$DMG" | cut -f1)"
