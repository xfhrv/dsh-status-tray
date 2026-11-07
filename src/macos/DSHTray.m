//
//  DSHTray.m — 菜单栏状态灯 / 右键菜单 / 通知 / 轮询
//
//  对应 Windows 版 TrayApp（NotifyIcon + ContextMenuStrip + Timer + NotifyIcon.ShowBalloonTip）。
//  macOS 差异：
//    * 菜单栏图标默认左键弹菜单（macOS 习惯）；config.openConsoleOnLeftClick=true 可恢复
//      Windows 的「左键单击打开控制台」。
//    * 通知使用 UserNotifications；未授权时回退 osascript，避免静默丢弃。
//    * 菜单顶部增加状态行（Windows 版只放在托盘 tooltip 里，macOS 上 tooltip 不易看到）。
//

#import "DSHCommon.h"
#import <UserNotifications/UserNotifications.h>

static const NSInteger DSHSeenKeyCapacity = 100;
static const long long DSHLeftClickDebounceMs = 700;
static const long long DSHStatusErrorLogEveryMs = 10000;
static const long long DSHNotificationSoundMinIntervalMs = 800;
static const long long DSHTestNotifyDelayMs = 1200;
static const long long DSHTestExitDelayMs = 6500;
static const NSUInteger DSHNotificationTextMaxLength = 120;

#pragma mark - 通知文案（与 Windows 版逐字一致）

static NSString *DSHBuildCompletionText(NSString *sessionTitle) {
    NSString *title = DSHSanitizeSingleLine(sessionTitle);
    NSString *text = title.length ? [NSString stringWithFormat:@"「%@」已完成本轮任务", title]
                                  : @"DSH 已完成本轮任务";
    return DSHTruncateText(text, DSHNotificationTextMaxLength);
}

static NSString *DSHBuildApprovalText(NSString *toolName, NSString *sessionTitle) {
    NSString *text = toolName.length ? [NSString stringWithFormat:@"有操作在等你批准：%@", DSHSanitizeSingleLine(toolName)]
                                     : @"有操作在等你批准";
    NSString *title = DSHSanitizeSingleLine(sessionTitle);
    if (title.length) {
        text = [text stringByAppendingFormat:@" · %@", title];
    }
    return DSHTruncateText(text, DSHNotificationTextMaxLength);
}

static NSString *DSHBuildQuestionText(NSInteger pendingCount, NSString *sessionTitle) {
    NSInteger count = pendingCount > 0 ? pendingCount : 1;
    NSString *text = [NSString stringWithFormat:@"有 %ld 个问题待回答", (long)count];
    NSString *title = DSHSanitizeSingleLine(sessionTitle);
    if (title.length) {
        text = [text stringByAppendingFormat:@" · %@", title];
    }
    return DSHTruncateText(text, DSHNotificationTextMaxLength);
}

#pragma mark - 余额文案（account-balance-spec §5）

static NSString *DSHNormalizeAccountToken(NSString *value) {
    return [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].lowercaseString ?: @"";
}

static NSString *DSHBalanceMenuText(DSHAccountInfo *account) {
    if (!account) {
        return @"充值余额：未登录";
    }
    NSString *status = DSHNormalizeAccountToken(account.status);
    if ([status isEqualToString:@"ready"]) {
        NSString *money = DSHFormatMoney(account.balance, account.currency);
        return money ? [NSString stringWithFormat:@"充值余额：%@", money] : @"充值余额：获取失败";
    }
    if ([status isEqualToString:@"loading"]) {
        return @"充值余额：获取中…";
    }
    if ([status isEqualToString:@"error"]) {
        NSString *error = DSHNormalizeAccountToken(account.error);
        if ([error isEqualToString:@"auth"]) {
            return @"充值余额：登录已过期";
        }
        if ([error isEqualToString:@"network"] || [error isEqualToString:@"protocol"]) {
            return @"充值余额：获取失败";
        }
        return @"充值余额：未登录";
    }
    return @"充值余额：未登录";
}

