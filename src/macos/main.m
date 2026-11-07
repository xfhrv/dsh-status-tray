//
//  main.m — 程序入口：参数解析 / 单实例 / 调试与验收模式 / 托盘启动
//
//  与 Windows 版 Program.Main 对应：未知参数忽略（向前兼容），
//  --render-icons / --open-console / --open-balance / --open-web / --open-status /
//  --open-hotkey-settings / --test-notify 走不创建托盘的验收路径。
//

#import "DSHCommon.h"
#import <signal.h>
#import <sys/file.h>
#import <unistd.h>

#pragma mark - 单实例

static int DSHSingleInstanceFD = -1;

static BOOL DSHAcquireSingleInstance(void) {
    NSString *lockPath = [DSHDataDirectory() stringByAppendingPathComponent:@"tray.lock"];
    int fileDescriptor = open(lockPath.fileSystemRepresentation, O_CREAT | O_RDWR, 0644);
    if (fileDescriptor < 0) {
        // 无法创建锁文件时不阻止工具本身使用，只记录日志。
        DSHLogWarn(@"创建单实例锁失败（继续运行）: %@", lockPath);
        return YES;
    }
    if (flock(fileDescriptor, LOCK_EX | LOCK_NB) != 0) {
        close(fileDescriptor);
        return NO;
    }
    DSHSingleInstanceFD = fileDescriptor;
    return YES;
}

#pragma mark - 参数

static NSString *DSHTakeValue(NSArray<NSString *> *arguments, NSUInteger *index, NSString *inlineValue, BOOL *ok);

@implementation DSHOptions

+ (instancetype)parseArguments:(NSArray<NSString *> *)arguments {
    DSHOptions *options = [[DSHOptions alloc] init];
    NSUInteger index = 1; // 跳过 argv[0]
    while (index < arguments.count) {
        NSString *argument = arguments[index] ?: @"";
        NSString *key = argument;
        NSString *inlineValue = nil;
        NSRange equals = [argument rangeOfString:@"="];
        if ([argument hasPrefix:@"--"] && equals.location != NSNotFound && equals.location > 2) {
            key = [argument substringToIndex:equals.location];
            inlineValue = [argument substringFromIndex:equals.location + 1];
        }
        BOOL ok = YES;
        NSString *value = nil;

        if ([key isEqualToString:@"--status"]) {
            value = DSHTakeValue(arguments, &index, inlineValue, &ok);
            if (ok) {
                options.statusPath = value;
            }
        } else if ([key isEqualToString:@"--no-agent"]) {
            options.noAgent = YES;
        } else if ([key isEqualToString:@"--render-icons"]) {
            value = DSHTakeValue(arguments, &index, inlineValue, &ok);
            if (ok) {
                options.renderIconsDir = value;
            }
        } else if ([key isEqualToString:@"--render-app-icon"]) {
            value = DSHTakeValue(arguments, &index, inlineValue, &ok);
            if (ok) {
                options.renderAppIconPath = value;
            }
        } else if ([key isEqualToString:@"--open-console"]) {
            options.openConsole = YES;
        } else if ([key isEqualToString:@"--open-balance"]) {
            options.openBalance = YES;
        } else if ([key isEqualToString:@"--open-web"]) {
            options.openWeb = YES;
        } else if ([key isEqualToString:@"--open-status"]) {
            options.openStatus = YES;
        } else if ([key isEqualToString:@"--open-hotkey-settings"]) {
            options.openHotkeySettings = YES;
        } else if ([key isEqualToString:@"--show-menu"]) {
            options.showMenu = YES;
        } else if ([key isEqualToString:@"--print-menu"]) {
            options.printMenu = YES;
        } else if ([key isEqualToString:@"--hotkey"]) {
            value = DSHTakeValue(arguments, &index, inlineValue, &ok);
            if (ok) {
                options.hotkeyOverride = value;
            }
        } else if ([key isEqualToString:@"--test-notify"]) {
            value = DSHTakeValue(arguments, &index, inlineValue, &ok);
            if (ok) {
                NSString *kind = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].lowercaseString;
                if ([kind isEqualToString:@"completion"] || [kind isEqualToString:@"approval"]) {
                    options.testNotifyKind = kind;
                } else {
                    ok = NO;
                }
            }
        } else if ([key isEqualToString:@"-h"] || [key isEqualToString:@"--help"]) {
            options.help = YES;
        }
        // 未知参数忽略，保证向前兼容。

        if (!ok) {
            options.invalidArguments = YES;
            if (key.length) {
                DSHLogError(@"命令行参数错误: %@", key);
            }
        }
        index += 1;
    }
    return options;
}

