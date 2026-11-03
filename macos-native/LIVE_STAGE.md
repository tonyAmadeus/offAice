# 直播舞台：TTS + VTube Studio（Live2D）

左側「直播舞台」設定；茶歇室的「雙 AI 同台直播」開始後自動套用。

## 流程

```text
AI 回覆（可含 [happy] 等情緒標籤）
  → LiveCueParser：只認 8 種白名單情緒，其他標籤丟棄；共用紀錄只存去標籤後的文字
  → LiveEvent（speaker / utterance / emotion / turnID / sequence）
  → LiveStageController：觸發該情緒對應的 VTS 熱鍵 → macOS TTS 念出 → 依音量 30 Hz 注入 MouthOpen
  → 念完才進入下一輪（兩位 AI 不會同時說話）
```

## 第一次設定（兩位各一個 VTube Studio）

1. 第一個 VTS 從 Steam 開啟，載入 GPT 娘的模型（通常是連接埠 **8001**）。
2. 第二個 VTS：執行 `~/Library/Application Support/Steam/steamapps/common/VTube Studio/start_without_steam`，載入 Claude 的模型，它會自動使用 **8002**。
3. 兩個 VTS 都到設定開啟 **Start API**。
4. AIROOM →「直播舞台」→ 勾選「連接 VTube Studio」→ 在每位成員卡確認連接埠、按「連線」→ 在對應的 VTS 視窗按 **Allow**。授權 Token 各自存在本機加密資料。
5. 把各情緒對應到該模型的熱鍵，勾選「用語音念出發言」，選聲音 → 按「試演」。
6. OBS：兩個 VTS 各是一個 NDI 來源；聲音從系統預設輸出播放，以「桌面音訊」擷取。

## 限制（尚未完成）

- TTS 使用 macOS 內建聲音；更自然的聲音需在系統設定下載「加強版／高品質」語音。外部 TTS 服務尚未串接。
- 直播平台留言（YouTube／Bilibili）仍需手動插入；OBS + 直播姬雙端推流之後處理。
- VTS 實機連線、熱鍵與嘴型同步尚待你在裝好 VTube Studio 後驗收；協定層以模擬 VTS 的單元測試覆蓋。