static NSString *DSHBalanceTooltip(DSHAccountInfo *account) {
    if (!account) {
        return @"";
    }
    NSString *status = DSHNormalizeAccountToken(account.status);
    if ([status isEqualToString:@"ready"]) {
        NSString *bonus = DSHFormatMoney(account.bonusBalance, account.currency);
        NSString *time = DSHFormatLocalTime(account.fetchedAt, @"HH:mm");
        if (bonus.length && time.length) {
            return [NSString stringWithFormat:@"赠送余额：%@ · %@ 更新", bonus, time];
        }
        if (bonus.length) {
            return [NSString stringWithFormat:@"赠送余额：%@", bonus];
        }
        if (time.length) {
            return [NSString stringWithFormat:@"%@ 更新", time];
        }
        return @"";
    }
    if ([status isEqualToString:@"loading"]) {
        return @"正在获取账户余额…";
    }
    if ([status isEqualToString:@"error"]) {
        NSString *error = DSHNormalizeAccountToken(account.error);
        if ([error isEqualToString:@"auth"]) {
            return @"登录已过期，请在 DSH 中重新登录后自动刷新";
        }
        if ([error isEqualToString:@"network"] || [error isEqualToString:@"protocol"]) {
            return @"获取失败，稍后自动重试";
        }
    }
    return @"";
}

#pragma mark - 菜单标题

static NSAttributedString *DSHMenuTitle(NSString *text, CGFloat size, NSColor *color, BOOL bold) {
    NSFont *font = bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size];
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.lineBreakMode = NSLineBreakByTruncatingTail;
    return [[NSAttributedString alloc] initWithString:text ?: @"" attributes:@{
        NSFontAttributeName : font,
        NSForegroundColorAttributeName : color ?: [NSColor labelColor],
        NSParagraphStyleAttributeName : paragraph,
    }];
}

#pragma mark - DSHTrayController

@interface DSHTrayController ()
@property (nonatomic, strong) DSHConfig *config;
@property (nonatomic, copy) NSString *dataDir;
@property (nonatomic, copy) NSString *statusPath;
@property (nonatomic, copy) NSString *agentLogPath;
@property (nonatomic) BOOL noAgent;
@property (nonatomic, copy, nullable) NSString *testNotifyKind;
@property (nonatomic, copy, nullable) NSString *hotkeyOverride;
@property (nonatomic, strong) DSHOptions *options;

@property (nonatomic, strong, nullable) NSStatusItem *statusItem;
@property (nonatomic, strong, nullable) NSTimer *timer;
@property (nonatomic, strong, nullable) DSHAgentSupervisor *agent;
@property (nonatomic, strong, nullable) DSHHotkeyManager *hotkeyManager;
@property (nonatomic, strong, nullable) DSHHotkeySettingsWindow *hotkeySettingsWindow;

@property (nonatomic, strong, nullable) DSHStatusSnapshot *lastSnapshot;
@property (nonatomic, copy) NSString *lastTooltip;
@property (nonatomic, copy) NSString *lastIconKey;
@property (nonatomic) BOOL lastTickStale;
@property (nonatomic) BOOL shuttingDown;
@property (nonatomic) BOOL notificationsAllowed;

@property (nonatomic, strong) NSMutableArray<NSString *> *seenCompletionKeys;
@property (nonatomic, strong) NSMutableArray<NSString *> *seenAttentionKeys;
@property (nonatomic, strong, nullable) NSSound *soundPlayer;
@property (nonatomic) long long lastSoundMs;
@property (nonatomic) long long lastLeftClickMs;
@property (nonatomic) long long lastStatusErrorMs;
@property (nonatomic) long long trayStartedAtMs;
@end

@implementation DSHTrayController

- (instancetype)initWithConfig:(DSHConfig *)config
                       dataDir:(NSString *)dataDir
                    statusPath:(NSString *)statusPath
                       options:(DSHOptions *)options {
    self = [super init];
    if (self) {
        _config = config;
        _dataDir = [dataDir copy];
        _statusPath = statusPath.length ? [statusPath copy]
                                        : [dataDir stringByAppendingPathComponent:@"status.json"];
        _agentLogPath = [dataDir stringByAppendingPathComponent:@"agent.log"];
        _noAgent = options.noAgent || options.testNotifyKind.length > 0 || options.showMenu;
        _testNotifyKind = [options.testNotifyKind copy];
        _hotkeyOverride = [options.hotkeyOverride copy];
        _options = options;

        _seenCompletionKeys = [NSMutableArray array];
        _seenAttentionKeys = [NSMutableArray array];
        _lastTooltip = @"";
        _lastIconKey = @"";
        _lastSoundMs = 0;
        _lastLeftClickMs = 0;
        _lastStatusErrorMs = 0;
        _trayStartedAtMs = DSHNowMs();
    }
    return self;
}