static NSString *DSHTakeValue(NSArray<NSString *> *arguments, NSUInteger *index, NSString *inlineValue, BOOL *ok) {
    if (inlineValue != nil) {
        if (inlineValue.length == 0) {
            *ok = NO;
            return nil;
        }
        return inlineValue;
    }
    if (*index + 1 >= arguments.count) {
        *ok = NO;
        return nil;
    }
    *index += 1;
    NSString *value = arguments[*index];
    if (!value.length) {
        *ok = NO;
        return nil;
    }
    return value;
}

+ (NSString *)usageText {
    return @"DSH 状态托盘（macOS）\n"
           @"\n"
           @"用法:\n"
           @"  DSHStatusTray [--status <status.json>] [--no-agent] [--hotkey \"Ctrl+Alt+F9\"]\n"
           @"  DSHStatusTray --render-icons <dir>\n"
           @"  DSHStatusTray --render-app-icon <file.png>\n"
           @"  DSHStatusTray --open-console | --open-balance | --open-web | --open-status\n"
           @"  DSHStatusTray --open-hotkey-settings\n"
           @"  DSHStatusTray --test-notify completion|approval\n"
           @"  DSHStatusTray --print-menu [--status <path>]\n"
           @"  DSHStatusTray --show-menu [--status <path>]\n"
           @"  DSHStatusTray --help\n"
           @"\n"
           @"选项:\n"
           @"  --status <path>        读取指定的 status.json（配合 --no-agent 做静态演示）\n"
           @"  --no-agent             不启动 Node 状态引擎，只显示 status.json\n"
           @"  --render-icons <dir>   导出四色状态图标 PNG（验收用）\n"
           @"  --render-app-icon <p>  导出应用图标 PNG（构建 .icns 用）\n"
           @"  --hotkey <combo>       本次运行临时注册全局快捷键（不写配置）\n"
           @"  --print-menu           打印菜单结构后退出（验收用）\n"
           @"  --show-menu            启动托盘并自动弹出菜单，4 秒后退出（截图验收用）\n"
           @"\n"
           @"运行时目录: ~/Library/Application Support/DSHStatusTray\n";
}

@end

#pragma mark - 调试 / 验收模式

static DSHStatusSnapshot *DSHLoadSnapshotAtPath(NSString *path) {
    if (!path.length) {
        return nil;
    }
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data.length) {
        return nil;
    }
    NSError *error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (!DSHIsDictionary(parsed)) {
        DSHLogError(@"status.json 解析失败: %@", error.localizedDescription);
        return nil;
    }
    return [DSHStatusSnapshot fromDictionary:parsed];
}

static int DSHRunRenderIcons(NSString *directory) {
    @try {
        NSString *expanded = DSHExpandTilde(directory);
        [[NSFileManager defaultManager] createDirectoryAtPath:expanded
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:NULL];
        DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
        NSArray<NSString *> *states = @[ @"working", @"approval", @"idle", @"offline" ];
        for (NSString *state in states) {
            NSString *path = [expanded stringByAppendingPathComponent:[state stringByAppendingString:@".png"]];
            if (![DSHIconPainter writeDotPNGForColor:[config colorForState:state] toPath:path pixelSize:32]) {
                DSHLogError(@"--render-icons 写入失败: %@", path);
                return 1;
            }
        }
        DSHLogInfo(@"--render-icons 已导出 %lu 张状态图标到 %@", (unsigned long)states.count, expanded);
        printf("OK: %s\n", expanded.UTF8String);
        return 0;
    } @catch (NSException *exception) {
        DSHLogError(@"--render-icons 失败: %@", exception.reason);
        return 1;
    }
}

