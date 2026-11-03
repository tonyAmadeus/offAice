#!/bin/zsh
# Build a minimal, Apple Silicon-only, unsigned local development .app.
# Usage: ./Scripts/package-app.sh
set -euo pipefail
# Image files are required for the restored UI. The pinned original assets are
# obtained automatically before compiling, never by the running app.
# NULL_GLOB also allows the optional SwiftPM resource-bundle loop to be empty.
setopt NULL_GLOB

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "ERROR: This script must run on an Apple Silicon Mac (native arm64 shell)." >&2
  exit 1
fi
if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
  echo "ERROR: Rosetta-translated shells are not supported." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Check every upstream asset even if a file already exists: the fetch script
# verifies the pinned Git blob SHA locally and only downloads missing or
# corrupted files. When offline, verified files require no network access.
echo "Checking pinned upstream artwork (downloading missing assets if needed)..."
if ! ./Scripts/fetch-original-assets.sh; then
  echo "ERROR: Required original artwork could not be downloaded and verified." >&2
  echo "The existing dist/AIROOMNative.app has not been modified." >&2
  exit 1
fi

swift build -c release --product AIROOMNative
BIN="$(swift build -c release --show-bin-path)/AIROOMNative"
if [[ ! -x "$BIN" ]]; then echo "Missing build product: $BIN" >&2; exit 1; fi
ARCHS="$(/usr/bin/lipo -archs "$BIN")"
if [[ "$ARCHS" != "arm64" ]]; then
  echo "ERROR: Expected an arm64-only binary, got: $ARCHS" >&2
  exit 1
fi

# Build in a staging directory so a failed icon or signing step cannot leave
# behind a broken .app or destroy the last good build.
mkdir -p "$PWD/dist"
# Keep build output out of Spotlight/Launchpad; the installed copy is the only app.
touch "$PWD/dist/.metadata_never_index"
STAGING_DIR="$(mktemp -d "$PWD/dist/.app-staging.XXXXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
APP="$STAGING_DIR/AIROOMNative.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# Copy the verified original artwork into the macOS .app (never fetch on app launch).
mkdir -p "$APP/Contents/Resources/Assets"
for image in "$PWD"/Sources/AIROOMNative/Resources/*.webp; do
  cp "$image" "$APP/Contents/Resources/Assets/"
done
# Generate the original app icon when the optional upstream PNG is present.
ORIGINAL_ICON="$PWD/Sources/AIROOMNative/Resources/airoom.png"
if [[ -f "$ORIGINAL_ICON" ]]; then
  ICONSET="$(mktemp -d)/AIROOM.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    /usr/bin/sips -z "$size" "$size" "$ORIGINAL_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    twice=$((size * 2))
    /usr/bin/sips -z "$twice" "$twice" "$ORIGINAL_ICON" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  /usr/bin/iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AIROOM.icns"
  rm -rf "${ICONSET%/*}"
fi
# SwiftPM generates a codeless bundle for Bundle.module. On macOS it belongs
# in Contents/Resources, not Contents/MacOS (which is reserved for executables).
# Placing a .bundle under Contents/MacOS makes codesign treat it as unsigned
# nested code and abort with "code object is not signed at all".
for bundle in "$(swift build -c release --show-bin-path)"/*.bundle; do
  [[ -d "$bundle" ]] || continue
  cp -R "$bundle" "$APP/Contents/Resources/"
done
# Check the exact mistake that caused the earlier packaging failure.
for nested_bundle in "$APP"/Contents/MacOS/*.bundle; do
  echo "ERROR: Unexpected bundle inside Contents/MacOS: $nested_bundle" >&2
  exit 1
done
cp "$BIN" "$APP/Contents/MacOS/AIROOMNative"
chmod 755 "$APP/Contents/MacOS/AIROOMNative"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.airoom.native</string>
<key>CFBundleName</key><string>AIROOM Native</string>
<key>CFBundleDisplayName</key><string>AIROOM Native</string>
<key>CFBundleIconFile</key><string>AIROOM.icns</string>
<key>CFBundleDevelopmentRegion</key><string>zh-Hant</string>
<key>CFBundleLocalizations</key><array><string>zh-Hant</string><string>en</string></array>
<key>CFBundleExecutable</key><string>AIROOMNative</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# Build number = commit count, so each installed/trashed copy is identifiable.
BUILD_NUMBER="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.2.$BUILD_NUMBER" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :AIROOMGitCommit string $BUILD_COMMIT" "$APP/Contents/Info.plist"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
# Sign with the local "AIROOM Local Signing" identity when present: a stable
# identity keeps the Keychain approval valid across rebuilds (ad-hoc signing
# changes identity every build, so macOS asks again and launch blocks until
# someone clicks Allow). Override with AIROOM_SIGN_IDENTITY. Public
# distribution still requires Developer ID and notarization.
# Prefer an Apple Development certificate (free Apple ID in Xcode): its team ID
# gives the Keychain a stable partition, so "Always Allow" survives rebuilds.
# A self-signed certificate keeps the code identity stable, but the Keychain
# still keys on the binary's cdhash and asks again after every build.
IDENTITY="${AIROOM_SIGN_IDENTITY:-$(/usr/bin/security find-identity -p codesigning 2>/dev/null | /usr/bin/awk '/"Apple Development:/ {print $2; exit}')}"
IDENTITY="${IDENTITY:-$(/usr/bin/security find-identity -p codesigning 2>/dev/null | /usr/bin/awk '/"AIROOM Local Signing"/ {print $2; exit}')}"
if [[ -n "$IDENTITY" ]]; then
  /usr/bin/codesign --force --sign "$IDENTITY" "$APP"
else
  echo "WARNING: no 'AIROOM Local Signing' identity; using ad-hoc signing (Keychain will ask again after each update)." >&2
  /usr/bin/codesign --force --sign - "$APP"
fi
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"
if [[ ! -x "$APP/Contents/MacOS/AIROOMNative" ]]; then
  echo "ERROR: Packaged app has no executable; keeping previous build." >&2
  exit 1
fi
FINAL_APP="$PWD/dist/AIROOMNative.app"
rm -rf "$FINAL_APP"
mv "$APP" "$FINAL_APP"
printf '\nBuilt: %s\n' "$FINAL_APP"
/usr/bin/file "$FINAL_APP/Contents/MacOS/AIROOMNative"
