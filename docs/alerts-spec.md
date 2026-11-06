# DSH 状态托盘 — 通知与提示音增强契约（v2）

> 本文档描述 v2 版本的通知与提示音契约，是 [status-schema.md](status-schema.md) v1 契约的**增量补充**，两者一起生效；冲突处以本文件为准。v3–v6 以增量方式继续叠加，当前最新行为以 v6 为准（v6 见 [menu-hotkey-v6.md](menu-hotkey-v6.md)）；文档索引见 [README.md](README.md)。
> 使用场景：① 任务完成 → 托盘小气泡"任务完成"；② 需要用户审批 → 托盘小气泡提示审批；③ 以上两种都播放提示音（默认使用系统提示音；也可在 `config.json` 中用 `soundFile` 指定自定义 wav）。

## 1. 组件职责

- **状态引擎（Node，status-agent.mjs / status-core.mjs）**：从已有数据源（会话日志 tracker + 投影缓存）里算出两个"通知事件"字段 `alerts.completion` / `alerts.attention`，写入 status.json。不播放声音、不弹气泡，不做去重。
- **托盘 UI（C#，TrayApp.cs）**：读取 `alerts`，自己做**去重**（按 key）、在合适时机 `NotifyIcon.ShowBalloonTip(...)` 弹小气泡并用 `System.Media.SoundPlayer` 播放 `soundFile`。只在运行期；不依赖引擎重启。
- **集成与发布**：两端联调、端到端验证与 README 更新在发布前完成。

## 2. status.json v2 契约增量

`version` 从 `1` 升为 `2`。原有字段全部保留、语义不变；新增：

```json
{
  "version": 2,
  "alerts": {
    "completion": {
      "key": "session-01234567-89ab-4def-8123-456789abcdef#352",
      "at": 1793548000123,
      "sessionId": "session-01234567-89ab-4def-8123-456789abcdef",
      "title": "示例项目 A",
      "main": true
    },
    "attention": {
      "key": "approval:a1b2c3d4-e5f6-4789-8abc-def012345678",
      "kind": "approval",
      "at": 1793548000123,
      "toolName": "pwsh",
      "sessionId": "session-01234567-89ab-4def-8123-456789abcdef",
      "title": "示例项目 A",
      "main": true,
      "pendingCount": 1
    }
  }
}
```

规则：
- `alerts` 字段**必须始终存在**；其中 `completion` / `attention` 各自可为 `null`。
- 引擎只在 **hostRunning=true** 时输出非 null 值；offline/无数据时两者均为 null。
- **`alerts.completion`**（任务完成）：
  - 只统计**主会话**（会话 id 以 `session-` 开头；裸 uuid 的委派子会话不算）的 `turn/end` 事件。子会话 turn 结束**绝不**产生完成通知。
  - 事件时间 `at` ≥ **引擎进程启动时间**（`startedAt`，进程启动时 `Date.now()`）才输出，避免托盘/引擎重启后重播旧完成。取所有候选中 `at` 最大者（同 at 取 seq 大者）。
  - `key` = `<sessionId>#<seq>`（事件无 seq 时用 `<sessionId>#t<time>`），必须稳定且每次完成不同。
  - `title` 取该会话标题（projcache title；sticky 会话用 log meta），无则空字符串。
  - `main` 恒为 true。
  - 一次轮询只输出"最近一次完成"；若两次完成间隔小于轮询周期，允许只报较新那次（可接受的取舍）。
- **`alerts.attention`**（需要用户处理）：
  - 优先级：未决审批（tracker 中 asked 无 decided）> 待回答 userQuestions（`userQuestions.questions.active` 非空）。
  - 审批：取所有未决审批中 asked 事件 `time` 最大者；`key`=`approval:<approvalId>`；`kind`="approval"；`toolName`=工具名；`at`=asked 事件 time；`sessionId/title/main` 取所属会话（主会话优先展示；子会话的审批也要出警报，此时 main=false）。
  - 问题：取待回答问题的 `callId`（active 数组元素形如 `{callId, questions:[{id,question,...}], state}`）；`key`=`question:<callId>`；`kind`="question"；`toolName`=null；`at` 用该会话 projcache mtime（近似值，稳定即可）；`pendingCount`=active 条数。
  - 同一轮只输出一个 attention（审批优先于问题；同类取 at/最新者）。
  - 未决审批/问题一旦消失（decided / active 清空 / turn end）→ attention 变 null（下一轮即生效）。
- 数据来源与性能约束不变：只读本地落盘、复用现有 tracker/投影解析；**单轮新增开销 ≤5ms**，不新增文件全量扫描。tracker 需要新增记录：`turn/end` 的 `{seq, time}`（每个 tracker 只留最近一条）；`approval/asked` 记录里补存事件 `time`。

## 3. config.json 增量（C# 读取；缺失时用默认并写回）