static int DSHRunRenderAppIcon(NSString *path) {
    NSString *expanded = DSHExpandTilde(path);
    NSString *directory = expanded.stringByDeletingLastPathComponent;
    if (directory.length) {
        [[NSFileManager defaultManager] createDirectoryAtPath:directory
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:NULL];
    }
    if (![DSHIconPainter writeAppIconPNGToPath:expanded pixelSize:1024]) {
        DSHLogError(@"--render-app-icon 写入失败: %@", expanded);
        return 1;
    }
    DSHLogInfo(@"--render-app-icon 已导出: %@", expanded);
    printf("OK: %s\n", expanded.UTF8String);
    return 0;
}

static int DSHRunOpenConsole(void) {
    DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
    BOOL opened = DSHOpenURLString(config.consoleURL);
    DSHLogInfo(@"--open-console %@: %@", opened ? @"成功" : @"失败", config.consoleURL);
    return opened ? 0 : 1;
}

static int DSHRunOpenWeb(void) {
    DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
    BOOL opened = DSHOpenURLString(config.webChatURL);
    DSHLogInfo(@"--open-web %@: %@", opened ? @"成功" : @"失败", config.webChatURL);
    return opened ? 0 : 1;
}

static int DSHRunOpenStatus(void) {
    DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
    BOOL opened = DSHOpenURLString(config.statusURL);
    DSHLogInfo(@"--open-status %@: %@", opened ? @"成功" : @"失败", config.statusURL);
    return opened ? 0 : 1;
}

static int DSHRunOpenBalance(DSHOptions *options) {
    DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
    NSString *statusPath = options.statusPath.length ? DSHExpandTilde(options.statusPath) : DSHDefaultStatusPath();
    DSHStatusSnapshot *snapshot = DSHLoadSnapshotAtPath(statusPath);
    NSString *url = config.topUpURL;
    if (!url.length && snapshot.account.topUpURL.length) {
        url = snapshot.account.topUpURL;
    }
    if (!url.length) {
        url = DSHDefaultTopUpURL;
    }
    BOOL opened = DSHOpenURLString(url);
    DSHLogInfo(@"--open-balance %@: %@", opened ? @"成功" : @"失败", url);
    return opened ? 0 : 1;
}

static int DSHRunPrintMenu(DSHOptions *options) {
    DSHConfig *config = [DSHConfig loadFromDirectory:DSHDataDirectory()];
    NSString *statusPath = options.statusPath.length ? DSHExpandTilde(options.statusPath) : DSHDefaultStatusPath();
    DSHStatusSnapshot *snapshot = DSHLoadSnapshotAtPath(statusPath);
    DSHTrayController *tray = [[DSHTrayController alloc] initWithConfig:config
                                                                dataDir:DSHDataDirectory()
                                                             statusPath:statusPath
                                                                options:options];
    NSArray<NSString *> *items = [tray describeMenuForSnapshot:snapshot stale:(snapshot == nil)];
    printf("%s\n", [items componentsJoinedByString:@" | "].UTF8String);
    return 0;
}

static int DSHRunOpenHotkeySettings(void) {
    @try {
        NSApplication *application = [NSApplication sharedApplication];
        [application setActivationPolicy:NSApplicationActivationPolicyAccessory];

        DSHConfig *config = [DSHConfig loadOrCreateInDirectory:DSHDataDirectory()];
        DSHHotkeyManager *manager = [[DSHHotkeyManager alloc] init];
        DSHHotkeySettingsWindow *window = [[DSHHotkeySettingsWindow alloc] initWithConfig:config
                                                                                 manager:manager
                                                                                 dataDir:DSHDataDirectory()];
        [window runModal];
        // 保持 manager / window 存活到模态结束。
        (void)manager;
        (void)window;
        return 0;
    } @catch (NSException *exception) {
        DSHLogError(@"--open-hotkey-settings 失败: %@", exception.reason);
        return 1;
    }
}

