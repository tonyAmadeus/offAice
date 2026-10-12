#!/usr/bin/env bash
# 渲染 PV。无法下载 Remotion 自带 Chrome 的环境可设置 REMOTION_BROWSER 指向本地 Chromium/headless_shell。
set -euo pipefail
cd "$(dirname "$0")"
args=()
if [[ -n "${REMOTION_BROWSER:-}" ]]; then args+=(--browser-executable="$REMOTION_BROWSER"); fi
npx remotion render AiroomPV out/airoom-pv.mp4 "${args[@]}" "$@"