- (void)start {
    [self setupNotifications];

    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSStatusBarButton *button = self.statusItem.button;
    button.image = [DSHIconPainter dotImageWithColor:[self.config colorForState:@"idle"] pointSize:18.0];
    button.imagePosition = NSImageOnly;
    button.toolTip = @"状态监视器启动中";
    button.target = self;
    button.action = @selector(statusItemClicked:);
    [button sendActionOn:(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)];
    self.statusItem.visible = YES;

    [self setupHotkey];

    if (!self.noAgent) {
        [self startAgent];
    }

    NSInteger intervalMs = MAX(250, MIN(10000, self.config.pollMs));
    NSTimer *timer = [NSTimer timerWithTimeInterval:(NSTimeInterval)intervalMs / 1000.0
                                             target:self
                                           selector:@selector(onTimerTick:)
                                           userInfo:nil
                                            repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSRunLoopCommonModes];
    self.timer = timer;

    if (self.testNotifyKind.length) {
        [self setupTestNotify];
    } else {
        [self tickOnce];
    }

    if (self.options.showMenu) {
        __weak typeof(self) weakSelf = self;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 800 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [weakSelf showMenu];
        });
        // 菜单跟踪期间主队列的 GCD 块不会执行，这里用 NSTimer（含事件跟踪模式）负责退出。
        NSTimer *exitTimer = [NSTimer timerWithTimeInterval:4.0
                                                    repeats:NO
                                                      block:^(NSTimer *timer) {
            [NSApp terminate:nil];
        }];
        [[NSRunLoop mainRunLoop] addTimer:exitTimer forMode:NSRunLoopCommonModes];
        [[NSRunLoop mainRunLoop] addTimer:exitTimer forMode:NSEventTrackingRunLoopMode];
    }

    DSHLogInfo(@"托盘启动完成: dataDir=%@ status=%@ noAgent=%d pollMs=%ld",
               self.dataDir, self.statusPath, self.noAgent ? 1 : 0, (long)intervalMs);
}

#pragma mark - 初始化

- (void)setupNotifications {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = self;

    __weak typeof(self) weakSelf = self;
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) {
                return;
            }
            UNAuthorizationStatus status = settings.authorizationStatus;
            if (status == UNAuthorizationStatusAuthorized || status == UNAuthorizationStatusProvisional) {
                strongSelf.notificationsAllowed = YES;
                DSHLogInfo(@"通知权限: 已授予");
                return;
            }
            if (status == UNAuthorizationStatusDenied) {
                DSHLogWarn(@"通知权限被拒绝：可在「系统设置 → 通知 → %@」开启；当前回退为 osascript 通知", DSHAppDisplayName);
                return;
            }
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionBadge)
                                  completionHandler:^(BOOL granted, NSError *error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    typeof(self) innerSelf = weakSelf;
                    if (!innerSelf) {
                        return;
                    }
                    innerSelf.notificationsAllowed = granted;
                    if (granted) {
                        DSHLogInfo(@"通知权限: 已授予");
                    } else {
                        DSHLogWarn(@"通知权限未授予%@；当前回退为 osascript 通知",
                                   error ? [NSString stringWithFormat:@"（%@）", error.localizedDescription] : @"");
                    }
                });
            }];
        });
    }];
}

- (void)setupHotkey {
    self.hotkeyManager = [[DSHHotkeyManager alloc] init];
    self.hotkeyManager.delegate = self;

    NSString *combo = self.hotkeyOverride.length ? self.hotkeyOverride : self.config.hotkey;
    combo = [combo stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!combo.length) {
        DSHLogInfo(@"全局快捷键: 未设置");
        return;
    }
    if (self.hotkeyOverride.length) {
        DSHLogInfo(@"--hotkey 覆盖本次运行: %@", combo);
    }
    NSString *parseError = nil;
    DSHHotkeyDefinition *definition = [DSHHotkeyDefinition parse:combo error:&parseError];
    if (!definition) {
        DSHLogWarn(@"全局快捷键配置非法，未注册: %@ (%@)", combo, parseError);
        return;
    }
    NSString *registerError = nil;
    if ([self.hotkeyManager registerDefinition:definition error:&registerError]) {
        DSHLogInfo(@"全局快捷键已注册: %@", definition.comboString);
    } else {
        DSHLogWarn(@"全局快捷键注册失败: %@ - %@", definition.comboString, registerError);
    }
}

