//
//  DSHAgent.m — Node 状态引擎子进程守护
//
//  与 Windows 版 AgentSupervisor 行为一致：父进程持有子进程，退出后按 ≥10s 退避重启；
//  心跳（status.json 的 generatedAt）超过 10s 未更新时也重启一次；子进程输出写入 agent.log。
//

#import "DSHCommon.h"

static const long long DSHRestartBackoffMs = 10000;

static void DSHAppendToFile(NSString *path, NSString *line) {
    if (!path.length || !line.length) {
        return;
    }
    @try {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        [fileManager createDirectoryAtPath:path.stringByDeletingLastPathComponent
               withIntermediateDirectories:YES
                                attributes:nil
                                     error:NULL];
        if (![fileManager fileExistsAtPath:path]) {
            [fileManager createFileAtPath:path contents:nil attributes:nil];
        }
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
        if (!handle) {
            return;
        }
        @try {
            [handle seekToEndOfFile];
            [handle writeData:[[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
        } @finally {
            [handle closeFile];
        }
    } @catch (NSException *exception) {
        // 日志失败不影响守护。
    }
}

@implementation DSHAgentSupervisor {
    NSString *_nodePath;
    NSString *_scriptPath;
    NSString *_statusPath;
    NSString *_logPath;
    NSString *_workDir;
    NSString *_consoleURL;
    NSInteger _intervalMs;
    BOOL _accountEnabled;

    NSTask *_task;
    NSFileHandle *_logHandle;
    long long _lastStartMs;
    BOOL _everStarted;
    NSString *_lastArguments;
    BOOL _stopping;
}

- (instancetype)initWithNodePath:(NSString *)nodePath
                      scriptPath:(NSString *)scriptPath
                      statusPath:(NSString *)statusPath
                         logPath:(NSString *)logPath
                      intervalMs:(NSInteger)intervalMs
                         workDir:(NSString *)workDir
                  accountEnabled:(BOOL)accountEnabled
                      consoleURL:(NSString *)consoleURL {
    self = [super init];
    if (self) {
        _nodePath = [nodePath copy];
        _scriptPath = [scriptPath copy];
        _statusPath = [statusPath copy];
        _logPath = [logPath copy];
        _workDir = [workDir copy];
        _consoleURL = [consoleURL copy];
        _intervalMs = MAX(250, intervalMs);
        _accountEnabled = accountEnabled;
        _lastStartMs = 0;
        _lastArguments = nil;
    }
    return self;
}

- (BOOL)canRun {
    return _nodePath.length > 0 && _scriptPath.length > 0;
}

- (NSString *)diagnostic {
    if (!_nodePath.length) {
        return @"未找到 node（请安装 Node.js，或设置 DSH_TRAY_NODE 环境变量指向 node 可执行文件）";
    }
    if (!_scriptPath.length) {
        return @"未找到 src/status-agent.mjs（应用包可能不完整）";
    }
    return nil;
}

- (NSString *)lastArguments {
    @synchronized(self) {
        return _lastArguments;
    }
}

- (BOOL)isRunning {
    @synchronized(self) {
        return _task != nil && _task.isRunning;
    }
}

- (void)start {
    @synchronized(self) {
        if (!self.canRun || _stopping) {
            return;
        }
        [self startLocked];
    }
}

- (void)ensureRunningWithStaleHeartbeat:(BOOL)stale {
    @synchronized(self) {
        if (_stopping || !self.canRun) {
            return;
        }
        long long now = DSHMonotonicMs();
        BOOL running = _task != nil && _task.isRunning;
        if (!running) {
            if (!_everStarted || now - _lastStartMs >= DSHRestartBackoffMs) {
                [self startLocked];
            }
        } else if (stale && now - _lastStartMs >= DSHRestartBackoffMs) {
            DSHLogWarn(@"状态引擎心跳过期，重启引擎");
            [self startLocked];
        }
    }
}

- (void)stop {
    @synchronized(self) {
        _stopping = YES;
        [self stopLocked];
    }
}

- (void)dealloc {
    [self stop];
}

#pragma mark - 内部

- (NSDictionary<NSString *, NSString *> *)childEnvironment {
    NSMutableDictionary<NSString *, NSString *> *environment = [[NSProcessInfo processInfo].environment mutableCopy];
    NSString *nodeDir = _nodePath.stringByDeletingLastPathComponent;
    NSString *path = environment[@"PATH"] ?: @"/usr/bin:/bin:/usr/sbin:/sbin";
    if (nodeDir.length && ![path containsString:nodeDir]) {
        environment[@"PATH"] = [NSString stringWithFormat:@"%@:%@", nodeDir, path];
    }
    return environment;
}

- (NSArray<NSString *> *)buildArguments {
    NSMutableArray<NSString *> *arguments = [NSMutableArray array];
    [arguments addObject:_scriptPath];
    [arguments addObjectsFromArray:@[ @"--out", _statusPath ]];
    [arguments addObjectsFromArray:@[ @"--interval", [NSString stringWithFormat:@"%ld", (long)_intervalMs] ]];
    [arguments addObjectsFromArray:@[ @"--log", _logPath ]];
    if (_consoleURL.length) {
        [arguments addObjectsFromArray:@[ @"--console-url", _consoleURL ]];
    }
    if (_accountEnabled) {
        [arguments addObject:@"--account"];
    }
    return arguments;
}

- (void)openLogHandleLocked {
    [self closeLogHandleLocked];
    @try {
        NSFileManager *fileManager = [NSFileManager defaultManager];
        [fileManager createDirectoryAtPath:_logPath.stringByDeletingLastPathComponent
               withIntermediateDirectories:YES
                                attributes:nil
                                     error:NULL];
        if (![fileManager fileExistsAtPath:_logPath]) {
            [fileManager createFileAtPath:_logPath contents:nil attributes:nil];
        }
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:_logPath];
        if (handle) {
            [handle seekToEndOfFile];
            _logHandle = handle;
        }
    } @catch (NSException *exception) {
        DSHLogWarn(@"打开 agent.log 失败: %@", exception.reason);
    }
}

- (void)closeLogHandleLocked {
    if (_logHandle) {
        @try {
            [_logHandle closeFile];
        } @catch (NSException *exception) {
            // 忽略
        }
        _logHandle = nil;
    }
}

- (void)startLocked {
    [self stopLocked];
    _stopping = NO;
    _everStarted = YES;
    _lastStartMs = DSHMonotonicMs();

    if (!self.canRun) {
        return;
    }

    NSArray<NSString *> *arguments = [self buildArguments];
    _lastArguments = [arguments componentsJoinedByString:@" "];

    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:_nodePath];
    task.arguments = arguments;
    if (_workDir.length) {
        task.currentDirectoryURL = [NSURL fileURLWithPath:_workDir];
    }
    task.environment = [self childEnvironment];

    [self openLogHandleLocked];
    if (_logHandle) {
        task.standardOutput = _logHandle;
        task.standardError = _logHandle;
    }

    __weak typeof(self) weakSelf = self;
    task.terminationHandler = ^(NSTask *finished) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf handleTermination:finished];
        });
    };

    @try {
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss";
        DSHAppendToFile(_logPath, [NSString stringWithFormat:@"# --- %@ 启动状态引擎: %@ ---",
                                                          [formatter stringFromDate:[NSDate date]],
                                                          arguments.firstObject ?: @""]);
        [task launch];
        _task = task;
        DSHLogInfo(@"状态引擎已启动 pid=%d: %@", task.processIdentifier, _scriptPath);
    } @catch (NSException *exception) {
        _task = nil;
        [self closeLogHandleLocked];
        DSHLogError(@"启动状态引擎失败: %@", exception.reason);
    }
}

- (void)stopLocked {
    NSTask *task = _task;
    _task = nil;
    if (task) {
        @try {
            if (task.isRunning) {
                [task terminate];
            }
        } @catch (NSException *exception) {
            DSHLogWarn(@"终止状态引擎失败: %@", exception.reason);
        }
        // 不在这里 waitUntilExit：退出流程不能被挂起的 node 阻塞；引擎自身处理 SIGTERM。
    }
    [self closeLogHandleLocked];
}

- (void)handleTermination:(NSTask *)finished {
    @synchronized(self) {
        if (finished != _task) {
            return;
        }
        _task = nil;
        [self closeLogHandleLocked];
        DSHLogWarn(@"状态引擎已退出 (status=%d)，将在 ≥10s 后按需重启", finished.terminationStatus);
    }
}

@end
