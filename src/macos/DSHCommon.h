//
//  DSHCommon.h — DSH 状态托盘（macOS）共享声明
//
//  对应 Windows 版 src/TrayApp.cs：状态灯 / 右键菜单 / 通知 / 全局快捷键 / 余额菜单。
//  实现契约见 docs/（status-schema / alerts-spec / account-balance-spec /
//  working-sessions-spec / state-model-v5 / menu-hotkey-v6）。
//
//  设计约束：零第三方依赖，只用 AppKit / Carbon / UserNotifications；
//  状态引擎仍是 Node 脚本（src/status-agent.mjs），由本程序守护。
//

#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const DSHAppDisplayName;
extern NSString *const DSHBundleIdentifier;
extern NSString *const DSHVersionString;

extern NSString *const DSHDefaultConsoleURL;
extern NSString *const DSHDefaultTopUpURL;
extern NSString *const DSHDefaultWebChatURL;
extern NSString *const DSHDefaultStatusURL;

/// 状态监视器心跳超过该毫秒数即视为「未响应」。
extern const long long DSHStaleAfterMs;

#pragma mark - 路径与外部程序

/// ~/Library/Application Support/DSHStatusTray（与 status-agent.mjs 的 macOS 默认目录一致）。
NSString *DSHDataDirectory(void);
NSString *DSHDefaultStatusPath(void);
NSString *DSHDefaultAgentLogPath(void);
NSString *DSHExpandTilde(NSString *path);
/// DSH_TRAY_AGENT → <App>/Contents/Resources/agent/status-agent.mjs → 开发目录 <root>/src/status-agent.mjs。
NSString * _Nullable DSHFindAgentScript(void);
/// DSH_TRAY_NODE → PATH → 常见安装位置（Homebrew / nvm / volta / fnm / asdf）→ 登录 shell `command -v node`。
NSString * _Nullable DSHFindNodeExecutable(void);
/// 用系统默认浏览器打开 URL（http/https）；返回是否成功。
BOOL DSHOpenURLString(NSString * _Nullable url);
/// 只允许 http/https，避免把奇怪协议交给 NSWorkspace。
BOOL DSHIsWebURL(NSString * _Nullable url);

#pragma mark - 日志

