# DSH 状态托盘 — 菜单扩展 + 全局快捷键契约（v6）

> 本文档描述 v6 版本的右键菜单扩展与全局快捷键契约，叠加在 [status-schema.md](status-schema.md)（v1）、[alerts-spec.md](alerts-spec.md)（v2）、[account-balance-spec.md](account-balance-spec.md)（v3）、[working-sessions-spec.md](working-sessions-spec.md)（v4）、[state-model-v5.md](state-model-v5.md)（v5）之上；冲突处以本文件为准。文档索引见 [README.md](README.md)。
> 版本范围：**只改 C# 托盘（src/TrayApp.cs）**，状态引擎与 `status.json` 结构不变（仍为 version 5）。

## 1. 右键菜单最终结构（自上而下）

```
打开控制台                     → http://127.0.0.1:3080（config.consoleUrl）
打开网页版 DeepSeek            → https://chat.deepseek.com/（config.webChatUrl）
查看 DS 服务器状态              → https://status.deepseek.com/（config.statusUrl）
充值余额：¥xx.xx               → 打开 config.topUpUrl（沿用 v3 行为与文案）
──────────────────
设置全局快捷键…                → 打开「设置全局快捷键」小窗口
──────────────────
退出                           → 退出托盘
```

- 全部 8 项（6 个可点击项 + 2 个分隔线）均可用；充值余额项始终可点击。
- 前四项点击 = 用系统默认浏览器打开对应 URL；「设置全局快捷键…」打开设置窗口。
- 双击托盘图标 = 打开控制台；**新增：鼠标左键单击托盘图标 = 打开控制台**（见 §3）。
- 菜单中不显示"状态/权限"文字行（保持 v5 精简）。

## 2. config.json 新增（C# 读写，旧配置自动补写）

```json
{
  "webChatUrl": "https://chat.deepseek.com/",
  "statusUrl": "https://status.deepseek.com/",
  "hotkey": ""
}
```

- 缺省值如上；旧 v5 配置启动时自动补写这 3 个键，其它键原样保留。
- `hotkey`：空字符串 = 未设置；非空格式见 §4。启动时若非空则自动注册；注册失败写 `tray.log` 警告并保留配置（下次可再试 / 修改）。

## 3. 鼠标左键行为

- 左键**单击**托盘图标 = 打开控制台（与全局快捷键同一动作）。
- 判定只按"左键"（`e.Button == MouseButtons.Left`），**不依赖 `e.Clicks`**：Windows 11 上托盘图标的 `NotifyIcon.MouseClick` 事件里 `e.Clicks` 可能恒为 0，用 `clicks == 1` 判断会导致左键永远不触发。
- 防双击重复开标签：内置 500–800ms 去抖（记录上次左键打开时刻，阈值内忽略后续点击）；双击时第一下打开、第二下被去抖。
- 右键菜单、悬停提示不受影响。

## 4. 全局快捷键

### 4.1 设置窗口

- 从菜单「设置全局快捷键…」打开，模态小窗口（约 420×260、居中、标题「设置全局快捷键」）。
- 内容：
  - 说明文案：`按下新的快捷键组合（至少包含 Ctrl / Alt / Shift / Win 之一 + 一个普通键）`。
  - 只读捕获框：实时显示当前按下的组合，如 `Ctrl+Alt+F9`；未捕获时显示占位 `按下快捷键…`。
  - 状态行：`当前：未设置` / `当前：Ctrl+Alt+F9（已注册）` / `注册失败：快捷键可能被其他程序占用`。
  - 按钮：`保存并注册`（保存并立即生效、写回 config）、`清除`（注销热键、hotkey 置空）、`取消`。
- 行为：
  - 窗口打开期间**临时注销**已有热键（防止按旧热键触发控制台），保存 / 取消 / 关闭后按最新配置重新注册。
  - 按 `Esc` 取消当前捕获（不清除已保存值）；按 `Backspace`/`Delete` 清除捕获框。
  - 只捕获"修饰键 + 普通键"组合：忽略单独按下的修饰键；**必须至少含一个修饰键**（Ctrl/Alt/Shift/Win）+ 一个非修饰键，否则状态行提示 `请再按一个普通键`。
  - 保存时若注册失败（被占用 / 系统保留），窗口不关闭并显示失败原因；配置仍写入以便下次启动重试。
  - 捕获可用键：A–Z、0–9、F1–F24、Space、方向键（Up/Down/Left/Right）、Home/End/PageUp/PageDown/Insert、Delete。