- (void)startAgent {
    NSString *nodePath = DSHFindNodeExecutable();
    NSString *scriptPath = DSHFindAgentScript();
    if (!nodePath) {
        DSHLogWarn(@"未找到 node，状态引擎无法启动（可设置 DSH_TRAY_NODE 环境变量）");
    }
    if (!scriptPath) {
        DSHLogWarn(@"未找到 src/status-agent.mjs，状态引擎无法启动");
    }
    DSHAgentSupervisor *agent = [[DSHAgentSupervisor alloc] initWithNodePath:nodePath
                                                                  scriptPath:scriptPath
                                                                  statusPath:self.statusPath
                                                                     logPath:self.agentLogPath
                                                                  intervalMs:self.config.pollMs
                                                                     workDir:self.dataDir
                                                              accountEnabled:self.config.showBalance
                                                                  consoleURL:self.config.consoleURL];
    self.agent = agent;
    if (agent.canRun) {
        [agent start];
        DSHLogInfo(@"状态引擎参数: %@", agent.lastArguments);
    } else {
        DSHLogInfo(@"状态引擎不可用: %@", agent.diagnostic);
    }
}

- (void)setupTestNotify {
    DSHLogInfo(@"--test-notify 启动: %@", self.testNotifyKind);
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, DSHTestNotifyDelayMs * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        [weakSelf triggerTestNotification:weakSelf.testNotifyKind];
    });
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, DSHTestExitDelayMs * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}

- (void)triggerTestNotification:(NSString *)kind {
    long long now = DSHNowMs();
    DSHStatusSnapshot *fake = [[DSHStatusSnapshot alloc] init];
    fake.generatedAt = now;
    fake.state = @"approval";
    fake.stateLabel = @"需要审批";
    fake.tooltip = @"需要审批 · pwsh · DSH状态托盘监控工具";
    fake.menuStatus = @"状态：需要审批 — DSH状态托盘监控工具";

    if ([kind.lowercaseString isEqualToString:@"completion"]) {
        fake.state = @"idle";
        fake.stateLabel = @"空闲";
        DSHCompletionAlert *completion = [[DSHCompletionAlert alloc] init];
        completion.key = [NSString stringWithFormat:@"test:completion:%lld", now];
        completion.at = now;
        completion.sessionId = @"session-test";
        completion.title = @"DSH状态托盘监控工具";
        completion.main = YES;
        fake.completion = completion;
    } else {
        DSHAttentionAlert *attention = [[DSHAttentionAlert alloc] init];
        attention.key = [NSString stringWithFormat:@"test:attention:%lld", now];
        attention.kind = @"approval";
        attention.at = now;
        attention.toolName = @"pwsh";
        attention.sessionId = @"session-test";
        attention.title = @"DSH状态托盘监控工具";
        attention.main = YES;
        attention.pendingCount = 1;
        fake.attention = attention;
    }
    DSHLogInfo(@"--test-notify 触发: %@", kind);
    [self processAlertNotifications:fake stale:NO];
}

#pragma mark - 定时轮询

- (void)onTimerTick:(NSTimer *)timer {
    if (self.shuttingDown) {
        return;
    }
    @try {
        [self tickOnce];
    } @catch (NSException *exception) {
        DSHLogError(@"托盘定时刷新失败: %@", exception.reason);
    }
}

- (void)tickOnce {
    long long now = DSHNowMs();
    DSHStatusSnapshot *snapshot = nil;
    @try {
        snapshot = [self readStatusSnapshot];
    } @catch (NSException *exception) {
        [self logStatusError:[NSString stringWithFormat:@"读取 status.json 失败: %@", exception.reason]];
    }
    if (snapshot) {
        self.lastSnapshot = snapshot;
    }

    BOOL stale = YES;
    if (self.lastSnapshot) {
        stale = (now - self.lastSnapshot.generatedAt) > DSHStaleAfterMs;
    }
    self.lastTickStale = stale;

    [self applyStatus:stale];
    [self superviseAgent:stale];
    [self processAlertNotifications:self.lastSnapshot stale:stale];
}

- (DSHStatusSnapshot *)readStatusSnapshot {
    if (!self.statusPath.length) {
        return nil;
    }
    NSData *data = [NSData dataWithContentsOfFile:self.statusPath];
    if (!data.length) {
        return nil;
    }
    NSError *error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (!DSHIsDictionary(parsed)) {
        // 原子写入期间理论上读不到半文件；保持上一次状态。
        [self logStatusError:[NSString stringWithFormat:@"status.json 不是合法 JSON: %@", error.localizedDescription]];
        return nil;
    }
    DSHStatusSnapshot *snapshot = [DSHStatusSnapshot fromDictionary:parsed];
    if (snapshot.generatedAt <= 0) {
        NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:self.statusPath error:NULL];
        NSDate *modified = attributes[NSFileModificationDate];
        if (modified) {
            snapshot.generatedAt = (long long)llround(modified.timeIntervalSince1970 * 1000.0);
        }
    }
    return snapshot;
}