void DSHLogInit(NSString * _Nullable path);
void DSHLogInfo(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
void DSHLogWarn(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
void DSHLogError(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

#pragma mark - JSON 工具（容错：NSNull / 类型不符一律按缺失处理）

BOOL DSHIsDictionary(id _Nullable value);
BOOL DSHIsArray(id _Nullable value);
NSString * _Nullable DSHStringValue(NSDictionary * _Nullable dict, NSString *key);
BOOL DSHBoolValue(NSDictionary * _Nullable dict, NSString *key, BOOL fallback);
long long DSHLongLongValue(NSDictionary * _Nullable dict, NSString *key, long long fallback);
NSInteger DSHIntegerValue(NSDictionary * _Nullable dict, NSString *key, NSInteger fallback);
NSDictionary * _Nullable DSHDictionaryValue(NSDictionary * _Nullable dict, NSString *key);
NSArray * _Nullable DSHArrayValue(NSDictionary * _Nullable dict, NSString *key);

#pragma mark - 时间 / 文本 / 颜色

/// epoch 毫秒（墙钟）。
long long DSHNowMs(void);
/// 单调递增毫秒（不受系统时间调整影响），用于去抖 / 退避。
long long DSHMonotonicMs(void);
/// epoch 毫秒 → 本地时间字符串（非法/0 返回空串）。
NSString *DSHFormatLocalTime(long long epochMs, NSString *format);

/// 换行/制表符 → 空格，压缩连续空白，去首尾空白。
NSString *DSHSanitizeSingleLine(NSString * _Nullable text);
/// 托盘提示规范化：保留换行、逐行清理、总长 ≤60（与 Windows NotifyIcon 预算一致）。
NSString *DSHNormalizeTooltip(NSString * _Nullable raw);
/// 按 UTF-16 长度安全截断（不切断代理对），截断处以 … 收尾。
NSString *DSHTruncateText(NSString * _Nullable text, NSUInteger maxLength);
/// 金额格式化：CNY→¥、USD→$，保留 2 位小数；非法数字返回 nil。
NSString * _Nullable DSHFormatMoney(NSString * _Nullable rawBalance, NSString * _Nullable currency);

NSColor * _Nullable DSHColorFromHex(NSString * _Nullable hex);
NSString *DSHHexFromColor(NSColor *color);
NSColor *DSHDarkenColor(NSColor *color, CGFloat factor);

#pragma mark - 配置（config.json）

@interface DSHConfig : NSObject

@property (nonatomic, copy) NSString *consoleURL;
@property (nonatomic) NSInteger pollMs;
/// state（working/approval/idle/offline）→ 颜色；键名小写。
@property (nonatomic, copy) NSDictionary<NSString *, NSColor *> *stateColors;
@property (nonatomic) BOOL notifyCompletion;
@property (nonatomic) BOOL notifyApproval;
@property (nonatomic) BOOL playSound;
@property (nonatomic, copy) NSString *soundFile;
@property (nonatomic) BOOL showBalance;
@property (nonatomic, copy) NSString *topUpURL;
@property (nonatomic, copy) NSString *webChatURL;
@property (nonatomic, copy) NSString *statusURL;
@property (nonatomic, copy) NSString *hotkey;
/// macOS 专用（Windows 版无此键）：true 时左键单击 = 打开控制台（Windows 行为）；
/// 默认 false：左键单击弹出菜单，符合 macOS 菜单栏习惯，右键同样弹菜单。
@property (nonatomic) BOOL openConsoleOnLeftClick;

+ (instancetype)defaults;
+ (instancetype)loadFromDirectory:(NSString *)directory;
+ (instancetype)loadOrCreateInDirectory:(NSString *)directory;
- (void)saveToDirectory:(NSString *)directory;
- (NSColor *)colorForState:(NSString *)state;
- (void)setStateColor:(NSColor *)color forState:(NSString *)state;

@end

#pragma mark - status.json 模型

@interface DSHAccountInfo : NSObject
@property (nonatomic, copy) NSString *status;
@property (nonatomic, copy, nullable) NSString *balance;
@property (nonatomic, copy, nullable) NSString *currency;
@property (nonatomic, copy, nullable) NSString *bonusBalance;
@property (nonatomic, copy, nullable) NSString *error;
@property (nonatomic, copy, nullable) NSString *topUpURL;
@property (nonatomic) long long fetchedAt;
@end

@interface DSHCompletionAlert : NSObject
@property (nonatomic, copy) NSString *key;
@property (nonatomic) long long at;
@property (nonatomic, copy) NSString *sessionId;
@property (nonatomic, copy) NSString *title;
@property (nonatomic) BOOL main;
@end

@interface DSHAttentionAlert : NSObject
@property (nonatomic, copy) NSString *key;
@property (nonatomic, copy) NSString *kind;
@property (nonatomic) long long at;
@property (nonatomic, copy, nullable) NSString *toolName;
@property (nonatomic, copy) NSString *sessionId;
@property (nonatomic, copy) NSString *title;
@property (nonatomic) BOOL main;
@property (nonatomic) NSInteger pendingCount;
@end

@interface DSHStatusSnapshot : NSObject
@property (nonatomic) long long generatedAt;
@property (nonatomic, copy) NSString *state;
@property (nonatomic, copy) NSString *stateLabel;
@property (nonatomic, copy) NSString *colorName;
@property (nonatomic, copy) NSString *tooltip;
@property (nonatomic, copy) NSString *menuStatus;
@property (nonatomic, copy) NSString *menuDetail;
@property (nonatomic, copy, nullable) NSString *agentError;
@property (nonatomic, copy, nullable) NSString *sessionTitle;
@property (nonatomic, strong, nullable) DSHCompletionAlert *completion;
@property (nonatomic, strong, nullable) DSHAttentionAlert *attention;
@property (nonatomic, strong, nullable) DSHAccountInfo *account;

/// 非法/缺字段一律安全降级（state=offline、stateLabel=未运行）。
+ (instancetype)fromDictionary:(NSDictionary *)root;
@end

#pragma mark - 图标绘制

@interface DSHIconPainter : NSObject

/// 菜单栏圆点（18pt 为常规尺寸，内部按 2x 位图绘制，Retina 清晰）。
+ (nullable NSImage *)dotImageWithColor:(NSColor *)color pointSize:(CGFloat)pointSize;
/// 导出 4 种状态图标 PNG（--render-icons，尺寸与 Windows 版一致：32x32）。
+ (BOOL)writeDotPNGForColor:(NSColor *)color toPath:(NSString *)path pixelSize:(NSUInteger)pixelSize;
/// 导出应用图标 PNG（--render-app-icon；深色圆角底 + 四色状态灯）。
+ (BOOL)writeAppIconPNGToPath:(NSString *)path pixelSize:(NSUInteger)pixelSize;

@end

#pragma mark - 状态引擎守护

@interface DSHAgentSupervisor : NSObject

- (instancetype)initWithNodePath:(nullable NSString *)nodePath
                      scriptPath:(nullable NSString *)scriptPath
                      statusPath:(NSString *)statusPath
                         logPath:(NSString *)logPath
                      intervalMs:(NSInteger)intervalMs
                         workDir:(NSString *)workDir
                  accountEnabled:(BOOL)accountEnabled
                      consoleURL:(nullable NSString *)consoleURL;

@property (nonatomic, readonly) BOOL canRun;
/// 无法启动时的原因说明；可启动时 nil。
@property (nonatomic, readonly, copy, nullable) NSString *diagnostic;
/// 最近一次启动参数（不含 token 等敏感信息）。
@property (nonatomic, readonly, copy, nullable) NSString *lastArguments;
@property (nonatomic, readonly) BOOL isRunning;

- (void)start;
/// 守护：进程退出或心跳过期时按 ≥10s 退避重启。
- (void)ensureRunningWithStaleHeartbeat:(BOOL)stale;
- (void)stop;

@end

#pragma mark - 全局快捷键（Carbon RegisterEventHotKey）

@class DSHHotkeyDefinition;

@protocol DSHHotkeyManagerDelegate <NSObject>
- (void)hotkeyManagerDidTrigger:(id)manager;
@end

@interface DSHHotkeyDefinition : NSObject

@property (nonatomic, readonly) UInt32 modifiers;   // DSHHotkeyMod* 位掩码
@property (nonatomic, readonly) UInt32 keyCode;     // Carbon 虚拟键码
@property (nonatomic, readonly, copy) NSString *keyName;
/// 规范字符串（与 Windows 版一致：Ctrl+Alt+Shift+Win 顺序；Win 在 macOS 上是 Command）。
@property (nonatomic, readonly, copy) NSString *comboString;
/// macOS 展示文本（⌃⌥⇧⌘ + 键名）。
@property (nonatomic, readonly, copy) NSString *displayString;

+ (nullable instancetype)parse:(NSString *)text error:(NSString * _Nullable * _Nullable)error;
/// 由录制到的键码 + 修饰键构造；不支持的键返回 nil。
+ (nullable instancetype)definitionWithKeyCode:(unsigned short)keyCode
                                  modifierFlags:(NSEventModifierFlags)flags
                                          error:(NSString * _Nullable * _Nullable)error;
+ (UInt32)modifiersFromModifierFlags:(NSEventModifierFlags)flags;
+ (NSString *)formatModifiers:(UInt32)modifiers;
+ (NSString *)displayModifiers:(UInt32)modifiers;
+ (BOOL)isModifierKeyCode:(unsigned short)keyCode;

@end

@interface DSHHotkeyManager : NSObject

@property (nonatomic, weak, nullable) id<DSHHotkeyManagerDelegate> delegate;
@property (nonatomic, readonly, copy, nullable) NSString *currentCombo;
@property (nonatomic, readonly) BOOL isRegistered;

- (BOOL)registerDefinition:(nullable DSHHotkeyDefinition *)definition error:(NSString * _Nullable * _Nullable)error;
- (void)unregister;

@end

@interface DSHHotkeySettingsWindow : NSObject

- (instancetype)initWithConfig:(DSHConfig *)config
                       manager:(DSHHotkeyManager *)manager
                       dataDir:(NSString *)dataDir;
/// 模态显示；关闭后自动按 config 中的最新值恢复注册。
- (void)runModal;

@end

#pragma mark - 启动参数

@interface DSHOptions : NSObject

@property (nonatomic, copy, nullable) NSString *statusPath;
@property (nonatomic) BOOL noAgent;
@property (nonatomic, copy, nullable) NSString *renderIconsDir;
@property (nonatomic, copy, nullable) NSString *renderAppIconPath;
@property (nonatomic) BOOL openConsole;
@property (nonatomic) BOOL openBalance;
@property (nonatomic) BOOL openWeb;
@property (nonatomic) BOOL openStatus;
@property (nonatomic) BOOL openHotkeySettings;
@property (nonatomic, copy, nullable) NSString *testNotifyKind;
@property (nonatomic, copy, nullable) NSString *hotkeyOverride;
@property (nonatomic) BOOL showMenu;
@property (nonatomic) BOOL printMenu;
@property (nonatomic) BOOL help;
/// 参数非法（例如 --test-notify 的取值不是 completion/approval），主程序以退出码 2 结束。
@property (nonatomic) BOOL invalidArguments;

+ (instancetype)parseArguments:(NSArray<NSString *> *)arguments;
+ (NSString *)usageText;

@end

#pragma mark - 托盘控制器

@interface DSHTrayController : NSObject <UNUserNotificationCenterDelegate, DSHHotkeyManagerDelegate>

- (instancetype)initWithConfig:(DSHConfig *)config
                       dataDir:(NSString *)dataDir
                    statusPath:(NSString *)statusPath
                       options:(DSHOptions *)options;

- (void)start;
- (void)shutdown;

/// 验收辅助：返回当前菜单结构（`---` 表示分隔线），不弹出菜单。
- (NSArray<NSString *> *)describeMenuForSnapshot:(nullable DSHStatusSnapshot *)snapshot stale:(BOOL)stale;

/// 供 --open-hotkey-settings 使用（不启动托盘/引擎）。
+ (void)openHotkeySettingsWithConfig:(DSHConfig *)config dataDir:(NSString *)dataDir;

@end

NS_ASSUME_NONNULL_END
