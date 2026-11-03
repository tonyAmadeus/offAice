# AIROOM Native — 內建頭像裁切編輯器

## 如何使用

1. 開啟 AIROOM，從左側選擇 **管理人物卡**。
2. 選擇 Claude 或 Codex，按 **調整頭像**。
3. 直接拖曳圓形預覽中的人物，調整頭部位置；也可以透過 **縮放、水平位置、垂直位置**滑桿微調。
4. 使用 46px 與 88px 即時預覽確認效果，按 **儲存** 才會套用。若要放棄請按 **取消**；按 **恢復預設位置** 然後儲存可回到原始裁切值。

- 新設定存在每一張 `MemberCard.avatarCrop` 內，跟其他設定一起使用現有 Keychain 金鑰加密；原始 WebP 不會修改，也不需要重新編譯。
- 側邊欄、人物卡、聊天室、茶歇室、圓桌和額度頁的圓形頭像都共用同一個設定。**全身立繪**仍保留原始顯示方式，不會被裁切。
- 舊的 `state.aesgcm` 不含 `avatarCrop` 時自動回退原版臉部位置，沒有資料遷移或帳號變更。
- 圖片不存在時編輯器不允許儲存假裁切；使用 `macos/Scripts/package-app.sh` 自動從原始 repo 的固定 Commit 下載並校驗素材，再開啟程式。

## 驗證

- `swift test`：74/74 項 Foundation 核心測試通過，新增 5 項裁切編輯、舊版資料相容及幾何安全測試。
- `swiftc -frontend -parse`：SwiftUI 與 Core 原始碼皆通過語法解析。
- 這個環境不是 macOS，因此 **無法執行 SwiftUI 型別檢查、簽章、打包或視覺實測**。請在 Apple Silicon Mac 執行 `./Scripts/package-app.sh` 並確認裁切與儲存後重新開啟仍有效。
