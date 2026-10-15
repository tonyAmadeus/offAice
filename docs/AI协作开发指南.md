# AIROOM AI 协作开发指南

> 写给想用 Claude Code、Codex、Cursor 等 AI 编程助手来**理解、删减、修改** AIROOM，并**构建、部署**成自己版本的用户。
> 你不需要会写代码，但需要会打开终端、复制命令、看懂“通过 / 失败”。

本指南分两部分：前半部分写给你，告诉你怎样把需求交给 AI，以及怎样检查 AI 做得对不对；后半部分是给 AI 看的项目约定，开工时让它先读完。

---

## 目录

- [一、准备开发环境](#一准备开发环境)
- [二、开场：让 AI 先读懂项目](#二开场让-ai-先读懂项目)
- [三、怎样描述你的需求](#三怎样描述你的需求)
- [四、改完后怎样检查](#四改完后怎样检查)
- [五、运行、部署与打包](#五运行部署与打包)
- [六、出问题怎么回退](#六出问题怎么回退)
- [七、给 AI 的项目约定](#七给-ai-的项目约定)
- [八、常见改法速查](#八常见改法速查)
- [九、后续优化建议和方向](#九后续优化建议和方向)

---

## 一、准备开发环境

只需准备一次。

1. **系统**：Windows 10 / 11 x64，并安装 Microsoft Edge（界面测试会用它）。
2. **Git**：从 <https://git-scm.com> 安装。
3. **Node.js 26**：从 <https://nodejs.org> 安装。项目锁定的 npm 12 要求 Node.js `^22.22.2`、`^24.15.0` 或 `>=26.0.0`，推荐 26。
4. **取得源码**，在终端里运行：

   ```powershell
   git clone https://github.com/tonyAmadeus/offAice.git AIROOM
   cd AIROOM
   npm ci
   ```

   `npm ci` 会按锁文件安装全部开发依赖，第一次需要几分钟。

5. **先跑一遍**，确认环境没问题：

   ```powershell
   npm run dev
   ```

   能看到 AIROOM 窗口就说明环境就绪。开发版的资料放在项目文件夹里的 `.airoom`，和日常版的资料（`%USERPROFILE%\.airoom\data`）分开，试验不会影响日常使用。两者不能同时打开：开着一个时再打开另一个，只会唤起已经打开的那个窗口。

6. **建议先建一个自己的分支**，所有修改都在分支上做，日后好回退：

   ```powershell
   git switch -c my-changes
   ```

---

## 二、开场：让 AI 先读懂项目

在 AIROOM 文件夹里打开你的 AI 助手（例如在该目录运行 `claude` 或 `codex`），第一句话可以直接复制下面这段：

```text
这是 AIROOM 项目，一个 Electron + React + SQLite 的 Windows 桌面程序。
开工前请先完整阅读：
1. README.md（用户怎么用）
2. docs/技术说明.md（架构、模块、构建与测试）
3. docs/AI协作开发指南.md 的“七、给 AI 的项目约定”和“八、常见改法速查”
读完后用不超过 15 行概括：项目由哪几个进程组成、界面怎样调用后台、数据存在哪里、怎样验证改动。
在我确认之前不要修改任何文件。
```

AI 的概括里应该提到这几点：主进程、执行服务、界面三部分；界面通过 `window.airoom.invoke` 发请求，请求名必须登记在 `src/shared/rpc-methods.ts`；数据存放在 SQLite；用 `npm run verify` 验证。漏掉其中某项，就让它回去再读。

> **想让 AI 每次都自动遵守这些约定？** 可以在项目根目录新建 `AGENTS.md`（Codex、Cursor 等会读取）或 `CLAUDE.md`（Claude Code 会读取），内容写一句“开工前先阅读 docs/AI协作开发指南.md 第七、八节并遵守”。这两个文件只影响你本机的 AI 助手。

---

## 三、怎样描述你的需求

### 好需求的四要素

| 要素 | 例子 |
| --- | --- |
| **在哪里** | “茶歇室输入框旁边的图片按钮” |
| **现在是什么样** | “点了以后只能选 Codex 成员画图” |
| **想变成什么样** | “隐藏这个按钮，我用不到画图” |
| **不能动什么** | “已有聊天记录里的图片要能照常显示” |

### 三类请求的说法

**理解**（只读，不改文件）：

```text
只读，不要修改文件。请解释“项目会议室”从我点“确认方案，开工”到任务开始执行，
中间经过了哪些文件和函数。用流程图式的列表回答，每一步标出文件路径和函数名。
```

**删减**：

```text
我想去掉“成员闲聊”（自动功能里成员自己在茶歇室聊天）这个功能。
请先列出要删或要改的文件、请求名、设置项、测试和样式，以及删掉后会受影响的其他功能，
等我确认后再动手。已有资料里的旧设置不能导致程序打不开。
```

**修改或新增**：

```text
我想在成员工位的话题列表里加一个“按名称搜索”的输入框。
先说方案：改哪些文件、要不要新增后台请求、要加哪些测试。等我确认后再写代码。
改完运行类型检查和相关测试，把结果原样告诉我。
```

### 让 AI 分步做

1. **先要方案，再让它动手。**AI 列出改动清单后，你确认范围合适再说“开始”。
2. **一次只做一件事。**大需求拆成几步，每步验证通过后提交一次（`git commit`），再做下一步。
3. **要原始结果。**让 AI 把测试输出原样贴出来，不要只听它说“都通过了”。

---

## 四、改完后怎样检查

### 自动检查

| 想确认 | 命令 | 大致耗时 |
| --- | --- | --- |
| 代码能否通过类型检查 | `npm run typecheck` | 1 分钟内 |
| 某个测试文件是否通过 | `node --import ./scripts/test-bootstrap.mjs --import tsx --test tests/文件名.test.ts` | 几秒到 1 分钟 |
| 某组界面冒烟是否通过 | `node --import ./scripts/test-bootstrap.mjs --import tsx tests/ui/文件名-smoke.mjs` | 每组几十秒 |
| 全部单元与集成测试 | `npm test` | 几分钟 |
| **完整验证**（发布前必跑） | `npm run verify` | 较长，视电脑性能而定 |

`npm run verify` 依次运行类型检查、全部单元与集成测试、全部界面冒烟、构建和桌面冒烟，任何一步失败就停止。所有测试都使用临时的、未登录的资料目录，**不会动你的日常资料，也不会调用真实模型**。

### 亲手检查

自动测试通过后，用 `npm run dev` 打开开发版，亲手点一遍你改的地方，再看看相邻的功能。改的是“项目会议室”，就把茶歇室和成员工位也打开看一眼。

### 看改动

```powershell
git status          # 改了哪些文件
git diff            # 每处具体改了什么
git diff --stat     # 只看统计
```

AI 改了你没让它改的文件，可以直接问它“这个文件为什么要改”，或者让它撤回那部分。

---

## 五、运行、部署与打包

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 开发运行 | `npm run dev`，或双击 `Start-AIROOM-Dev.cmd` | 每次先构建最新代码再打开 |
| 用当前构建运行 | `npm run build`，然后 `npm start` | |
| 更新桌面上的日常版 | `npm run deploy` | 见下文 |
| 生成免安装绿色包 | `npm run package:green` | 输出 `release/AIROOM-<版本>-Windows-x64-Green.zip` |
| 生成安装包 | `npm run package` | 输出 `release/AIROOM-Setup-<版本>.exe` 和便携版 |

### 开发版用哪份资料

开发版默认使用项目文件夹里的 `.airoom`，不会碰日常资料。想换一份干净的试验资料，在启动前设置 `AIROOM_DATA_DIR`：

```powershell
$env:AIROOM_DATA_DIR = "$env:USERPROFILE\.airoom-try"
npm run dev
```

### 部署到日常版（`npm run deploy`）

`npm run deploy` 构建当前代码，用它更新**桌面上的 `AIROOM` 文件夹**，并刷新桌面和开始菜单的快捷方式。

- **第一次**：桌面上还没有 `AIROOM` 文件夹时，先把下载的绿色包完整解压到桌面，并把文件夹命名为 `AIROOM`。也可以运行 `npm run package:green`，再把 `release\win-unpacked` 复制过去。之后部署都只需 `npm run deploy`。
- **部署前**：先从托盘彻底退出 AIROOM（右键托盘图标 → 退出），否则部署会拒绝执行。
- **要备份**：运行 `npm run deploy -- -Backup`，部署前会先备份资料，备份失败就不替换任何文件。
- **在哪里运行**：在普通的 PowerShell 或 Windows Terminal 里运行。部分 AI 助手在受限沙箱里执行命令，那里写不到桌面，部署会报“normal-integrity”相关错误。这时把命令复制到自己的终端运行即可。
- 部署只替换程序文件，**不动**聊天记录、人物卡、登录信息和备份。

### 打包给别人用

1. 先提交所有修改（`git commit`）。打包脚本会拒绝把未提交的改动打成分发包。
2. 运行 `npm run package:green`。脚本会检查文件清单、解压后逐个核对哈希，并生成 `.sha256` 校验文件。
3. `release` 里已有同名 ZIP 时脚本会停止，以免覆盖已发布的文件。先把旧 ZIP 挪到别处。
4. 想改版本号，改 `package.json` 里的 `version`。

包里只有程序和必要依赖，不含你的账号、聊天记录或成员程序。未签名的程序首次运行可能出现“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”即可；正式签名见 [技术说明](技术说明.md) 里的 `package:signed`。

### 从 AI 助手里启动程序的注意事项

AI 助手的终端里带着它自己的登录变量（`CLAUDE*`、`ANTHROPIC*`、`CODEX*` 等）。从那里直接启动 AIROOM 日常版，成员程序可能读错账号。启动日常版请双击桌面快捷方式。开发版的 `npm run dev` 和测试会清理这些变量，可以放心用。

---

## 六、出问题怎么回退

| 情况 | 做法 |
| --- | --- |
| 改坏了，还没提交 | `git restore .` 放弃全部未提交修改（新建的文件用 `git status` 查看后手动删除） |
| 已提交，想回到上一个好版本 | `git log --oneline` 找到那次提交，`git revert <提交号>` 生成一个撤销提交 |
| 整个分支都不要了 | `git switch main`，回到原来的代码 |
| 日常版部署后出问题 | 回到能用的代码，再运行一次 `npm run deploy`；或者重新解压一份官方绿色包到桌面 `AIROOM` 文件夹 |
| 资料出问题 | 程序里“设置与连接 → 工作台 → 备份”，选一份备份“准备恢复”再恢复 |

建议在大改之前先在程序里备份一次资料。

---

## 七、给 AI 的项目约定

> 本节写给 AI 助手。修改代码前请完整阅读，并在回复里遵守。

### 7.1 结构

```
Electron 主进程 (src/main)          窗口、托盘、IPC 白名单、登录辅助
   │  MessagePort
执行服务 utilityProcess (src/backend) Engine：调度、存储、成员程序适配器
   │  快照差量推送 + invoke 请求
界面 React (src/renderer)            App.tsx 外框，各房间/设置/弹窗分文件
共用 (src/shared)                    类型、协议、请求名单、文案、纯函数
```

- 数据：`node:sqlite`（WAL），实体表 `entities` 加事件表 `events`，入口 `src/backend/store.ts`。安装版和绿色版的资料目录默认是 `%USERPROFILE%\.airoom\data`，开发版是项目里的 `.airoom`，都可用 `AIROOM_DATA_DIR` 覆盖。
- 界面状态来自后台推送的**快照**（`Snapshot`，类型在 `src/shared/types.ts`）。快照里的运行记录是摘要 `RunSummary`（只带前 120 字），需要完整任务原文时调用 `run.inputs`。

### 7.2 界面请求（RPC）的规矩

1. 界面只能通过 `window.airoom.invoke(method, params)` 调用后台。
2. **请求名必须登记**在 `src/shared/rpc-methods.ts` 的 `RENDERER_METHODS`，主进程会拒绝未登记的名字。
3. 后台处理在 `src/backend/engine.ts`。`invokeCore` 按请求名前缀分到五组：`invokeRooms`、`invokeMembers`、`invokeWork`、`invokeAutomation`、`invokeData`，前缀与分组的对应关系见 `INVOKE_DOMAINS`。新增请求时用已有前缀，并放进对应分组的 `switch`；确实需要新前缀时，同时在 `INVOKE_DOMAINS` 里登记。
4. `tests/rpc-methods.test.ts` 会检查：界面用到的请求名都在名单上，名单上的请求都有后台处理。删除功能时，名单、处理分支和界面调用要一起删。

### 7.3 必须保持的行为

- **不自动重发**：成员程序的一次运行结果不确定时（断线、崩溃、无输出），标为“结果待核对”交给用户决定，绝不自动重发，以免重复消耗额度。
- **先副本后写回**：除成员个人文件夹外，改文件的工作都在工作副本里进行，写回用户原文件夹前必须经过用户确认或验收。相关代码在 `src/backend/workspace*.ts`、`project-flow-apply.ts`。
- **不做破坏性迁移**：资料格式变化用“读取时兼容 + 启动时迁移”。旧资料里多出来或缺少的字段不能导致启动失败。
- **密钥不外泄**：密钥由 Windows 加密保存；日志、事件、诊断导出都经过 `src/backend/security.ts` 脱敏。不要把密钥写进日志、快照或测试快照。
- **成员账号隔离**：每个成员程序使用 AIROOM 自己的登录目录。启动成员程序时会清除宿主的 `CLAUDE*`、`ANTHROPIC*`、`CODEX*` 等变量，不要绕过。
- **互评匿名**：圆桌互评和汇总阶段，发给成员的材料里不能出现候选作者的名字或成员编号，只用字母或随机编号；名字只在用户界面和公开审议里还原（`labelPeerLetters`、`roundtable-material.ts`）。
- **宽进严判**：读取成员回复时可以兼容写法差异（`src/shared/flow-format.ts`），但不能替成员补造内容：缺依据就是“待核实”，声称运行过的命令要对上真实运行记录，矛盾的字段交给用户。修改格式规则后，除对应测试外还要跑全部界面冒烟，有些冒烟用“错误格式”模拟失败场景，规则放宽后场景本身可能失效。
- **会议室只读看文件**：项目会议室的发言和 @ 回复可以只读查看项目目录（`roomProjectFiles`），但发言仍在隐藏的会议室目录里运行，不能改文件或执行会改动内容的命令。给成员程序加读文件能力时，要同时守住“只读”和“只能读这个项目”两条边界。
- **用户的话要落地**：下一轮确认时的附言、“我来判断”时的说明、带回项目的圆桌材料，都必须进入后续任务、检查或汇报的材料，不能只存在决定记录里。圆桌材料只进入第一次采用它的方案或轮次，避免反复注入。
- **补全有边界**：程序只替成员补闭合括号这类无歧义的结构，不补内容；补正结果和原回复一样时直接交给用户，不再重复调用。
- **测试隔离**：测试一律使用临时资料目录（`scripts/test-environment.mjs`），不要把测试指向 `%USERPROFILE%\.airoom\data`。`scripts/real-account/` 下的脚本会使用真实登录、消耗额度，未经用户明确同意不要运行。

### 7.4 代码风格

- TypeScript 严格模式；界面文字为简体中文，语气与现有界面一致（简短、口语、不用“您”）。
- 跟随所在文件的写法：命名、注释密度、缩进。不要顺手重排无关代码。
- 新增或修改行为时补测试：后台逻辑在 `tests/*.test.ts`（`node:test`），界面流程在 `tests/ui/*-smoke.mjs`（Playwright + 模拟成员）。需要内置成员的界面测试用 `tests/helpers/seeded-engine.ts`。
- 删除界面时连同只被它用到的组件、样式（`src/renderer/*.css`）、请求名和测试一起删，不要留下死代码。

### 7.5 交付前

1. `npm run typecheck`；
2. 运行与改动相关的测试文件；
3. 改动较大或准备分发时运行 `npm run verify`；
4. 用几句话告诉用户：改了哪些文件、为什么、测试结果原文、还有什么没验证（例如“未用真实账号测试”）。

---

## 八、常见改法速查

### 想改什么，先看哪里

| 想改的东西 | 主要位置 |
| --- | --- |
| 窗口外框、左侧栏、房间切换 | `src/renderer/App.tsx`、`room.tsx`、`styles.css` |
| 成员工位（一对一） | `src/renderer/member-desk.tsx`、`topics.tsx`；后台 `src/backend/member-workspaces.ts` |
| 茶歇室聊天、开会、举手、纪要 | 界面 `src/renderer/room.tsx`、`discussion-*.tsx`；后台 `src/backend/room-discussion.ts`；格式 `src/shared/discussion*.ts` |
| 项目会议室流程 | 界面 `src/renderer/project-room.tsx`、`project-progress.tsx`；后台 `src/backend/project-flow*.ts`；协议 `src/shared/project-flow*.ts` |
| 圆桌（比稿、评审） | 界面 `src/renderer/roundtable.tsx`、`joint-review.tsx`；后台 `src/backend/roundtable.ts`、`joint-review.ts` |
| 待你处理 | `src/renderer/attention.tsx`；`src/backend/attention.ts` |
| 自动功能、成员闲聊、定时任务 | 界面 `src/renderer/automation.tsx`、`life.tsx`；后台 `src/backend/automation-scheduler.ts`、`daily-life.ts` |
| 设置页、连接与版本 | `src/renderer/settings.tsx`、`executor-catalog.tsx`、`provider-*.tsx` |
| 人物卡、形象模板、默认设置 | `src/renderer/member-card*.tsx`、`members.tsx`；默认值 `src/shared/defaults.ts`；立绘 `src/renderer/assets/members/` |
| 可下载的成员程序清单 | `src/shared/executor-catalog.ts`；下载与版本 `src/backend/executor-catalog.ts`、`member-versions.ts` |
| 接入某个成员程序的方式 | `src/backend/adapters/`（`claude.ts`、`codex.ts`、`dsh.ts`、`acp*.ts` 等） |
| 发给成员的提示词 | 各功能后台文件中拼装，例如 `daily-life.ts`、`room-discussion.ts`、`project-flow*.ts` |
| 成员回复的格式规则与兼容 | `src/shared/flow-format.ts`、`project-flow-protocol.ts`、`joint-review-protocol.ts` |
| 格式问题出现得多不多 | 程序里导出诊断，看 `formatCorrections` 汇总；记录逻辑在 `src/backend/format-corrections.ts` |
| 备份与恢复 | `src/backend/backup*.ts`、`src/renderer/backup.tsx` |
| 权限（命令、联网、文件范围） | `src/shared/permissions.ts`、`src/renderer/permission-settings.tsx` |
| 构建、部署、打包脚本 | `scripts/`（`build.mjs`、`deploy-runtime.*`、`package-green.mjs`） |

不确定时，让 AI 用界面上的中文文字搜索，例如“搜索‘整理会议纪要’出现在哪些文件”，从界面顺藤摸瓜找到后台。

### 删除一个功能

1. 在界面里找到入口（按钮、菜单、设置项），记下它调用的请求名。
2. 删除界面组件和只被它用到的样式。
3. 从 `rpc-methods.ts` 删除请求名，从 `engine.ts` 对应分组删除处理分支，再删除只被它用到的后台模块。
4. 设置项要保留**读取兼容**：旧资料里还有这个字段时，程序要能正常启动（忽略即可）。
5. 删除或调整对应的测试；运行 `npm run typecheck` 和 `tests/rpc-methods.test.ts`，再跑相关测试。

### 新增一个界面请求

1. 在 `src/shared/rpc-methods.ts` 登记请求名，例如 `desk.search`。
2. 在 `engine.ts` 中前缀所属的分组（`desk.` 属于 `invokeRooms`）加一个 `case`。
3. 界面里用 `invoke('desk.search', {...})` 调用。
4. 补后台测试，必要时补界面冒烟；运行 `tests/rpc-methods.test.ts`。

### 接入新的成员程序

- **支持 ACP（Agent Client Protocol）的程序**：大多不用改代码，在程序的“设置与连接”里手动添加执行端，填写启动命令即可。
- **想让它出现在可下载清单里**：在 `src/shared/executor-catalog.ts` 增加条目（下载地址、校验值、启动方式），并在 `tests/executor-catalog.test.ts` 补测试。
- **使用专有协议的程序**：在 `src/backend/adapters/` 参照现有适配器新增一个，并在 `engine.ts` 的 `adapter()` 里登记。这类改动较大，先让 AI 出方案。

### 成员总是回错格式

1. 先在程序里导出诊断，看 `formatCorrections`：哪个阶段、哪个执行端、哪类错误最多。
2. 只是写法不同（大小写、单项写成一项、多了空字段）：在 `flow-format.ts` 里加兼容，并在 `tests/` 加一条用真实回复改写的回归测试。
3. 成员确实漏了必需内容：改提示词说清楚，不要在程序里替它补。
4. 跑 `npm run verify`，确认没有冒烟测试因规则变化而失效。

### 改界面文字或样式

- 文字直接写在对应的 `.tsx` 文件里，用界面上看到的原文搜索即可找到。
- 样式在 `src/renderer/styles.css` 和各功能的 `.css` 文件里，颜色、字号尽量沿用已有的变量和类名。
- 改完用 `npm run dev` 看效果；涉及布局的改动，相关界面冒烟可能需要同步调整。

---

## 九、后续优化建议和方向

> 这一节来自 2026-10-14 至 10-15 的真实账号测试和多轮复核，写给接手的维护者和 AI。按优先级排列，每条写清为什么要做、从哪里入手。

### 优先做（影响流程能不能顺利走完）

1. **给成员一个受控的“实际试用”能力**。现在成员没有浏览器，网页类成果的“双击能用、刷新后还在、手机上显示正常”只能转给用户实测。可以在整合检查阶段提供一个只读的无头浏览器检查（打开副本里的页面、执行脚本、截图），结果作为程序记录的依据。入手：`project-flow.ts` 的整合检查材料，参考测试里的 `try-product` 做法。这能同时减少“无法下结论”的决策卡。
2. **圆桌结论结构化**。现在带回项目的是一整段文字。建议让结论带一份“要求清单”（每条可核对），下一轮确认时让用户勾选采用哪几条，直接写成任务的完成标准。入手：`roundtable.ts` 的结论、`project-flow.ts` 的 `startConfirmedRound`。
3. **额度感知的调度**。开工前根据各成员的额度快照提示“可能中途用完”的成员，允许换人；额度恢复后可选择自动接着做（目前只提示）。入手：`QuotaWait`、`reconcileQuotaWaits`、`quota*.ts`。
4. **整合修正按文件依赖分组**。现在跨文件的问题会整组交给负责人。更好的做法是按“问题涉及的文件集合”求连通分量，每组交给一个人，组间不重叠时可以并行。入手：`project-flow.ts` 中生成整合修正任务的部分。

### 接着做（减少格式问题和误拦）

5. **用执行端原生的结构化输出**。Codex `app-server` 的 `turn/start` 支持 `outputSchema`，Claude Code 支持 `--json-schema`（启动参数，复用进程时要按阶段区分）。接入后能从源头减少补正。先看补正统计（`formatCorrections`）里哪个执行端、哪个阶段最多。
6. **让 GLM（ZCode）的命令可核对**。ZCode 适配器目前只拿到最终回复，没有工具和命令事件，所以 GLM 的命令依据一律“未核实”。如果 ZCode 的输出流里有工具事件，接进 `zcode.ts`；没有的话，在提示里引导 GLM 用 inspection 描述检查过程。
7. **会议室读文件扩展到 ACP 成员**。Kimi、Cursor、Qoder 还没有接入“只读查看项目目录”。需要先用真实账号确认各自的工具开关和目录参数，再改 `acp-chat.ts`，不要凭猜测加参数。
8. **收紧“转给用户实操”的判断**。现在用文字规则判断哪些标准需要用户实测，成员只写一句“未在浏览器验证”也会被转走。积累一段时间的真实数据后，可以改成计划阶段就把实操项标成 owner，检查阶段只认这些。

### 可以排期（体验和维护）

9. **交付前的通用检查清单**。真实测试里成品网页漏了 `<meta name="viewport">`，几轮检查都没发现。可以给网页类任务附一份程序生成的检查清单（视口、空状态、错误提示、数据保护），作为整合检查材料。
10. **结项汇报可导出**。`flow.completionReport` 已经有各轮成果、修正和遗留，可以加“导出整段汇报”，与“导出本轮汇报”并列。
11. **真实账号测试脚本化**。现在每次真实测试都要手工准备隔离目录、复制凭据、测完清理。可以把“准备 → 驱动 → 核对 → 清理（移到回收站）→ 核对原账号未变”做成脚本，放在 `scripts/real-account/`，默认不运行。
12. **界面冒烟去掉固定等待**。时序敏感的冒烟（例如 GLM 中止）应等待真实事件（调用记录、运行状态）出现，而不是固定的超时，避免在机器忙时偶发失败。

### 处理这些建议时

- 每条都先写测试，复现当前的问题，再修。
- 涉及成员程序行为的改动，自动测试通过后还要用真实账号试一次，并在交接或记录里写明“哪些用真实账号验证过、哪些没有”。

---

更多技术细节见 [技术说明](技术说明.md)；使用方法见 [README](../README.md)。
