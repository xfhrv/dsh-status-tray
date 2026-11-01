# DSH 状态托盘 — 状态模型简化 + 菜单精简契约（v5）

> 本文档描述 v5 版本的状态模型简化与菜单精简契约（当前最新版本），叠加在 [status-schema.md](status-schema.md)（v1）、[alerts-spec.md](alerts-spec.md)（v2）、[account-balance-spec.md](account-balance-spec.md)（v3）、[working-sessions-spec.md](working-sessions-spec.md)（v4）之上；冲突处以本文件为准。文档索引见 [README.md](README.md)。
> 设计目标：
> 1. **取消"⚫ 深灰"状态**；**"🟢 绿"代表"空闲 / DSH 正常运行"**（不再区分"限制状态"与"完全权限"）；**"⚪ 灰"改为代表"DSH 未运行"**。
> 2. **右键菜单不再显示"状态"行和"权限"行**（只保留操作项）。

## 1. 新状态模型（共 4 态）

| state | 中文 label | 颜色名 | 颜色值（默认） | 触发条件 |
|---|---|---|---|---|
| `approval` | 需要审批 | `red` | `#E5484D` | 有未决审批/待回答的问题（优先级最高） |
| `working` | 工作中 | `yellow` | `#F2B705` | 有主会话在跑（与 v4 相同） |
| `idle` | 空闲 | `green` | `#2FA84F` | DSH 主机正常运行，且无 approval/working（**不再区分权限模式**） |
| `offline` | 未运行 | `gray` | `#9AA0A6` | DSH 主机 127.0.0.1:3080 不可连接（**不再有 darkgray**） |

规则：
- **删除** `restricted` 状态与 `darkgray` 颜色；不再依据 sandbox/approval 权限推导状态。`activeSession.permission` 字段保留（仅信息），但**不再影响颜色/状态**。
- `offline` 判定：`hostRunning === false` → 必然 `offline`（即使有历史会话数据，也显示未运行）。`hostRunning === true` 且无任何会话数据 → **`idle`（绿）**，因为 DSH 主机正常运行。
- `working`/`approval` 的判定、优先级、聚合逻辑与 v4 完全相同（含多行 tooltip、长挂红灯等）。
- tooltip：
  - approval：沿用 v4（`需要审批 · …`）
  - working：沿用 v4（单会话 `工作中 · X`；多主会话逐行，≤60）
  - idle：`空闲 · <focus 标题>`（无标题时 `空闲`）
  - offline：`DSH 未运行`
- status.json `version` 升为 **5**；`stateLabel`/`color` 输出上表；`activeSession`、`alerts`、`account`、`workingSessions` 字段结构不变。
- `menuStatus` / `menuDetail` 字段保留（C# 不再展示，仅调试用），内容可继续使用现文案。

## 2. C# 托盘（TrayApp.cs）

1. **颜色/状态映射更新**：
   - `ColorFromState`：approval→red，working→yellow，idle→**green**，offline→**gray**；移除 restricted/darkgray。
   - `StateFromColor`：red→approval，yellow→working，green→**idle**，gray→**offline**；为兼容旧夹具可额外接受 darkgray→offline、restricted→idle（仅容错，不作为新输出）。
   - `LabelFromState`：approval 需要审批、working 工作中、idle **空闲**、offline **未运行**；旧 token 容错映射即可。
2. **"状态监视器未响应"兜底**：图标颜色改用 **offline 灰**（`config.colors.offline`），tooltip 保持"状态监视器未响应"。
3. **菜单精简**：右键菜单只保留操作项，删除状态行、权限行及其分隔线：
   ```
   打开控制台
   充值余额：¥xx.xx
   -----------
   退出
   ```
   - 删除 `_statusItem` / `_detailItem` 及相关刷新代码（其余逻辑不得引用，避免 NRE）。
   - `Opening` 事件仍用于刷新余额项文字。
   - 双击托盘图标 = 打开控制台（不变）。
4. **config.json colors 迁移**（重要，避免旧配置把新语义弄反）：
   - 新默认 `colors` = `{ "working": "#F2B705", "approval": "#E5484D", "idle": "#2FA84F", "offline": "#9AA0A6" }`（删除 restricted/darkgray）。
   - 读取旧 v1–v4 配置（存在 `colors.restricted` 或 `colors.darkgray`）时自动迁移并写回：
     - 新 `idle` = 旧 `restricted`（缺省 `#2FA84F`）
     - 新 `offline` = 旧 `idle`（缺省 `#9AA0A6`）
     - 旧 `darkgray` 丢弃
   - 其它键（consoleUrl/pollMs/notify*/playSound/soundFile/showBalance/topUpUrl）原样保留。
5. 其余功能（气泡通知/提示音/余额/单实例/调试参数/多行 tooltip）不得回退。

## 3. 验收标准

1. `node --test` 全绿；状态相关用例改为新模型：host 未运行（即使有数据）→ offline/gray；host 运行但无会话数据 → idle/green；权限受限但空闲 → idle/green（不再 restricted）；working/approval 不变；version=5。
2. C#：build.ps1 通过；颜色映射/旧 config 迁移/菜单不含状态权限行 的 harness 用例通过。
3. 端到端验证：夹具喂 idle → 托盘图标**绿色**、tooltip `空闲 · …`；喂 offline → 图标**灰色**、tooltip `DSH 未运行`；右键菜单截图只有「打开控制台 / 充值余额 / 退出」。
4. 真实环境：当前工作中显示黄、空闲时显示绿；无 ERROR。
