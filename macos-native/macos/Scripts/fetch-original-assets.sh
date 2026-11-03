#!/bin/zsh
# Optional: download unmodified AIROOM artwork from a pinned upstream Git commit.
# Never send credentials. Reject content if its verified Git object SHA differs.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v git >/dev/null || { echo 'Git is required for hash verification.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
ROOT='https://raw.githubusercontent.com/tonyAmadeus/offAice/c6e2b59114763d83c93edeb2758a6cbe2ffbb952'
DEST='Sources/AIROOMNative/Resources'
mkdir -p "$DEST"
while IFS='|' read -r remote name expected; do
  [[ -n "$remote" ]] || continue
  output="$DEST/$name"
  if [[ -f "$output" && "$(git hash-object "$output")" == "$expected" ]]; then
    echo "Verified local asset: $name"
    continue
  fi
  temp="$(mktemp "$DEST/.asset.XXXXXX")"
  if ! curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error --max-time 90 \
       "$ROOT/$remote" -o "$temp"; then
    rm -f "$temp"
    echo "Failed to download $name; original SF Symbol fallback remains available." >&2
    exit 1
  fi
  actual="$(git hash-object "$temp")"
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$temp"
    echo "Asset SHA mismatch for $name. Expected $expected, got $actual" >&2
    exit 1
  fi
  mv -f "$temp" "$output"
  echo "Downloaded and verified: $name"
done <<'ASSETS'
build/airoom.png|airoom.png|0f068854e05426b1ee3d9352da42b0ea0e7e74a9
src/renderer/assets/members/claudia.webp|claudia.webp|ae0a5afde2a86fa48600689e0c9339ab19b644ad
src/renderer/assets/members/gptia.webp|gptia.webp|81ffacdf714ea3a3c55a60410594b56a4da603e9
src/renderer/assets/members/ds.webp|ds.webp|baa3f7f51f0330d6ae2cb7d4803c70f07e4f67dc
src/renderer/assets/members/gemini.webp|gemini.webp|756846a790d447377305da53dee8ed883f3ff2f3
src/renderer/assets/rooms/morning.webp|morning.webp|7e0674b1d49a440700348eb93fb8bbe2b8b8aae5
src/renderer/assets/rooms/afternoon.webp|afternoon.webp|eeac77f36360f8c0a009a702a84e9c2f316c7029
src/renderer/assets/rooms/evening.webp|evening.webp|e5502e1a368fe606a7a4676ca460937588360e56
src/renderer/assets/rooms/night.webp|night.webp|9eba00c742b9be383f5d46e4289ab0d8cbbfbb56
ASSETS

echo 'Done. Run ./Scripts/package-app.sh to bundle these resources.'
