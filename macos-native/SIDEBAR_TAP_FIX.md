# AIROOM Native：側邊欄整列可點擊修復

## 原因

在 SwiftUI 的 `Button` 使用 `.buttonStyle(.plain)` 時，`Spacer` 和未填色的留白通常不參與點擊命中測試。這會造成看似整列選取，但只有文字／圖示能按的狀況。

## 本次修改

- `macos/Sources/AIROOMNative/ContentView.swift` 新增 `studioSidebarHitTarget()` 共用樣式。
- 在按鈕 **label 內**，先 `.frame(maxWidth: .infinity, alignment: .leading)` 撐滿整列，再 `.contentShape(Rectangle())` 把透明區域納入點擊範圍。
- 套用到首頁 Logo、所有側邊導覽列（茶歇室、圓桌、用量與額度、排程與直播、待你處理、管理人物卡及設定等）、成員卡入口與專案列。
- 成員列最右側的「開啟工位」仍是**獨立**的小按鈕，避免兩個動作互相覆蓋。
- 選中列左側的色條設為 `.allowsHitTesting(false)`，避免裝飾遮住點擊。

## 編譯與更新

在 `macos` 目錄執行：

```sh
swift test
./Scripts/package-app.sh
open dist/AIROOMNative.app
```

要套用到上一版 `AIROOMNative_LiveCollaboration_avatar_editor.zip` 的原始碼，在**專案根目錄**執行：

```sh
git apply /path/to/AIROOMNative_Sidebar_fullrow_click.patch
```

此 Patch 只修改 `ContentView.swift`，不更動本機聊天紀錄、圖片或 Keychain。

## 驗證

- Linux Swift 6.2.1：SwiftUI 檔案語法解析通過。
- Foundation 核心測試：74/74 通過。
- 實際滑鼠點擊命中範圍仍須在你的 macOS 上驗收（Linux 無法建置 SwiftUI）。
