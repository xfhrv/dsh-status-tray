# DSH 状态托盘 — 实现契约（v1）

> 本文档描述 v1 版本的设计与实现契约，是后续版本的基础；v2–v6 以增量方式叠加（见下方增量说明），当前最新行为以 v6 为准。文档索引见 [README.md](README.md)。
>
> **v2 增量**：status.json 的 `version` 已升为 2，新增 `alerts.completion` / `alerts.attention` 通知事件、config 的通知/提示音键，以及 `--test-notify` 调试参数 —— 详见 [alerts-spec.md](alerts-spec.md)。本文件其余内容（数据源、颜色、菜单、进程模型）继续有效。
>
> **v3 增量**：status.json 的 `version` 已升为 3，新增 `account` 账户充值余额字段与右键菜单"充值余额"项、config 的 `showBalance` / `topUpUrl`、`--open-balance` 调试参数 —— 详见 [account-balance-spec.md](account-balance-spec.md)。
>
> **v4 增量**：status.json 的 `version` 已升为 4，新增 `workingSessions`（全部工作中的主会话）；working 状态且主会话 ≥2 时 `tooltip` 改为逐行显示全部会话标题（≤60 字符预算，超出省略）—— 详见 [working-sessions-spec.md](working-sessions-spec.md)。
>
> **v5 增量**：`version` 升为 5，状态模型精简为 4 态（`approval`/`working`/`idle`/`offline`），绿色=空闲/DSH 正常运行、灰色=DSH 未运行；取消 `restricted` 状态与 `darkgray` 颜色；右键菜单去掉状态行/权限行 —— 详见 [state-model-v5.md](state-model-v5.md)。
>
> **v6 增量**：右键菜单扩展为「打开控制台 / 打开网页版 DeepSeek / 查看 DS 服务器状态 / 充值余额 / 设置全局快捷键… / 退出」，新增全局快捷键、鼠标左键单击打开控制台、config 的 `webChatUrl` / `statusUrl` / `hotkey` 以及 `--open-web` / `--open-status` / `--open-hotkey-settings` / `--hotkey` 调试参数；`status.json` 结构与 `version` 不变（仍为 5）—— 详见 [menu-hotkey-v6.md](menu-hotkey-v6.md)。

> 本文件定义状态引擎（Node）与托盘 UI（C#）之间的**接口契约**。任何实现不得单方面改动本契约；需要变更时请先更新本文档，并同步修改两端实现。
> 下文中的相对路径均相对于本仓库根目录。

## 1. 目标

Windows 任务栏托盘常驻小工具，实时反映**本机 DSH**（DeepSeek Harness）的状态：

| 状态 | 灯泡颜色 | 触发条件（优先级从高到低） |
|---|---|---|
| `approval` 需要用户审批/回答 | 🔴 红 | 最近活跃会话里存在**未决审批请求**（`approval/asked` 无对应 `approval/decided`），或 `userQuestions.questions.active` 非空 |
| `working` 工作中 | 🟡 黄 | 最近会话存在**未结束的轮次/步骤**（projcache `turnBoundary.openTurnStartSeq` 非 null 或 `sessionStats.openStep` 非 null），且该会话近 120 分钟内有投影更新 |
| `restricted` 限制状态 | 🟢 绿 | 无红/黄，当前会话**权限受限**（sandbox ≠ `danger-full-access`，即"仅可查看 / 工作区内修改"） |
| `idle` 空闲（完全权限） | ⚪ 灰 | 无红/黄，当前会话权限为 `danger-full-access`（完全权限）或权限信息缺失 |
| `offline` DSH 未运行 | ⚫ 深灰 | 127.0.0.1:3080 TCP 不可连接，或完全没有任何会话数据 |

右键菜单（必须包含）：
1. （禁用状态行）当前状态 + 会话标题
2. （禁用状态行，可空）权限/进度详情
3. `---` 分隔线
4. **打开控制台** — 用系统默认浏览器打开 `http://127.0.0.1:3080`
5. `---` 分隔线
6. **退出**

双击托盘图标 = 打开控制台。

## 2. 交付目录结构

```
仓库根目录/
  README.md                  # 用户使用说明
  build.ps1                  # 一键编译（csc.exe -> bin/DSHStatusTray.exe）
  install-autostart.ps1      # 开机自启安装/卸载（当前用户）
  dev/                       # 开发辅助脚本（结构排查、性能基准、日志扫描）
  src/TrayApp.cs             # C# 5 托盘 UI（单一入口）
  src/app.manifest           # DPI aware manifest（可选）
  src/status-agent.mjs       # Node 状态引擎（可独立运行）
  src/status-core.mjs        # 纯函数：computeStatus() 等（可单测）
  test/status.test.mjs       # Node 单测（node --test）
  bin/DSHStatusTray.exe      # 构建产物（build.ps1 生成，不手写）
  docs/README.md             # 文档索引（v1–v6）
  docs/status-schema.md      # 本文件
```

