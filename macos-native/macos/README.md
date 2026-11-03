# AIROOM Native for macOS — SwiftUI / Apple Silicon

> **Independent, native macOS implementation based on offAice's documented features and interface behavior.** It does **not** reuse or distribute upstream TypeScript/Electron source. It is a functional native alternative, **not** a 1:1 feature-complete port of upstream AIROOM 0.1. Some original workflows remain unimplemented.

## 繁體中文

### 特色

- **純 SwiftUI / AppKit + Foundation**：無 Electron、Chromium、WebView、React，無綑綁 Node.js，也沒有第三方 Swift 套件。
- **Apple Silicon arm64 專用**：macOS 14+，本機打包時使用 `lipo` 檢查執行檔；不需 Rosetta 來執行 App 本體。請另外核對官方 CLI 及其子程序架構。
- **繁體中文／英文介面**：設定 →「介面語言」可即時切換，選擇儲存在加密的 `state.aesgcm`，舊設定自動使用繁體中文。
- **Claude Code / Codex App Server**：Claude 優先使用 Claude Desktop 的 Code 分頁安裝的內附 CLI，Codex 則透過官方 `codex app-server` JSON-RPC，優先使用 ChatGPT.app 內附執行檔；唯讀單人聊天、串流回覆、手動停止、近況重建。
- **成員卡與原版 UI 風格**：暖色紙張與燈光配色、工作室首頁、人物展示、專案導覽、茶歇室背景、外觀明暗切換；自訂顯示名稱、角色設定、啟用狀態；在「管理人物卡」可透過「調整頭像」直接拖曳及縮放，裁切設定加密保存。原版圖片可透過 `Scripts/fetch-original-assets.sh` 從鎖定的 Git Commit 下載並驗證（不包含於本 ZIP）。
- **多 AI 共用上下文對話室**：Claude/Codex 接收同一份持久化、具角色標記的對話歷史；只有已完成的回覆能進入下一位的上下文。支援單一／所有成員回覆、獨立話題房間、較早紀錄截斷提示及中斷恢復。詳見 `SHARED_CONTEXT.md`。
- **獨立圓桌**：Claude 與 Codex 分別回答相同問題，保存歷史比較。
- **專案工作區**：建立原始資料夾的工作副本，由 Codex 在副本中修改，列出新增、修改、刪除與文字預覽；**使用者明確批准**後才做衝突檢查並寫回。可額外請 Claude 進行唯讀審查。
- **資料儲存、備份與還原**：在 macOS 上使用 Keychain 保管裝置綁定的 AES-GCM 金鑰，儲存 `state.aesgcm` 與加密 `.airoombackup`；不保存官方 CLI 帳號憑證。舊的 `state.json` 在成功加密驗證後才刪除。

### ⚠️ 重要限制

- **共用的是 AIROOM 本地紀錄，不是 Codex App／Claude Desktop 的原生 Session。** 每個請求仍是獨立執行（Codex 使用一次性的 App Server thread），將近期對話作為具角色標記的提示詞重送；完整原生跨廠商 Session 同步並不存在。已完成的跨廠商歷史會傳到你選取的每一家 AI 服務商。詳見 `SHARED_CONTEXT.md`。
- **這不是原版完整功能移植。** 尚未實作原版持續 CLI session、ACP 更多執行端、完整多 Agent 專案編排、原版所有安全稽核、排程與額度查詢。
- 工作副本是人工審查機制，**不是作業系統安全沙箱**。CLI 仍以登入使用者權限啟動。Codex App Server 使用官方 `workspace-write` 沙箱模式，但仍須在實機驗證 CLI 版本、沙箱行為與權限。不要用不可信的提示或專案執行寫入任務；不要假設網路已被限制。
- `WorkspaceStaging` 目前限制 2,000 檔案、256 MiB；遇到大型專案可能拒絕建立副本。拒絕符號連結與不正常檔案；不完整的安全邊界不可取代 App Sandbox。
- **加密與備份限制**：macOS 的 `state.aesgcm` 和 `.airoombackup` 採用 Keychain 的裝置綁定金鑰；備份**不能直接移到另一台 Mac 解密**。如果 Keychain 遺失、拒絕存取或簽章身分改變，程式會停止儲存而不會退回明文。舊版 `state.json` 及舊 `.json` 備份可能仍存在於其他位置，請自行安全處理。備份不包含工作副本、原始專案檔案或官方 CLI 帳號密鑰。
- **資料最小化**：只複製允許的工作區檔案；排除常見 `.env`、`.git`、SSH、雲端憑證、私鑰及含典型 Token 文字的檔案，偵測到工作副本新增同類檔案時拒絕寫回。此為啟發式過濾，**不能保證攔截未知格式的秘密**。
- **唯讀任務**：CLI 在過濾後的暫存工作副本執行。因未提供完整作業系統沙箱，CLI 仍可使用登入者權限讀取工作副本以外的檔案，也能向官方或其自行選擇的網域連線；不能保證無外傳。
- Claude Code 優先使用 Claude Desktop 的 Code 分頁安裝的版本化執行檔（位於 `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`），若找不到才搜尋 PATH 中的獨立 CLI。Claude Desktop 剛安裝但尚未使用 Code 分頁時，執行檔可能不存在。桌面 App 登入狀態不保證外部命令執行已授權；需實際以官方 CLI 登入檢查驗證。Codex 可使用已安裝 ChatGPT.app／Codex.app 所附的 CLI 執行檔，或另行安裝並登入。檢測只涵蓋主程式及直接執行檔；腳本背後的 Node、原生外掛及動態下載模組仍須實機查驗。
- 目前程序停止直接呼叫 `Process.terminate()`；**未保證所有 CLI 子程序都被一併終止**。因此停止後應人工檢查結果。
- macOS SwiftUI 程式尚未在真正 Apple Silicon 機器上建置／執行。Linux Swift Toolchain 只驗證 Foundation 核心與語法，不等於完整 App 驗收。
- 原作者 repository 未提供明確授權條款。若要公開發行或使用原版素材／程式碼，請先取得合適授權。