#pragma mark - 托盘启动

@interface DSHAppDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, strong) DSHOptions *options;
@property (nonatomic, strong, nullable) DSHTrayController *tray;
@end

@implementation DSHAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    DSHConfig *config = [DSHConfig loadOrCreateInDirectory:DSHDataDirectory()];
    NSString *statusPath = self.options.statusPath.length ? DSHExpandTilde(self.options.statusPath)
                                                          : DSHDefaultStatusPath();
    self.tray = [[DSHTrayController alloc] initWithConfig:config
                                                  dataDir:DSHDataDirectory()
                                               statusPath:statusPath
                                                  options:self.options];
    [self.tray start];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.tray shutdown];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return NO;
}

@end

static dispatch_source_t DSHMakeSignalSource(int signalNumber) {
    signal(signalNumber, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,
                                                      (uintptr_t)signalNumber,
                                                      0,
                                                      dispatch_get_main_queue());
    if (!source) {
        return nil;
    }
    dispatch_source_set_event_handler(source, ^{
        DSHLogInfo(@"收到信号 %d，准备退出", signalNumber);
        [NSApp terminate:nil];
    });
    dispatch_resume(source);
    return source;
}

static int DSHRunTray(DSHOptions *options, BOOL requireSingleInstance) {
    if (requireSingleInstance && !DSHAcquireSingleInstance()) {
        // 已有实例：静默退出（与 Windows 版互斥体行为一致）。
        return 0;
    }

    NSApplication *application = [NSApplication sharedApplication];
    [application setActivationPolicy:NSApplicationActivationPolicyAccessory];

    static dispatch_source_t sigtermSource = nil;
    static dispatch_source_t sigintSource = nil;
    if (!sigtermSource) {
        sigtermSource = DSHMakeSignalSource(SIGTERM);
        sigintSource = DSHMakeSignalSource(SIGINT);
        (void)sigintSource;
    }

    DSHAppDelegate *delegate = [[DSHAppDelegate alloc] init];
    delegate.options = options;
    application.delegate = delegate;
    [application run];
    return 0;
}

#pragma mark - main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        DSHLogInit([DSHDataDirectory() stringByAppendingPathComponent:@"tray.log"]);

        NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithCapacity:(NSUInteger)argc];
        for (int index = 0; index < argc; index += 1) {
            NSString *argument = argv[index] ? [NSString stringWithUTF8String:argv[index]] : @"";
            [arguments addObject:argument ?: @""];
        }

        DSHOptions *options = [DSHOptions parseArguments:arguments];
        DSHLogInfo(@"托盘进程启动 pid=%d version=%@ %@",
                   getpid(), DSHVersionString,
                   [NSProcessInfo processInfo].operatingSystemVersionString);

        if (options.help) {
            fputs([[DSHOptions usageText] UTF8String], stdout);
            return 0;
        }
        if (options.invalidArguments) {
            fputs([[DSHOptions usageText] UTF8String], stderr);
            return 2;
        }
        if (options.renderIconsDir.length) {
            return DSHRunRenderIcons(options.renderIconsDir);
        }
        if (options.renderAppIconPath.length) {
            return DSHRunRenderAppIcon(options.renderAppIconPath);
        }
        if (options.openConsole) {
            return DSHRunOpenConsole();
        }
        if (options.openBalance) {
            return DSHRunOpenBalance(options);
        }
        if (options.openWeb) {
            return DSHRunOpenWeb();
        }
        if (options.openStatus) {
            return DSHRunOpenStatus();
        }
        if (options.openHotkeySettings) {
            return DSHRunOpenHotkeySettings();
        }
        if (options.printMenu) {
            return DSHRunPrintMenu(options);
        }
        if (options.testNotifyKind.length || options.showMenu) {
            return DSHRunTray(options, NO);
        }
        return DSHRunTray(options, YES);
    }
}
