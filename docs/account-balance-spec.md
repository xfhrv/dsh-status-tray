# DSH 状态托盘 — 账户"充值余额"菜单增强契约（v3）

> 本文档描述 v3 版本的账户余额契约，叠加在 [status-schema.md](status-schema.md)（v1）与 [alerts-spec.md](alerts-spec.md)（v2）之上；冲突处以本文件为准。v4–v5 以增量方式继续叠加，当前最新行为以 v5 为准；文档索引见 [README.md](README.md)。
> 目标：右键菜单里新增一项显示当前 DeepSeek 账户**充值余额**的功能。
> 接口可用性（已验证）：`GET https://platform.deepseek.com/api/v0/users/get_user_summary`，用 `<DSH_HOME>/.credentials.yaml` 里 `deepseek-account-platform/default` 的 token 作 `x-dsh-auth-token` 头，HTTP 200、`code=0`、`data.biz_code=0`，`data.biz_data.normal_wallets=[{currency:"CNY",balance:"12.3400000000000000"}]`（充值余额），`bonus_wallets`（赠送余额）另列。

## 1. 组件职责

- **状态引擎（Node）**：读凭证 → 定时调 Platform 接口 → 把**已格式化的余额信息**写进 status.json 的 `account` 字段（`version` 升为 **3**）。绝不把 token 写进 status.json/日志。
- **托盘 UI（C#）**：解析 `account`，在右键菜单显示 `充值余额：¥xx.xx`；点击用默认浏览器打开充值页（`account.topUpUrl`）。不自己发网络请求。
- **集成与发布**：两端联调、端到端验证与 README 更新在发布前完成。

## 2. status.json v3 增量

```json
{
  "version": 3,
  "account": {
    "status": "ready",
    "balance": "12.3400000000000000",
    "currency": "CNY",
    "bonusBalance": "0",
    "fetchedAt": 1793549000000,
    "error": null,
    "topUpUrl": "https://platform.deepseek.com/top_up"
  }
}
```

规则：
- `account` 字段**必须始终存在**（引擎旧版不会输出，C# 侧容错为 null）。
- `status` ∈ `"ready" | "loading" | "error" | "unavailable"`：
  - `loading`：尚未拿到第一次结果（引擎刚启动/正在请求）。
  - `ready`：成功；`balance` 为 Platform 返回的原始十进制字符串（保留精度，不在引擎侧四舍五入），`currency` 为 `"CNY"|"USD"`，`bonusBalance` 取 `bonus_wallets` 中同币种余额（无则 `"0"`）。
  - `error`：请求失败；`error` ∈ `"auth" | "network" | "protocol"`（`auth` = HTTP 401 或 `code=40003`，即登录失效）。
  - `unavailable`：本机没有可用账户 token（未登录/凭证文件缺失）；`error="no-token"`。
- `fetchedAt`：最近一次成功/失败结果的时刻（epoch ms）；`loading` 且无结果时可为 null。
- `topUpUrl`：`<accountPlatformOrigin>/top_up`（默认 `https://platform.deepseek.com/top_up`）。
- 刷新策略：引擎启动后立即后台拉一次；成功后每 `accountRefreshMs`（默认 600000 = 10 分钟）刷新；失败后 60000ms 重试。刷新在后台异步进行，**不得阻塞状态心跳**（status.json 仍每 500ms 写）。
- 安全：token 只存在于引擎内存；status.json、agent.log、错误信息里**不得出现 token**（错误只留分类码）。
- 性能：网络请求 8s 超时；每轮状态采集新增开销 ≤1ms（只读内存缓存）。

## 3. 引擎 CLI / 配置增量

引擎新增参数：
```
--account                   # 启用余额查询（不传则 account 恒为 unavailable/no-token 或 null；默认不联网，保证单测/--once 无网络副作用）
--account-origin <url>      # 默认 https://platform.deepseek.com
--account-timeout-ms <ms>   # 默认 8000
--account-refresh-ms <ms>   # 默认 600000
--credentials <path>        # 默认 <DSH_HOME>/.credentials.yaml（测试用）
```
- token 解析：在 credentials YAML 文本中匹配 `deepseek-account-platform/default:` 块内的 `token:` 值（简单正则即可，文件很小）；若其 `issuer` 存在且不等于 `account-origin` 则视为 `unavailable`。
- 请求头（参照 DSH 自身实现，token 头为 `x-dsh-auth-token`）：
  `x-dsh-auth-token: <token>`、`x-client-platform: web`、`x-client-version: <引擎常量 0.2.1-rc.2>`、`x-client-locale: zh_CN`、`x-client-timezone-offset: <当前 UTC 偏移秒>`、`x-client-bundle-id: ""`。