**约束**：只用系统自带能力，零第三方依赖，不联网下载。
- C# 用 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（**只支持 C# 5**：禁止 `$""` 插值、`?.`、`=>` 表达式体、`nameof`、自动属性初始化等 C# 6+ 语法），引用 `System.dll / System.Core.dll / System.Windows.Forms.dll / System.Drawing.dll`，`/target:winexe /codepage:65001`。
- Node 用本机 Node（当前 v24.20.0，须兼容 ≥ v22）。zstd 解压用 `node:zlib` 的 `zstdDecompressSync`（做特性检测，缺失时优雅降级：仍按 projcache 出状态，只是没有审批检测，并在 `agentError` 里注明）。

## 3. 运行时文件（不放在仓库目录）

目录：`%LOCALAPPDATA%\DSHStatusTray\`（C# 用 `Environment.GetFolderPath(LocalApplicationData)`）

| 文件 | 生产者 | 说明 |
|---|---|---|
| `status.json` | Node 状态引擎 | 状态快照，C# 每 500ms 读一次。见 §4 |
| `config.json` | C#（缺失时写默认） | 见 §6 |
| `agent.log` | C#（把 Node 子进程 stdout/stderr 重定向写入） | 追加，超过 1MB 轮转覆盖 |
| `tray.log` | C# | 托盘自身异常日志（追加） |

## 4. status.json 契约

Node 状态引擎原子写入（临时文件 + rename，读取方可能读到短暂缺失/半文件，C# 必须容错并保留上一次状态）。UTF-8、无 BOM、单行 JSON 或带缩进均可。

```json
{
  "version": 1,
  "generatedAt": 1793546533399,
  "state": "working",
  "stateLabel": "工作中",
  "color": "yellow",
  "tooltip": "工作中 · 示例项目 A",
  "menuStatus": "状态：工作中 — 示例项目 A",
  "menuDetail": "权限：完全权限 · 第 1 轮第 30 步",
  "activeSession": {
    "id": "session-01234567-89ab-4def-8123-456789abcdef",
    "title": "示例项目 A",
    "workspace": "C:\\projects\\example-project-a",
    "permission": "完全权限",
    "sandbox": "danger-full-access",
    "approval": "never",
    "preset": "danger-full-access",
    "turn": 1,
    "step": 30,
    "workingSince": 1793546533399,
    "pendingApprovalTool": null,
    "pendingApprovals": 0,
    "pendingQuestions": 0,
    "lastActivityAt": 1793546533399
  },
  "host": { "port": 3080, "running": true },
  "agent": { "pid": 12345, "node": "v24.20.0", "intervalMs": 500, "dshHome": "%USERPROFILE%\\.dsh" },
  "agentError": null
}
```

字段规则：
- `state` ∈ `approval | working | restricted | idle | offline`；`stateLabel` 对应 `需要审批 | 工作中 | 限制状态 | 空闲 | 未运行`。
- `color` ∈ `red | yellow | green | gray | darkgray`（与 state 固定映射：approval→red, working→yellow, restricted→green, idle→gray, offline→darkgray）。
- `tooltip`：**单行、去换行、≤ 60 字符**（NotifyIcon.Text 上限 63）。
- `menuStatus` / `menuDetail`：可较长；`menuDetail` 允许为空字符串。
- `activeSession`：无会话时整体为 `null`。
- `pendingApprovalTool`：未决审批对应的工具名，如 `pwsh`；无则 null。
- `agentError`：字符串或 null；降级时说明原因（例如 `"zstd 不可用，无法检测审批"`）。C# 在 `menuDetail` 为空时可用它兜底提示。
- 状态引擎**每 500ms（可配）写一次**；即使状态没变也要刷新 `generatedAt`（心跳）。

## 5. 数据源（Node 状态引擎实现要点）

### 5.1 DSH_HOME
`process.env.DSH_HOME` 若设置则用之，否则 `%USERPROFILE%\.dsh`。所有读取失败都要容错（文件可能正在写、可能被删除）。

### 5.2 会话投影缓存（工作状态 / 权限 / 待回答问题）
目录：`<DSH_HOME>\storages\session_projcache\sessions\*.json`
文件 mtime = 该会话最近一次投影更新时间；内容结构：

```json
{ "version": 7, "record": { "identity": { "cwd": "..." },
  "rows": { "<rowKey>": { "ver": 1, "seq": 316, "val": <value> }, ... } } }