### 本機建置

需要 Apple Silicon Mac、macOS 14+、Xcode 與 Swift 工具鏈，並先在 Claude Desktop 登入、開啟 Code 分頁；Claude 會優先偵測該 App 安裝的 Claude Code，Codex 會優先偵測 ChatGPT.app／Codex.app 內附的 CLI（符合條件時均無須另行安裝）：

```zsh
cd macos
# 可選：下載並驗證原作者人物立繪、四張背景與程式圖示
./Scripts/fetch-original-assets.sh
swift test
./Scripts/package-app.sh
open dist/AIROOMNative.app
./Scripts/audit-arm64.sh
```

`.app` 為本地開發用途，使用 adhoc 簽章；公開發行需要 Apple Developer ID、Hardened Runtime、Notarization 等程序。

在設定頁將路徑留空即可自動偵測；也可手動填入 `/opt/homebrew/bin/claude`、`/opt/homebrew/bin/codex`、`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app` 或實際安裝位置。登入程序由官方 CLI 自行處理；App 不會要求 OAuth Token 或密碼。

## English

AIROOM Native is a lightweight SwiftUI application for Apple Silicon Macs. It contains no Electron/Chromium, bundled Node runtime, WebView or third-party Swift dependency. The **interface is switchable between Traditional Chinese and English** under Settings → Interface Language, and the selected language is saved locally.

Implemented: Claude Code CLI and Codex App Server JSON-RPC execution, streamed single-agent read-only chat, agent cards, **bounded shared transcript rooms with verified completed-only turn propagation**, sequential lounge, independent roundtable, project copy/review/writeback with optional second-agent review, and **Keychain-backed AES-GCM encrypted local state and backups on macOS**. Old plaintext `state.json` files migrate only after encrypted verification. Backups are device-bound and do not transfer to another Mac without an explicit key export/re-wrap feature. The original AIROOM persistent sessions, full multi-agent project engine, automatic CLI installers, ACP provider catalog, notifications and scheduling are **not** yet implemented.

**Safety:** Read-only commands run in a sanitised temporary work copy that omits common credential paths and detectable embedded secrets; child CLI processes receive a minimal allowlisted environment without inherited API keys, proxy secrets, SSH agent sockets or `NODE_OPTIONS`. CLI output and error diagnostics redact recognised tokens and no debug files are generated by this app. **This is NOT an operating-system sandbox**: a vendor CLI can read other user-accessible paths and use the network. The regex-based secret filter is not comprehensive. Codex App Server uses `sandbox: "workspace-write"` for project tasks but that behavior and any child processes must be verified on Apple Silicon. The CLI process is stopped directly, not necessarily all descendants. No automatic retry of uncertain operations. Users should keep highly sensitive projects outside CLI-accessible folders.

Build on an Apple Silicon Mac:

```sh
cd macos
swift test
./Scripts/package-app.sh
open dist/AIROOMNative.app
./Scripts/audit-arm64.sh
```

### Testing status

- `swift test`: **Foundation core tests passed** on Linux x86_64 (mock CLI, including privacy guards and injectable encryption test double; no real paid model requests). macOS Keychain and CryptoKit paths are not exercised on Linux.
- `swiftc -frontend -parse Sources/AIROOMNative/*.swift`: SwiftUI source syntax parses (not macOS type checking).
- macOS arm64 executable build, Finder launch, actual CLI auth and sandbox behavior: **not verified here**.

### Project layout

```text
macos/
├── Package.swift
├── Scripts/package-app.sh
├── Scripts/fetch-original-assets.sh  # optional, verified original artwork
├── Scripts/audit-arm64.sh
├── Sources/AIROOMCore/       # Foundation-only persistence, prompts, CLI bridge, staging, translations
├── Sources/AIROOMNative/     # SwiftUI views and workbench state
└── Tests/AIROOMCoreTests/    # deterministic core tests
```

## Usage & quota (Native restoration)

Select **用量與額度 / Usage & Quotas** in the sidebar to refresh the Codex and Claude subscription limits from their official executables. Codex uses `account/rateLimits/read` via app-server; Claude first confirms the built-in `/usage` command through its `stream-json` control protocol. Missing/expired data never becomes an invented zero. Samples expire after 15 minutes and remain in volatile memory. This implementation does **not** yet implement upstream quota-aware automatic speaker throttling. See `../FEATURE_PARITY.md`.

## Feature Wave — live co-hosts, schedules, roundtable reviews, six-step projects

See `../START_HERE.md` and `../FEATURE_PARITY.md` for instructions, status and
limitations. Live co-hosting is an explicitly started, bounded text conversation;
there is no actual audio/stream/chat-platform integration yet. Existing local
state remains encrypted; no provider credentials are copied into this project.