- (void)logStatusError:(NSString *)message {
    long long now = DSHMonotonicMs();
    if (self.lastStatusErrorMs > 0 && now - self.lastStatusErrorMs < DSHStatusErrorLogEveryMs) {
        return;
    }
    self.lastStatusErrorMs = now;
    DSHLogError(@"%@", message);
}

- (void)superviseAgent:(BOOL)stale {
    if (self.noAgent || !self.agent) {
        return;
    }
    @try {
        [self.agent ensureRunningWithStaleHeartbeat:stale];
    } @catch (NSException *exception) {
        DSHLogError(@"守护状态引擎失败: %@", exception.reason);
    }
}

#pragma mark - UI 更新

- (NSString *)tooltipFallbackForSnapshot:(DSHStatusSnapshot *)snapshot {
    NSString *label = snapshot.stateLabel.length ? snapshot.stateLabel : snapshot.state;
    if (snapshot.sessionTitle.length) {
        return [NSString stringWithFormat:@"状态：%@ · %@", label, snapshot.sessionTitle];
    }
    return [NSString stringWithFormat:@"状态：%@", label];
}

- (void)applyStatus:(BOOL)stale {
    if (stale) {
        [self setIconColor:[self.config colorForState:@"offline"]];
        [self applyTooltip:@"状态监视器未响应"];
        return;
    }
    DSHStatusSnapshot *snapshot = self.lastSnapshot;
    [self setIconColor:[self.config colorForState:snapshot.state]];
    NSString *tooltip = snapshot.tooltip.length ? snapshot.tooltip : [self tooltipFallbackForSnapshot:snapshot];
    [self applyTooltip:tooltip];
}

- (void)setIconColor:(NSColor *)color {
    NSString *hex = DSHHexFromColor(color);
    if (self.statusItem.button.image && [hex isEqualToString:self.lastIconKey]) {
        return;
    }
    NSImage *image = [DSHIconPainter dotImageWithColor:color pointSize:18.0];
    if (!image) {
        return;
    }
    self.statusItem.button.image = image;
    self.lastIconKey = hex;
    DSHLogInfo(@"托盘图标颜色: %@", hex);
}

- (void)applyTooltip:(NSString *)raw {
    NSString *text = DSHNormalizeTooltip(raw);
    if (!text.length) {
        text = @"DSH 状态托盘";
    }
    if ([text isEqualToString:self.lastTooltip]) {
        return;
    }
    self.lastTooltip = text;
    self.statusItem.button.toolTip = text;
    NSString *logText = [text stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
    DSHLogInfo(@"托盘提示: %@", logText);
}

#pragma mark - 通知

- (void)processAlertNotifications:(DSHStatusSnapshot *)snapshot stale:(BOOL)stale {
    if (stale || !snapshot) {
        return;
    }
    BOOL testMode = self.testNotifyKind.length > 0;
    BOOL notifyCompletion = self.config.notifyCompletion || testMode;
    BOOL notifyApproval = self.config.notifyApproval || testMode;
    BOOL notified = NO;

    DSHCompletionAlert *completion = snapshot.completion;
    if (notifyCompletion && completion && completion.key.length
        && completion.at >= self.trayStartedAtMs
        && ![self.seenCompletionKeys containsObject:completion.key]) {
        [self rememberSeenKey:completion.key in:self.seenCompletionKeys];
        [self notifyCompletion:completion];
        notified = YES;
    }

    DSHAttentionAlert *attention = snapshot.attention;
    if (notifyApproval && [snapshot.state isEqualToString:@"approval"] && attention && attention.key.length
        && ![self.seenAttentionKeys containsObject:attention.key]) {
        [self rememberSeenKey:attention.key in:self.seenAttentionKeys];
        [self notifyAttention:attention];
        notified = YES;
    }

    if (notified) {
        [self playAlertSound];
    }
}

- (void)rememberSeenKey:(NSString *)key in:(NSMutableArray<NSString *> *)keys {
    [keys addObject:key];
    while ((NSInteger)keys.count > DSHSeenKeyCapacity) {
        [keys removeObjectAtIndex:0];
    }
}

- (void)notifyCompletion:(DSHCompletionAlert *)alert {
    NSString *text = DSHBuildCompletionText(alert.title);
    [self showNotificationTitle:@"任务完成" body:text identifier:alert.key];
    DSHLogInfo(@"通知(完成): %@", text);
}

- (void)notifyAttention:(DSHAttentionAlert *)alert {
    if ([alert.kind.lowercaseString isEqualToString:@"question"]) {
        NSString *text = DSHBuildQuestionText(alert.pendingCount, alert.title);
        [self showNotificationTitle:@"需要你回答" body:text identifier:alert.key];
        DSHLogInfo(@"通知(问题): %@", text);
    } else {
        NSString *text = DSHBuildApprovalText(alert.toolName, alert.title);
        [self showNotificationTitle:@"需要审批" body:text identifier:alert.key];
        DSHLogInfo(@"通知(审批): %@", text);
    }
}

- (void)showNotificationTitle:(NSString *)title body:(NSString *)body identifier:(NSString *)identifier {
    if (self.notificationsAllowed) {
        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = title;
        content.body = body;
        // 提示音由 playAlertSound 统一播放，避免与通知自带声音重叠。
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                             content:content
                                                                             trigger:nil];
        [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
                                                               withCompletionHandler:^(NSError *error) {
            if (error) {
                DSHLogWarn(@"通知投递失败: %@", error.localizedDescription);
            }
        }];
        return;
    }
    [self showNotificationViaOsascriptTitle:title body:body];
}

