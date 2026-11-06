# DSH 状态托盘 — 多会话工作提示增强契约（v4）

> 本文档描述 v4 版本的多会话悬停提示契约，叠加在 [status-schema.md](status-schema.md)（v1）、[alerts-spec.md](alerts-spec.md)（v2）、[account-balance-spec.md](account-balance-spec.md)（v3）之上；冲突处以本文件为准。v5–v6 以增量方式继续叠加，当前最新行为以 v6 为准（v6 见 [menu-hotkey-v6.md](menu-hotkey-v6.md)）；文档索引见 [README.md](README.md)。
> 背景：鼠标悬停托盘图标时只显示**一个**工作中的会话，需要显示**所有正在工作中的会话**，每个会话一行。示例：
> ```
> 示例项目 A
> 示例项目 B
> ```
> Windows/.NET 约束（已实测）：`NotifyIcon.Text` **最多 63 个字符**（64 抛出 ArgumentOutOfRangeException），但**允许换行符 `\n`**，Windows 11 托盘提示支持多行显示。因此总预算按 ≤60 字符设计（含换行符）。

## 1. 组件职责

- **状态引擎（Node）**：在 status.json 增加 `workingSessions`（所有正在工作的**主会话**列表，按开始时间升序）；并把 `state=="working"` 时的 `tooltip` 改成多行（每个会话标题一行），负责在 60 字符预算内排布/截断。`version` 升为 **4**。
- **托盘 UI（C#）**：工具提示规范化时**保留换行**（不再把 `\n` 压成空格），逐行清理/合并，总长 ≤60；其余行为不变。
- **集成与发布**：两端联调、真实环境与夹具的端到端验证、README 更新在发布前完成。

## 2. status.json v4 增量

```json
{
  "version": 4,
  "workingSessions": [
    { "id": "session-01234567-89ab-4def-8123-456789abcdef", "title": "示例项目 A", "main": true, "workingSince": 1793549900000, "turn": 5, "step": 3 },
    { "id": "session-89abcdef-0123-4567-89ab-cdef01234567", "title": "示例项目 B", "main": true, "workingSince": 1793549981354, "turn": 4, "step": 2 }
  ],
  "tooltip": "示例项目 A\n示例项目 B"
}
```

规则：
- `workingSessions` **始终存在**（数组，可为空）。元素字段：`id`、`title`、`main`（恒 true，只收主会话）、`workingSince`（该会话本轮/当前步骤开始时间，epoch ms，可为 null）、`turn`/`step`（可 null）。
- 只收**主会话**（id 以 `session-` 开头；裸 uuid 的委派子会话**不**加入），避免工具提示被子会话噪声占满。
- 排序：`workingSince` 升序（先开始的在前），null 排最后；同一时间按 `id` 稳定排序。
- `tooltip` 生成规则（引擎）：
  1. 非 working 状态：保持 v3 行为（`需要审批 · …` / `空闲 · …` / `限制状态 · …` 等单行）。
  2. working 且 `workingSessions.length >= 2`：`tooltip` = 每行一个 `title`（去掉标题内换行、折叠空白、去首尾空格），按上述顺序；总长（含 `\n`）≤ `MAX_TOOLTIP_CHARS`（=60）。
  3. working 且 `workingSessions.length == 1`：保持旧格式 `工作中 · <title>`。
  4. working 但 `workingSessions` 为空（只有子会话在工作）：保持旧格式 `工作中 · <focus title>`。
- 多会话放不下时的截断策略（保证 ≤60、尽量保留信息）：
  1. 先尝试全部标题逐行放（原样）。
  2. 否则从末尾去掉若干会话，尝试 `前 k 行 + "\n…等M个会话"`（M=被省略数，k 从 n-1 递减到 1）。
  3. 仍放不下（极端长标题）：最多保留前两行，逐行截断并加 `…`，剩余用 `…` 表示；最终必 ≤60。
  4. 任何情况下不得输出超过 60 字符的 tooltip，也不得包含 `\r`。
- 引擎其余字段（activeSession 仍为聚焦会话、menuStatus/menuDetail、alerts、account）语义不变。

## 3. C# 工具提示规范化（TrayApp.cs）

`NormalizeTooltip` 改为：
1. 统一 `\r\n`/`\r` → `\n`；按 `\n` 分行。
2. 每行：去首尾空白、把连续空格/制表折叠成单空格；丢弃空行。
3. 逐行拼接（行间 `\n`）；总字符数 ≤60：超出时从最后一行开始截断（加 `…`）直到满足；仍超则丢弃后面整行并追加 `…`。
4. 单行工具提示的行为与现在一致（换行符只是保留，不再压缩成空格）。
5. 设置 `_notifyIcon.Text` 保持 try/catch（NotyIcon 63 字符硬限制，规范化后 ≤60 不会触发）。
6. 其它状态（loading/未响应/offline）仍用单行。

## 4. 验收标准

1. `node --test` 全绿；新增 ≥5 用例：两个主会话 working → tooltip 两行且顺序按 workingSince 升序、workingSessions 正确；子会话工作不进入列表；超长多会话 → tooltip ≤60 且含 `…等N个会话`；单会话保持 `工作中 · X`；非 working 状态 tooltip 不受影响。
2. C#：build.ps1 通过；工具提示规范化用例（多行保留、逐行清理、总长 ≤60、单行不变、NotyIcon 63 硬限不触发异常）。
3. 端到端验证：用夹具 status.json（workingSessions 两个主会话 + 多行 tooltip）启动 `--no-agent --status` 托盘，悬停图标截图应显示**两行**会话标题；真实环境重启后，若当前只有 1 个工作会话则保持旧单行格式，不回归。
4. 既有功能（颜色/菜单/通知/余额）全部正常，无 ERROR 日志。