在现有 `consoleUrl / pollMs / colors` 基础上新增 4 个可选键：

```json
{
  "notifyCompletion": true,
  "notifyApproval": true,
  "playSound": true,
  "soundFile": ""
}
```

- `notifyCompletion` / `notifyApproval`：分别控制两种气泡开关（默认 true）。
- `playSound`：两种通知是否播放提示音（默认 true）。
- `soundFile`：提示音 wav 路径（默认留空 = 使用系统提示音；支持相对路径 = 相对 exe 目录）。文件不存在/损坏 → 写 tray.log 警告并改用系统提示音 `SystemSounds.Exclamation.Play()`，不得崩溃。
- 写默认 config.json 时包含上述键（带默认值）。

## 4. C# 托盘行为（TrayApp.cs）

1. 新增解析：`StatusSnapshot` 增加 `CompletionAlert` 与 `AttentionAlert`（字段见 §2；缺失/非法 JSON 时视为 null，不得崩溃）。
2. 去重状态：`HashSet<string> _notifiedCompletionKeys` / `_notifiedAttentionKeys`（上限 100，FIFO 淘汰），进程内有效。
3. 每个 Timer tick（更新图标之后）执行通知判定：
   - **完成**：`notifyCompletion && alert != null && !string.IsNullOrEmpty(alert.key) && alert.at >= trayStartedAtMs && !seen` → 弹气泡 + 播放提示音。
   - **需要审批**：`notifyApproval && snapshot.State == "approval" && attention != null && !string.IsNullOrEmpty(attention.key) && !seen` → 弹气泡 + 播放提示音。（不要求 `at >= trayStartedAtMs`：启动时已存在的未决审批也应提示一次。）
   - 同一次 tick 同时满足两种通知时：**两条气泡都弹（先后各一次），提示音只播一次**。
   - key 加入 seen 后，同一 key 永不再提示（即使气泡超时/引擎重启）；气泡内容变化但 key 相同不重复弹。
4. 气泡文本（`ShowBalloonTip(6000, title, text, icon)`，NotifyIcon 上）：
   - 完成：标题 `任务完成`；正文 = `「<会话标题>」已完成本轮任务`；标题为空时 `DSH 已完成本轮任务`；截断到 120 字符内、单行。
   - 审批：标题 `需要审批`；正文 = `有操作在等你批准：<toolName>`（toolName 空则 `有操作在等你批准`），会话标题非空时追加 ` · <会话标题>`。
   - 问题：标题 `需要你回答`；正文 = `有 <pendingCount> 个问题待回答`，会话标题非空时追加 ` · <会话标题>`。
   - 图标：完成用 `ToolTipIcon.Info`，审批/问题用 `ToolTipIcon.Warning`。
5. 提示音 `PlayAlertSound()`：
   - 懒加载并缓存 `SoundPlayer(soundFile)`；调用 `Play()`（异步、不阻塞 UI）；加载/播放异常写 tray.log 并回退 `SystemSounds.Exclamation.Play()`。
   - 两次提示音之间至少间隔 800ms（避免双通知重叠刺耳），间隔内跳过播放即可。
6. **日志（供验收）**：每次弹气泡写 `Log.Info("气泡通知(完成): ...")` / `Log.Info("气泡通知(审批): ...")`，每次播声音写 `Log.Info("播放提示音: <file>")`；失败写 Error。
7. 新增调试参数（契约 §7.1 增补）：`DSHStatusTray.exe --test-notify completion|approval` → 用模拟数据走**与真实通知完全相同**的弹气泡+播放提示音代码路径，保持进程存活 5 秒后 `Environment.Exit(0)`（便于验收截图）。同时更新 `--help` 与 README 中的相应描述。
8. 既有行为不得回退：单实例、图标颜色、菜单、托盘关闭、stale 灰灯、`--status/--no-agent/--render-icons/--open-console`、config 容错全部保持；`node --test` 与原有自测必须全绿。

## 5. 验收标准

1. 引擎：`node --test` 全绿（新增 ≥6 个用例覆盖 §2 全部规则），`node src/status-agent.mjs --once` 输出 `version:2` 且含 `alerts` 字段（本机当前无新完成时两者可为 null，不得报错）。
2. C#：build.ps1 编译通过；`--test-notify completion` 与 `--test-notify approval` 均能看到系统气泡、tray.log 有对应记录。
3. 端到端验证：用模拟的 DSH_HOME 驱动真实引擎 + 托盘（`--no-agent --status ...`），先写入 asked 事件 → 托盘弹"需要审批"气泡；再写 decided + turn/end → 托盘弹"任务完成"气泡；两次都有 `播放提示音` 日志；气泡可用截图验证。
4. 真实环境：重启正式托盘后，现有图标/菜单/心跳不受影响；无异常日志。