- (void)showNotificationViaOsascriptTitle:(NSString *)title body:(NSString *)body {
    NSString *escapedBody = [body stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
    escapedBody = [escapedBody stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    NSString *escapedTitle = [title stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
    escapedTitle = [escapedTitle stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    NSString *script = [NSString stringWithFormat:@"display notification \"%@\" with title \"%@\"",
                                                  escapedBody, escapedTitle];
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/osascript"];
    task.arguments = @[ @"-e", script ];
    @try {
        [task launch];
        DSHLogInfo(@"回退 osascript 通知: %@", body);
    } @catch (NSException *exception) {
        DSHLogError(@"osascript 通知失败: %@", exception.reason);
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList);
}

#pragma mark - 提示音

- (NSString *)resolveSoundPath:(NSString *)configured {
    NSString *value = [configured stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!value.length) {
        return @"";
    }
    if ([value isAbsolutePath]) {
        return value;
    }
    NSString *base = [NSBundle mainBundle].executablePath.stringByDeletingLastPathComponent;
    if (!base.length) {
        base = NSHomeDirectory();
    }
    return [base stringByAppendingPathComponent:value];
}

- (void)playAlertSound {
    if (!self.config.playSound && !self.testNotifyKind.length) {
        return;
    }
    long long now = DSHMonotonicMs();
    if (self.lastSoundMs > 0 && now - self.lastSoundMs < DSHNotificationSoundMinIntervalMs) {
        return;
    }
    self.lastSoundMs = now;

    NSString *path = [self resolveSoundPath:self.config.soundFile];
    if (path.length) {
        self.soundPlayer = [[NSSound alloc] initWithContentsOfFile:path byReference:YES];
        if (self.soundPlayer) {
            DSHLogInfo(@"播放提示音: %@", path);
            [self.soundPlayer play];
            return;
        }
        DSHLogError(@"播放提示音失败，回退系统提示音: %@", path);
    }
    DSHLogInfo(@"播放系统提示音");
    NSBeep();
}

#pragma mark - 菜单

- (NSMenuItem *)menuItemWithTitle:(NSString *)title action:(SEL)action {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:@""];
    item.target = self;
    item.enabled = YES;
    return item;
}

- (NSArray<NSString *> *)describeMenuForSnapshot:(DSHStatusSnapshot *)snapshot stale:(BOOL)stale {
    self.lastSnapshot = snapshot;
    self.lastTickStale = stale;
    NSMenu *menu = [self buildMenu];
    NSMutableArray<NSString *> *items = [NSMutableArray array];
    for (NSMenuItem *item in menu.itemArray) {
        [items addObject:item.isSeparatorItem ? @"---" : (item.title ?: @"")];
    }
    return items;
}

- (NSMenu *)buildMenu {
    NSMenu *menu = [[NSMenu alloc] initWithTitle:DSHAppDisplayName];
    menu.autoenablesItems = NO;

    DSHStatusSnapshot *snapshot = self.lastSnapshot;
    NSString *statusText = snapshot.menuStatus.length ? snapshot.menuStatus : @"状态：启动中";
    if (self.lastTickStale) {
        statusText = @"状态：状态监视器未响应";
    }
    NSMenuItem *header = [[NSMenuItem alloc] initWithTitle:statusText action:nil keyEquivalent:@""];
    header.attributedTitle = DSHMenuTitle(statusText, 13.0, [NSColor labelColor], YES);
    [menu addItem:header];

    NSString *detailText = self.lastTickStale
        ? @"请检查 tray.log / agent.log，并确认 node 可用"
        : (snapshot.menuDetail.length ? snapshot.menuDetail : @"");
    if (detailText.length) {
        NSMenuItem *detail = [[NSMenuItem alloc] initWithTitle:detailText action:nil keyEquivalent:@""];
        detail.attributedTitle = DSHMenuTitle(detailText, 11.0, [NSColor secondaryLabelColor], NO);
        [menu addItem:detail];
    }

    [menu addItem:[NSMenuItem separatorItem]];

    [menu addItem:[self menuItemWithTitle:@"打开控制台" action:@selector(onOpenConsole:)]];
    [menu addItem:[self menuItemWithTitle:@"打开网页版 DeepSeek" action:@selector(onOpenWebChat:)]];
    [menu addItem:[self menuItemWithTitle:@"查看 DS 服务器状态" action:@selector(onOpenStatusPage:)]];

    if (self.config.showBalance) {
        NSString *balanceTitle = DSHBalanceMenuText(snapshot.account);
        NSMenuItem *balance = [self menuItemWithTitle:balanceTitle action:@selector(onOpenBalance:)];
        balance.toolTip = DSHBalanceTooltip(snapshot.account);
        [menu addItem:balance];
    }

    [menu addItem:[NSMenuItem separatorItem]];

    NSString *hotkeyTitle = @"设置全局快捷键…";
    if (self.config.hotkey.length) {
        DSHHotkeyDefinition *definition = [DSHHotkeyDefinition parse:self.config.hotkey error:NULL];
        if (definition) {
            hotkeyTitle = [NSString stringWithFormat:@"设置全局快捷键…（%@）", definition.displayString];
        }
    }
    [menu addItem:[self menuItemWithTitle:hotkeyTitle action:@selector(onHotkeySettings:)]];

    [menu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *quit = [self menuItemWithTitle:@"退出" action:@selector(onQuit:)];
    quit.keyEquivalent = @"q";
    [menu addItem:quit];

    return menu;
}

- (void)showMenu {
    NSMenu *menu = [self buildMenu];
    NSStatusBarButton *button = self.statusItem.button;
    if (!button) {
        return;
    }
    // 状态栏按钮是 flipped 坐标系：y=0 是按钮顶部，+height 才是菜单栏下沿。
    [menu popUpMenuPositioningItem:nil
                        atLocation:NSMakePoint(0, NSHeight(button.bounds) + 2.0)
                            inView:button];
}

#pragma mark - 交互

- (void)statusItemClicked:(id)sender {
    @try {
        NSEvent *event = [NSApp currentEvent];
        BOOL rightClick = event.type == NSEventTypeRightMouseUp;
        BOOL controlClick = event.type == NSEventTypeLeftMouseUp
            && (event.modifierFlags & NSEventModifierFlagControl) != 0;
        if (rightClick || controlClick) {
            [self showMenu];
            return;
        }
        if (self.config.openConsoleOnLeftClick) {
            long long now = DSHMonotonicMs();
            if (self.lastLeftClickMs > 0 && now - self.lastLeftClickMs < DSHLeftClickDebounceMs) {
                DSHLogInfo(@"托盘左键重复点击已忽略（去抖 < %lldms）", DSHLeftClickDebounceMs);
                return;
            }
            self.lastLeftClickMs = now;
            DSHLogInfo(@"托盘左键单击: 打开控制台");
            [self openConsole];
            return;
        }
        [self showMenu];
    } @catch (NSException *exception) {
        DSHLogError(@"处理托盘图标点击失败: %@", exception.reason);
    }
}

- (void)openConsole {
    NSString *url = self.config.consoleURL;
    if (DSHOpenURLString(url)) {
        DSHLogInfo(@"打开控制台: %@", url);
    } else {
        DSHLogError(@"打开控制台失败: %@", url);
    }
}

- (void)onOpenConsole:(id)sender {
    [self openConsole];
}

- (void)onOpenWebChat:(id)sender {
    NSString *url = self.config.webChatURL;
    if (DSHOpenURLString(url)) {
        DSHLogInfo(@"打开网页版 DeepSeek: %@", url);
    } else {
        DSHLogError(@"打开网页版 DeepSeek 失败: %@", url);
    }
}

- (void)onOpenStatusPage:(id)sender {
    NSString *url = self.config.statusURL;
    if (DSHOpenURLString(url)) {
        DSHLogInfo(@"打开 DS 服务器状态: %@", url);
    } else {
        DSHLogError(@"打开 DS 服务器状态失败: %@", url);
    }
}

- (void)onOpenBalance:(id)sender {
    @try {
        NSString *url = self.config.topUpURL;
        if (!url.length && self.lastSnapshot.account.topUpURL.length) {
            url = self.lastSnapshot.account.topUpURL;
        }
        if (!url.length) {
            url = DSHDefaultTopUpURL;
        }
        if (DSHOpenURLString(url)) {
            DSHLogInfo(@"打开充值页: %@", url);
        } else {
            DSHLogError(@"打开充值页失败: %@", url);
        }
    } @catch (NSException *exception) {
        DSHLogError(@"打开充值页失败: %@", exception.reason);
    }
}

- (void)onHotkeySettings:(id)sender {
    [self openHotkeySettings];
}

- (void)openHotkeySettings {
    @try {
        // 必须复用托盘自己的热键管理器：设置窗口打开时会暂停旧热键，
        // 保存后用新组合重新注册，这样无需重启托盘即可生效。
        self.hotkeySettingsWindow = [[DSHHotkeySettingsWindow alloc] initWithConfig:self.config
                                                                             manager:self.hotkeyManager
                                                                             dataDir:self.dataDir];
        [self.hotkeySettingsWindow runModal];
        self.hotkeySettingsWindow = nil;
    } @catch (NSException *exception) {
        DSHLogError(@"打开全局快捷键设置窗口失败: %@", exception.reason);
    }
}

+ (void)openHotkeySettingsWithConfig:(DSHConfig *)config dataDir:(NSString *)dataDir {
    DSHHotkeyManager *manager = [[DSHHotkeyManager alloc] init];
    DSHHotkeySettingsWindow *window = [[DSHHotkeySettingsWindow alloc] initWithConfig:config
                                                                             manager:manager
                                                                             dataDir:dataDir];
    [window runModal];
    DSHLogInfo(@"--open-hotkey-settings 设置窗口已关闭");
}

- (void)onQuit:(id)sender {
    if (self.shuttingDown) {
        return;
    }
    DSHLogInfo(@"用户点击退出");
    [NSApp terminate:nil];
}

#pragma mark - 全局快捷键回调

- (void)hotkeyManagerDidTrigger:(id)manager {
    @try {
        DSHLogInfo(@"全局快捷键触发: %@ -> %@", self.hotkeyManager.currentCombo, self.config.consoleURL);
        [self openConsole];
    } @catch (NSException *exception) {
        DSHLogError(@"全局快捷键触发失败: %@", exception.reason);
    }
}

#pragma mark - 收尾

- (void)shutdown {
    if (self.shuttingDown) {
        return;
    }
    self.shuttingDown = YES;

    @try {
        [self.timer invalidate];
        self.timer = nil;
    } @catch (NSException *exception) {
        DSHLogError(@"停止轮询 Timer 失败: %@", exception.reason);
    }

    @try {
        [self.agent stop];
        self.agent = nil;
    } @catch (NSException *exception) {
        DSHLogError(@"停止状态引擎失败: %@", exception.reason);
    }

    @try {
        [self.hotkeyManager unregister];
        self.hotkeyManager.delegate = nil;
        self.hotkeyManager = nil;
        DSHLogInfo(@"全局快捷键已注销");
    } @catch (NSException *exception) {
        DSHLogError(@"注销全局快捷键失败: %@", exception.reason);
    }

    @try {
        if (self.statusItem) {
            [[NSStatusBar systemStatusBar] removeStatusItem:self.statusItem];
            self.statusItem = nil;
        }
    } @catch (NSException *exception) {
        DSHLogError(@"移除菜单栏图标失败: %@", exception.reason);
    }

    DSHLogInfo(@"托盘已退出");
}

@end
