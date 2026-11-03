# Shared AI Context Rooms / 多 AI 共用上下文

This update prioritizes one **canonical, encrypted AIROOM transcript** that
multiple selected, independently authenticated official CLI agents can read.
It is **not** access to either vendor desktop app's private thread, and it
**does not synchronize Claude App and Codex App's built-in conversations**.

## 使用方式

1. 打開「共用上下文對話室」，確認 Claude 和 Codex 已安裝並由其官方 CLI 登入。
2. 勾選要參與討論的成員。輸入第一個問題；選「所有在場成員」讓成員依序回答。
3. 第二位成員在開始前會收到「使用者 + 第一位已完成的回覆」，日後每輪也會收到同一份共用歷史（長度受控）。
4. 可指定單一成員回覆；其他成員下一次發言時仍看得到這次成功的回答。
5. 「新話題」建立獨立房間，不會刪除原本房間；從標題選單返回舊房間可繼續討論。
6. 長對話的上下文最多包含最近 48 則、22,000 字元左右的完成紀錄，每位成員可以在介面看到省略了幾則較早發言。每次新訊息限制 8,000 字。

## 資料語意與安全

- 只有 `RoomDelivery.completed` 的使用者與 AI 訊息被送入下一位 AI 的提示詞。進行中、失敗或中斷的 AI 回覆不會進入後續上下文。
- 每條訊息標記說話者、代理服務和顯示名稱；其他模型的內容是未受信任的文字，不是可執行指令。
- 當 App 意外結束時，尚未完成的回覆在下次啟動改標為 interrupted，不會自動重試。
- 歷史和話題以現有的 Keychain/AES-GCM 儲存在本機。**發送訊息時，共用對話紀錄會透過官方 CLI 傳送到你所選的每一家 AI 供應商**，不保證只留在你的電腦，也不保證所有供應商有相同的保留政策。
- 這個模式每輪使用新的 CLI 請求並附上文字歷史，**不是廠商原生 Session ID 共用**。透過「開啟 Codex/Claude 桌面 App」進去的新對話，不會自動接續 AIROOM 的共用歷史。
- 目前本地參與者是 Codex、Claude。Gemini、DeepSeek、Qwen、Kimi 等需等官方 CLI 介面與 macOS 沙箱驗證後再加入。
- 文件/圖像共享、長期摘要記憶、互評投票、完整六階段專案編排仍未實作；專案寫回仍需你手動批准。

## Mac 驗收

```zsh
cd macos
swift test
./Scripts/package-app.sh
open dist/AIROOMNative.app
```

手動檢查：Claude 提出觀點 A → Codex 回覆引用 A → 只指定 Codex 追加 B → 再指定 Claude 並要求比較 A/B；新增獨立話題驗證 A/B 不會被帶入，再回原話題驗證其歷史仍存在。停止中途的回覆不應出現在另一位成員的提示詞中。