- 组合规范字符串：`Ctrl+Alt+Shift+Win+Key`（顺序固定：Ctrl→Alt→Shift→Win→Key；未按下的修饰键省略；`Win` 写作 `Win`；键名大小写见 §4.3）。窗口重新打开时显示已保存组合。

### 4.2 注册与触发

- Win32 `RegisterHotKey`（MOD_ALT=1 / MOD_CONTROL=2 / MOD_SHIFT=4 / MOD_WIN=8）+ 隐藏消息窗口接收 `WM_HOTKEY`(0x0312)。
- 触发时执行与「打开控制台」相同的动作（默认浏览器打开 `consoleUrl`），并写 `tray.log`：`全局快捷键触发: Ctrl+Alt+F9 -> http://127.0.0.1:3080`。
- 程序退出、换绑、清除时必须调用 `UnregisterHotKey`；单实例逻辑不变。
- 同一时刻只注册一个全局热键。

### 4.3 键名映射（字符串 ↔ 虚拟键码）

- 字母：`A`–`Z` → VK 0x41–0x5A；数字：`0`–`9` → VK 0x30–0x39（顶层数字键，非小键盘）。
- 功能键：`F1`–`F24`。
- 特殊键：`Space`(0x20)、`Up`(0x26)、`Down`(0x28)、`Left`(0x25)、`Right`(0x27)、`Home`(0x24)、`End`(0x23)、`PageUp`(0x21)、`PageDown`(0x22)、`Insert`(0x2D)、`Delete`(0x2E)。
- 不支持：带修饰键的小键盘键、媒体键、单独修饰键、组合键中的 `Escape`。捕获到不支持键时忽略并提示。
- 解析函数容错：大小写不敏感、多余空格、非法字符串 → 视为未设置 / 提示非法。

## 5. 调试参数（C#，新增）

- `DSHStatusTray.exe --open-web`：打开网页版 DeepSeek 后退出（exit 0）。
- `DSHStatusTray.exe --open-status`：打开 DS 服务器状态页后退出（exit 0）。
- `DSHStatusTray.exe --open-hotkey-settings`：直接打开设置窗口（不启动托盘 / 引擎；用于截图与 UI 自动化）。
- `DSHStatusTray.exe --hotkey "Ctrl+Alt+F9"`：本次运行用该组合注册（覆盖 config，不写配置；用于热键端到端测试）。
- 既有 `--status` / `--no-agent` / `--render-icons` / `--open-console` / `--open-balance` / `--test-notify` 保持不变。

## 6. 验收标准

1. `build.ps1` 通过（C# 5 / csc 4.0 限制不变）；内部测试覆盖：菜单 8 项结构与顺序、URL / 配置解析、hotkey 字符串解析与格式化（含非法 / 纯修饰 / 不支持键）、config 补写与持久化、左键单击判定、注册 / 注销状态机。
2. 运行时端到端验证：
   - 右键菜单截图：8 项（含 2 分隔线）顺序正确；
   - 选择「打开网页版 DeepSeek」→ 默认浏览器地址为 `https://chat.deepseek.com/`；「查看 DS 服务器状态」→ `https://status.deepseek.com/`；「充值余额」仍打开 top_up（回归）；
   - 打开设置窗口截图，捕获 `Ctrl+Alt+F9` 并保存 → `config.json` 的 `hotkey` 写入；
   - 全局热键：托盘在后台时按 `Ctrl+Alt+F9` → 默认浏览器打开 `http://127.0.0.1:3080`，`tray.log` 有触发记录；
   - 重启托盘后热键仍自动注册生效；
   - 左键单击托盘图标 → 打开控制台（双击不重复开两个标签）。
3. 既有功能回归：四色状态 / 悬停提示 / 气泡通知 + 提示音 / 充值余额 / 单实例 / 退出，全部正常、无 ERROR 日志。
