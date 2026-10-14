# 使用真实账号的诊断

这里的脚本会调用正式成员程序，使用 `--profile` 指定目录内的真实登录，并消耗模型额度。它们不属于普通测试或 `npm run verify`。

运行前必须取得账号所有者同意，并从托盘彻底退出 AIROOM。脚本要求同时传入 `--use-real-account --app-closed`，Windows 上还会检查 AIROOM 是否仍在运行。脚本不会复制登录凭据；宿主会话变量会在调用成员程序前清掉。

```powershell
node --import tsx scripts/real-account/benchmark-room-runtime.ts --profile="$env:USERPROFILE\.airoom\data" --use-real-account --app-closed
node --import tsx scripts/real-account/benchmark-room-engine.ts --profile="$env:USERPROFILE\.airoom\data" --use-real-account --app-closed
```

普通单元、界面与桌面冒烟均使用独立临时账号目录。诊断会在资料目录里留下记录，脚本不会删除它们，是否清理由账号所有者决定。
