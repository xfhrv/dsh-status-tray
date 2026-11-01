# DSH 状态托盘 — 文档索引

本目录收录 DSH 状态托盘（Windows 任务栏托盘状态灯）的设计与实现契约。文档按版本增量演进：**v1 [status-schema.md](status-schema.md) → v2 [alerts-spec.md](alerts-spec.md) → v3 [account-balance-spec.md](account-balance-spec.md) → v4 [working-sessions-spec.md](working-sessions-spec.md) → v5 [state-model-v5.md](state-model-v5.md)**，即 v1 定义状态判定、数据源、`status.json`、`config.json`、菜单与进程模型，v2 增加任务完成/审批通知与提示音，v3 增加充值余额菜单，v4 增加多会话悬停提示，v5 将状态模型简化为四态并精简右键菜单；后一版本在前一版本之上增量生效，冲突处以版本更高者为准，当前最新为 v5。

安装、使用与配置说明见仓库根目录的 `README.md`。

## 文档导航

| 版本 | 文档 | 内容 |
|---|---|---|
| v1 | [status-schema.md](status-schema.md) | 总体设计：状态判定与颜色、数据源（会话投影缓存 + 会话日志）、`status.json` 字段、`config.json`、进程模型、CLI 与验收标准 |
| v2 | [alerts-spec.md](alerts-spec.md) | 通知增强：`alerts.completion` / `alerts.attention` 事件、气泡与提示音、去重规则、`--test-notify` |
| v3 | [account-balance-spec.md](account-balance-spec.md) | 账户增强：`account` 字段、充值余额菜单项、`showBalance` / `topUpUrl` 配置、`--open-balance` |
| v4 | [working-sessions-spec.md](working-sessions-spec.md) | 多会话增强：`workingSessions` 字段、多行悬停提示（≤60 字符）与截断策略 |
| v5 | [state-model-v5.md](state-model-v5.md) | 当前状态模型：`approval` / `working` / `idle` / `offline` 四态与四色映射、旧配置迁移、菜单精简 |

## 版本约定

每份文档描述其对应版本的行为；后一版本可能覆盖前一版本的部分结论（例如 v5 取消了 `restricted` 状态与 `darkgray` 颜色，并去掉右键菜单中的状态行/权限行）。阅读与实现时，以版本号更高的文档为准。

## 阅读建议

- 想了解"状态是怎么算出来的"：先读 [status-schema.md](status-schema.md) §5（数据源与判定），状态模型以 [state-model-v5.md](state-model-v5.md) §1 为准。
- 想了解 `status.json` 完整字段：v1 §4 是字段全集，v2 §2、v3 §2、v4 §2 依次追加 `alerts`、`account`、`workingSessions`，`version` 由 1 递增至 5。
- 想参与实现或提交变更：各文档的"验收标准"是对应版本的验收基线；实现约束（零第三方依赖、不修改 DSH 本体、只读本地数据）见 v1 §2 与 §9 第 6 条。
- 已知边界与取舍：v1 §10 与 v5 §1 共同说明运行环境、多会话聚合与托盘提示长度等限制。