```

需要读取的 rowKey → val：
- `title` → string
- `workingDirectory` → string（可选，缺失用 identity.cwd）
- `permissions` → `{ preset, sandbox, approval, seeded }`（sandbox ∈ `read-only|workspace-write|danger-full-access`；approval ∈ `ask|never`）
- `sessionStats` → `{ openStep: {turn, step, startTime, firstTokenTime} | null, lastTurn }`
- `turnBoundary` → `{ openTurnStartSeq: number|null, lastStepStartSeq, lastStepBoundary: {kind, seq}, lastTurn }`
- `userQuestions` → `{ questions: { active: [...], settled: [...] } }`

判定：
- 工作中 = `turnBoundary.openTurnStartSeq != null || sessionStats.openStep != null`，且 projcache mtime 在最近 **120 分钟**内（防止崩溃残留永远黄灯）。
- 权限受限 = `sandbox !== "danger-full-access"`。
- 权限中文名映射：`danger-full-access`→完全权限，`workspace-write`→工作区内修改，`read-only`→仅可查看，其他/缺失→未知。
- 近期活跃窗口：projcache/log mtime 在最近 **10 分钟**内，才参与红/黄候选。
- 聚焦会话选择：红态优先（有未决审批的会话），其次黄态（工作中的会话），否则取 projcache mtime 最新的会话；同优先级取 mtime 最新。

### 5.3 会话日志（未决审批检测）
日志路径：`<DSH_HOME>\sessions\<工作区目录>\<会话目录>\session.v4.jsonl.zstd`（格式版本或文件名可能演进；用**递归扫描 + 文件名含 uuid** 的方式建立 `uuid → 日志文件` 索引，缓存 5 秒）。
- projcache 文件名形如 `session-<uuid>.json` 或 `<uuid>.json`，用其中 `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` 段匹配日志索引。
- 日志是**多个 zstd frame 顺序拼接**的 append-only 文件。每个 frame 以魔术字节 `28 B5 2F FD` 开头。用 `Buffer.indexOf` 切 frame，逐 frame `zlib.zstdDecompressSync(frame)`，按行 `JSON.parse`。
- 增量策略（性能关键）：
  - 每个日志文件维护 tracker：`{ offset, pendingApprovals: Map<id,{toolName, seq}>, lastError }`。
  - 首次见到文件：只读尾部最多 **512 KiB**，从第一个完整 frame（首个 magic）开始解；后续每次只读 `offset` 之后新增字节，只处理完整 frame（末尾不完整 frame 留在缓冲区下轮再试）。
  - 事件：
    - `{"type":"approval/asked","data":{"id","toolName","callId","reason"}}` → `pendingApprovals.set(id, ...)`
    - `{"type":"approval/decided","data":{"id","outcome"}}` → `pendingApprovals.delete(id)`
    - `{"type":"turn/end"}` → 清空该会话 `pendingApprovals`（兜底，防止历史残留）
  - 未决审批 = `pendingApprovals.size > 0`。
- 只跟踪 projcache 近期（30 分钟内 mtime 或日志 mtime 近期）的会话，最多 8 个，避免开销。不跟踪的会话不参与审批检测。
- 若 `zstdDecompressSync` 不存在 → 跳过审批检测，`agentError="当前 Node 不支持 zstd，无法检测审批请求"`。

### 5.4 主机存活
每 5 秒做一次 `net.connect({host:'127.0.0.1', port: 3080, timeout: 300})` TCP 探活（`consoleUrl` 的端口）。失败则 `host.running=false`。若同时无任何会话数据 → `offline`。

## 6. config.json

```json
{
  "consoleUrl": "http://127.0.0.1:3080",
  "pollMs": 500,
  "colors": {
    "working": "#F2B705",
    "approval": "#E5484D",
    "restricted": "#2FA84F",
    "idle": "#9AA0A6",
    "offline": "#6B7280"
  }
}
```
- C# 启动时若缺失则写默认；解析失败用内置默认值。
- `colors` 的键为 state，值为 `#RRGGBB`（C# 解析）。

## 7. 进程模型