- 响应判定：HTTP 200 且 JSON `code===0 && data.biz_code===0` → `biz_data.normal_wallets` 找 `currency` 优先 CNY（否则第一个），`balance` 校验十进制字符串；`bonus_wallets` 同币种余额进 `bonusBalance`。HTTP 401 或顶层 `code===40003` → `error:"auth"`。其余 → `error:"network"|"protocol"`。
- `--once`：仅当显式传 `--account` 时才发起一次查询（测试会传 `--account-origin http://127.0.0.1:<port>` 指向本地 mock server）。

## 4. config.json 增量（C# 读取，默认写回）

```json
{
  "showBalance": true,
  "topUpUrl": "https://platform.deepseek.com/top_up"
}
```
- `showBalance`（默认 true）：是否在菜单显示余额项；true 时 C# 给引擎子进程加 `--account`。
- `topUpUrl`（默认 `https://platform.deepseek.com/top_up`）：点击余额项打开的地址（覆盖 status.json 里的 topUpUrl；用于特殊部署）。
- 其余现有配置键不变。

## 5. C# 菜单行为（TrayApp.cs）

1. 解析 `account`（缺失/null/非法字段安全降级，v1/v2 的 status.json 不崩）。
2. 菜单新增一项，位置在**「打开控制台」之后、分隔线/「退出」之前**，标题按状态：
   - ready：`充值余额：¥xx.xx`（CNY→`¥`、USD→`$`；保留 2 位小数，千分位可选；balance 为 "0" 时同样按两位小数显示 0 值）
   - loading：`充值余额：获取中…`
   - error=auth：`充值余额：登录已过期`
   - error=network/protocol：`充值余额：获取失败`
   - unavailable/no-token 或 account 为 null：`充值余额：未登录`
   - 仍保持可点击。
3. 点击 → 用系统默认浏览器打开：`config.topUpUrl` 非空则用它，否则 `account.topUpUrl`，否则默认 `https://platform.deepseek.com/top_up`。失败写 tray.log，不崩溃。
4. 菜单项的 `ToolTipText`（可选）显示详细：赠送余额/更新时间/错误提示，例如 `赠送余额：¥xx.xx · 10:32 更新`。
5. 菜单每次 Opening 时按最新快照刷新文字（状态行已有此机制，沿用）。
6. 既有功能不得回退：气泡通知/提示音、图标、单实例、状态行、打开控制台、退出、全部调试参数。

## 6. 验收标准

1. `node --test` 全绿；新增用例 ≥6：ready（mock server 返回 normal/bonus wallets）、auth（401 或 code 40003）、network（连接失败/超时）、protocol（坏 JSON/负余额/非数字）、no-token（凭证缺失）、刷新失败后缓存保留 + 成功后清除错误、token 不出现在 status 输出中。
2. 在已登录账户的机器上运行 `node src/status-agent.mjs --once --account`，返回 `version:3`、`account.status="ready"`、balance 为十进制字符串、topUpUrl 正确；stdout/日志不含 token 原文。
3. C#：build.ps1 通过；`--no-agent --status <fixture>` 分别喂 ready/loading/auth/network/no-token 的 account 快照，菜单项文字正确；点击余额项用默认浏览器打开 topUpUrl（可用 `--open-balance` 调试参数验证，见 §7）。
4. 端到端验证：真实引擎 `--account` + 托盘，菜单显示真实余额；截图。
5. 重启正式托盘后，原有红灯/黄灯/菜单/气泡通知全部正常，无 ERROR 日志。

## 7. 调试参数（C#，§7.1 增补）

- `DSHStatusTray.exe --open-balance`：直接执行"点击余额项"的打开逻辑（用默认浏览器打开 topUpUrl）后退出，退出码 0 表示未抛异常。
- `--status/--no-agent` 等既有调试参数继续支持。