1. `DSHStatusTray.exe` 启动：
   - 单实例：命名 Mutex（`Local\DSHStatusTray`），已存在则静默退出。
   - 定位 `node.exe`：先 PATH（逐段找 `node.exe`），再常见路径 `%ProgramFiles%\nodejs\node.exe`、`%LOCALAPPDATA%\Programs\nodejs\node.exe`、`%ProgramFiles(x86)%\nodejs\node.exe`。
   - 创建 `%LOCALAPPDATA%\DSHStatusTray\`，启动子进程（隐藏窗口、无控制台）：
     `node.exe "<仓库根目录>\src\status-agent.mjs" --out "<LOCALAPPDATA>\DSHStatusTray\status.json" --interval 500 --log "<LOCALAPPDATA>\DSHStatusTray\agent.log"`
     子进程 stdout/stderr 重定向 Async 追加到 `agent.log`（带时间戳可省略）。
   - 启动 500ms WinForms Timer：读 status.json → 更新图标/文字/菜单；status.json 缺失或 `generatedAt` 超过 **10 秒** → 灰灯 + tooltip `状态监视器未响应`，并尝试重启子进程（≥10 秒重试间隔）。
   - 退出/异常终止：Timer 停止、Kill 子进程（`Process.Kill()` 即可，node 无孙进程）、`NotifyIcon.Dispose()`、释放 HICON。
2. 图标：程序内用 `System.Drawing` 画 32×32 圆点（抗锯齿、半径 13、填充色 + 深色描边，可加 1px 高光），`Icon.FromHandle(bmp.GetHicon())`；替换图标时旧 HICON 用 P/Invoke `DestroyIcon` 释放。只有 state/color 变化才重建图标。
3. `tooltip` 超过 60 字符时截断；不允许换行（`\r\n` 替换为空格）。
4. 菜单每次弹出前刷新状态行文字（`Opening` 事件或 timer 更新即可）。
5. C# 侧所有异常必须 `try/catch` 记录到 `tray.log`，不得让顶栏进程崩溃；全局 `Application.ThreadException` + `AppDomain.UnhandledException` 兜底。

### 7.1 EXE 调试/验收参数（不影响正常使用）

```
DSHStatusTray.exe [--status <path>] [--no-agent] [--render-icons <dir>] [--open-console]
```
- `--status <path>`：覆盖读取的 status.json 路径（配合 `--no-agent` 做 UI 验收）。
- `--no-agent`：不启动/守护 Node 子进程（仅读 status.json）。
- `--render-icons <dir>`：把状态图标分别导出为 PNG（32×32）后退出，用于核验图标绘制。v1 时导出 5 种：`working.png/approval.png/restricted.png/idle.png/offline.png`；v5 起为 4 种：`working.png/approval.png/idle.png/offline.png`（见 [state-model-v5.md](state-model-v5.md)）。
- `--open-console`：执行"打开控制台"同一段代码后立即退出（用于验收），退出码 0 表示未抛异常。
- 状态引擎脚本定位顺序：环境变量 `DSH_TRAY_AGENT` → `<exe目录>\..\src\status-agent.mjs` → `<exe目录>\status-agent.mjs`。

## 8. Node 状态引擎 CLI

```
node src/status-agent.mjs [--out <status.json>] [--interval 500] [--log <agent.log>]
                          [--dsh-home <path>] [--console-url http://127.0.0.1:3080]
                          [--once] [--now <epochMs>]
```
- `--once`：计算一次，把完整 status JSON 打印到 stdout 后退出（用于测试/排查）。
- 常驻模式：循环写 `--out`（默认 `%LOCALAPPDATA%\DSHStatusTray\status.json`），SIGTERM/SIGINT 干净退出。
- 错误：单次轮询异常不得退出进程；写入 `--log`。

## 9. 验收标准

1. `build.ps1` 在干净环境一次编译出 `bin/DSHStatusTray.exe`，退出码 0。
2. `node src/status-agent.mjs --once` 在本机输出合法 status.json：当前会话正在工作时应为 `state=working / color=yellow`（允许因采样时刻不同而在 working/restricted/idle 间变化，但不能报错）。
3. `node --test test/status.test.mjs` 全绿；测试须覆盖：working、approval 未决（合成 zstd 日志）、restricted、idle、offline、心跳时间戳、tooltip≤60 字符。
4. 运行 `DSHStatusTray.exe`：进程存活、`status.json` 心跳持续更新、`agent.log` 无未捕获异常、任务栏托盘出现彩色圆点。
5. 托盘右键菜单包含`打开控制台`与`退出`；`打开控制台`用系统默认浏览器打开 `http://127.0.0.1:3080`；`退出`后进程与 Node 子进程都消失。
6. 不修改 DSH 本体、不重启 DSH、不依赖管理员权限、不下载任何第三方包。
7. 中文界面在中文 Windows 上无乱码（C# 源码 UTF-8 + `/codepage:65001`）。

## 10. 边界与已知取舍

- 状态来自 DSH 本地落盘数据（投影缓存 + 会话日志），非官方 API；DSH 不运行或数据缺失时显示灰色。
- 多会话并存时按 §5.2 选择聚焦会话；审批/工作状态取"最近活跃会话"聚合优先级。
- "限制状态"= 权限受限（仅可查看 / 工作区内修改）；"完全权限"空闲时显示灰色。
- 托盘图标默认可能被 Windows 收进"隐藏的图标"溢出区，用户可拖到任务栏常驻。
