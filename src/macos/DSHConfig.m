//
//  DSHConfig.m — 路径 / 日志 / JSON 工具 / 文本工具 / config.json / status.json 模型
//

#import "DSHCommon.h"
#import <time.h>

NSString *const DSHAppDisplayName = @"DSH 状态托盘";
NSString *const DSHBundleIdentifier = @"com.dsh.statustray";
NSString *const DSHVersionString = @"1.2.0";

NSString *const DSHDefaultConsoleURL = @"http://127.0.0.1:3080";
NSString *const DSHDefaultTopUpURL = @"https://platform.deepseek.com/top_up";
NSString *const DSHDefaultWebChatURL = @"https://chat.deepseek.com/";
NSString *const DSHDefaultStatusURL = @"https://status.deepseek.com/";

const long long DSHStaleAfterMs = 10000;
static const NSUInteger DSHMaxTooltipLength = 60;
static NSString *const DSHConfigFileName = @"config.json";

#pragma mark - 路径

NSString *DSHDataDirectory(void) {
    static NSString *directory = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSURL *appSupport = [fileManager URLForDirectory:NSApplicationSupportDirectory
                                               inDomain:NSUserDomainMask
                                      appropriateForURL:nil
                                                 create:YES
                                                  error:NULL];
        NSString *base = appSupport.path ?: [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support"];
        directory = [base stringByAppendingPathComponent:@"DSHStatusTray"];
        [fileManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
    });
    return directory;
}

NSString *DSHDefaultStatusPath(void) {
    return [DSHDataDirectory() stringByAppendingPathComponent:@"status.json"];
}

NSString *DSHDefaultAgentLogPath(void) {
    return [DSHDataDirectory() stringByAppendingPathComponent:@"agent.log"];
}

NSString *DSHExpandTilde(NSString *path) {
    if (!path.length) {
        return @"";
    }
    if ([path isEqualToString:@"~"]) {
        return NSHomeDirectory();
    }
    if ([path hasPrefix:@"~/"]) {
        return [NSHomeDirectory() stringByAppendingPathComponent:[path substringFromIndex:2]];
    }
    return path;
}

static BOOL DSHIsExecutableFile(NSString *path) {
    if (!path.length) {
        return NO;
    }
    return [[NSFileManager defaultManager] isExecutableFileAtPath:DSHExpandTilde(path)];
}

NSString *DSHFindAgentScript(void) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSDictionary *environment = [NSProcessInfo processInfo].environment;

    NSString *override = environment[@"DSH_TRAY_AGENT"];
    if (override.length) {
        NSString *expanded = DSHExpandTilde(override);
        if ([fileManager fileExistsAtPath:expanded]) {
            return expanded;
        }
    }

    // 打包后：Contents/Resources/agent/status-agent.mjs
    NSString *resourcePath = [NSBundle mainBundle].resourcePath;
    if (resourcePath.length) {
        NSString *candidate = [resourcePath stringByAppendingPathComponent:@"agent/status-agent.mjs"];
        if ([fileManager fileExistsAtPath:candidate]) {
            return candidate;
        }
    }

    // 开发运行：bin/DSHStatusTray.app/Contents/MacOS/DSHStatusTray → 上溯 4 层到仓库根
    NSString *executablePath = [NSBundle mainBundle].executablePath;
    NSString *executableDir = executablePath.stringByDeletingLastPathComponent;
    if (executableDir.length) {
        NSString *root = executableDir;
        for (NSInteger i = 0; i < 4; i += 1) {
            root = [root stringByDeletingLastPathComponent];
        }
        NSString *candidate = [root stringByAppendingPathComponent:@"src/status-agent.mjs"];
        if ([fileManager fileExistsAtPath:candidate]) {
            return candidate;
        }
        candidate = [executableDir stringByAppendingPathComponent:@"status-agent.mjs"];
        if ([fileManager fileExistsAtPath:candidate]) {
            return candidate;
        }
    }
    return nil;
}

/// 最后兜底：问一次登录 shell（launchd 启动时 PATH 往往不含 nvm / Homebrew）。
static NSString *DSHFindNodeViaLoginShell(void) {
    NSDictionary *environment = [NSProcessInfo processInfo].environment;
    NSString *shell = environment[@"SHELL"];
    if (!DSHIsExecutableFile(shell)) {
        shell = @"/bin/zsh";
    }
    if (!DSHIsExecutableFile(shell)) {
        shell = @"/bin/sh";
    }
    if (!DSHIsExecutableFile(shell)) {
        return nil;
    }

    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:shell];
    task.arguments = @[ @"-lc", @"command -v node" ];
    NSPipe *pipe = [NSPipe pipe];
    NSPipe *errorPipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = errorPipe;

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    task.terminationHandler = ^(NSTask *finished) {
        dispatch_semaphore_signal(semaphore);
    };
    @try {
        [task launch];
    } @catch (NSException *exception) {
        return nil;
    }
    dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)));
    if (task.isRunning) {
        @try {
            [task terminate];
        } @catch (NSException *exception) {
            // 忽略
        }
        return nil;
    }
    NSData *data = [pipe.fileHandleForReading readDataToEndOfFile];
    NSString *output = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    NSCharacterSet *trimSet = [NSCharacterSet whitespaceAndNewlineCharacterSet];
    for (NSString *line in [output componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]]) {
        NSString *candidate = [line stringByTrimmingCharactersInSet:trimSet];
        if (DSHIsExecutableFile(candidate)) {
            return DSHExpandTilde(candidate);
        }
    }
    return nil;
}

NSString *DSHFindNodeExecutable(void) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSDictionary *environment = [NSProcessInfo processInfo].environment;

    NSString *override = environment[@"DSH_TRAY_NODE"];
    if (override.length) {
        NSString *expanded = DSHExpandTilde(override);
        if (DSHIsExecutableFile(expanded)) {
            return expanded;
        }
    }

    NSString *pathEnv = environment[@"PATH"] ?: @"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    for (NSString *component in [pathEnv componentsSeparatedByString:@":"]) {
        NSString *directory = [component stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (!directory.length) {
            continue;
        }
        NSString *candidate = [directory stringByAppendingPathComponent:@"node"];
        if (DSHIsExecutableFile(candidate)) {
            return candidate;
        }
    }

    NSArray<NSString *> *fixedCandidates = @[
        @"/opt/homebrew/bin/node",
        @"/usr/local/bin/node",
        @"/usr/bin/node",
        @"/opt/local/bin/node",
        @"~/.volta/bin/node",
        @"~/.fnm/aliases/default/bin/node",
        @"~/.asdf/shims/node",
        @"~/.local/bin/node",
    ];
    for (NSString *candidate in fixedCandidates) {
        NSString *expanded = DSHExpandTilde(candidate);
        if (DSHIsExecutableFile(expanded)) {
            return expanded;
        }
    }

    // nvm：~/.nvm/versions/node/<version>/bin/node，取版本号最大者
    NSString *nvmRoot = [NSHomeDirectory() stringByAppendingPathComponent:@".nvm/versions/node"];
    NSArray<NSString *> *versions = [fileManager contentsOfDirectoryAtPath:nvmRoot error:NULL];
    if (versions.count > 0) {
        NSArray<NSString *> *sorted = [versions sortedArrayUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
            return [b compare:a options:NSNumericSearch];
        }];
        for (NSString *version in sorted) {
            NSString *candidate = [[nvmRoot stringByAppendingPathComponent:version] stringByAppendingPathComponent:@"bin/node"];
            if (DSHIsExecutableFile(candidate)) {
                return candidate;
            }
        }
    }

    return DSHFindNodeViaLoginShell();
}

BOOL DSHIsWebURL(NSString *url) {
    if (!url.length) {
        return NO;
    }
    NSString *trimmed = [url stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    NSURL *parsed = [NSURL URLWithString:trimmed];
    if (!parsed || !parsed.scheme) {
        return NO;
    }
    NSString *scheme = parsed.scheme.lowercaseString;
    return [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
}

BOOL DSHOpenURLString(NSString *url) {
    if (!DSHIsWebURL(url)) {
        DSHLogWarn(@"拒绝打开非法 URL: %@", url ?: @"(null)");
        return NO;
    }
    NSURL *parsed = [NSURL URLWithString:[url stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]];
    return [[NSWorkspace sharedWorkspace] openURL:parsed];
}

#pragma mark - 日志

static NSLock *DSHLogLock = nil;
static NSString *DSHLogPath = nil;

void DSHLogInit(NSString *path) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        DSHLogLock = [[NSLock alloc] init];
    });
    [DSHLogLock lock];
    DSHLogPath = [path copy];
    [DSHLogLock unlock];
}

static void DSHLogWrite(NSString *level, NSString *message) {
    [DSHLogLock lock];
    @try {
        if (!DSHLogPath.length) {
            return;
        }
        NSFileManager *fileManager = [NSFileManager defaultManager];
        NSString *directory = DSHLogPath.stringByDeletingLastPathComponent;
        [fileManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];

        NSDictionary *attributes = [fileManager attributesOfItemAtPath:DSHLogPath error:NULL];
        if (attributes && [attributes[NSFileSize] unsignedLongLongValue] > 1024 * 1024) {
            [fileManager removeItemAtPath:DSHLogPath error:NULL];
        }
        if (![fileManager fileExistsAtPath:DSHLogPath]) {
            [fileManager createFileAtPath:DSHLogPath contents:nil attributes:nil];
        }

        static NSDateFormatter *formatter = nil;
        static dispatch_once_t onceToken;
        dispatch_once(&onceToken, ^{
            formatter = [[NSDateFormatter alloc] init];
            formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
            formatter.dateFormat = @"yyyy-MM-dd HH:mm:ss.SSS";
        });
        NSString *timestamp = [formatter stringFromDate:[NSDate date]];
        NSString *line = [NSString stringWithFormat:@"%@ [%@] %@\n", timestamp, level, message ?: @""];
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:DSHLogPath];
        if (handle) {
            @try {
                [handle seekToEndOfFile];
                [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
            } @finally {
                [handle closeFile];
            }
        }
    } @catch (NSException *exception) {
        // 日志失败绝不影响主流程。
    } @finally {
        [DSHLogLock unlock];
    }
}

static void DSHLogV(NSString *level, NSString *format, va_list arguments) {
    NSString *message = [[NSString alloc] initWithFormat:format arguments:arguments];
    DSHLogWrite(level, message);
}

void DSHLogInfo(NSString *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    DSHLogV(@"INFO", format, arguments);
    va_end(arguments);
}

void DSHLogWarn(NSString *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    DSHLogV(@"WARN", format, arguments);
    va_end(arguments);
}

void DSHLogError(NSString *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    DSHLogV(@"ERROR", format, arguments);
    va_end(arguments);
}

#pragma mark - JSON 工具

BOOL DSHIsDictionary(id value) {
    return [value isKindOfClass:[NSDictionary class]];
}

BOOL DSHIsArray(id value) {
    return [value isKindOfClass:[NSArray class]];
}

NSString *DSHStringValue(NSDictionary *dict, NSString *key) {
    if (!DSHIsDictionary(dict)) {
        return nil;
    }
    id value = dict[key];
    if ([value isKindOfClass:[NSString class]]) {
        return value;
    }
    return nil;
}

BOOL DSHBoolValue(NSDictionary *dict, NSString *key, BOOL fallback) {
    if (!DSHIsDictionary(dict)) {
        return fallback;
    }
    id value = dict[key];
    if ([value isKindOfClass:[NSNumber class]]) {
        return [(NSNumber *)value boolValue];
    }
    return fallback;
}

long long DSHLongLongValue(NSDictionary *dict, NSString *key, long long fallback) {
    if (!DSHIsDictionary(dict)) {
        return fallback;
    }
    id value = dict[key];
    if ([value isKindOfClass:[NSNumber class]]) {
        return [(NSNumber *)value longLongValue];
    }
    if ([value isKindOfClass:[NSString class]]) {
        return [(NSString *)value longLongValue];
    }
    return fallback;
}

NSInteger DSHIntegerValue(NSDictionary *dict, NSString *key, NSInteger fallback) {
    return (NSInteger)DSHLongLongValue(dict, key, (long long)fallback);
}

NSDictionary *DSHDictionaryValue(NSDictionary *dict, NSString *key) {
    if (!DSHIsDictionary(dict)) {
        return nil;
    }
    id value = dict[key];
    return DSHIsDictionary(value) ? value : nil;
}

NSArray *DSHArrayValue(NSDictionary *dict, NSString *key) {
    if (!DSHIsDictionary(dict)) {
        return nil;
    }
    id value = dict[key];
    return DSHIsArray(value) ? value : nil;
}

#pragma mark - 时间 / 文本 / 颜色

long long DSHNowMs(void) {
    return (long long)llround([[NSDate date] timeIntervalSince1970] * 1000.0);
}

long long DSHMonotonicMs(void) {
    struct timespec timeSpec;
    if (clock_gettime(CLOCK_MONOTONIC, &timeSpec) != 0) {
        return DSHNowMs();
    }
    return (long long)timeSpec.tv_sec * 1000LL + (long long)(timeSpec.tv_nsec / 1000000);
}

NSString *DSHFormatLocalTime(long long epochMs, NSString *format) {
    if (epochMs <= 0 || !format.length) {
        return @"";
    }
    static NSDateFormatter *formatter = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.timeZone = [NSTimeZone localTimeZone];
    });
    formatter.dateFormat = format;
    NSDate *date = [NSDate dateWithTimeIntervalSince1970:(NSTimeInterval)epochMs / 1000.0];
    return [formatter stringFromDate:date] ?: @"";
}

NSString *DSHSanitizeSingleLine(NSString *text) {
    if (!text.length) {
        return @"";
    }
    NSMutableString *single = [text mutableCopy];
    for (NSString *token in @[ @"\r\n", @"\r", @"\n", @"\t" ]) {
        [single replaceOccurrencesOfString:token withString:@" " options:0 range:NSMakeRange(0, single.length)];
    }
    // 压缩连续空白（含全角空格之外的常见空白）
    NSMutableString *collapsed = [NSMutableString string];
    __block BOOL pendingSpace = NO;
    NSString *current = [single copy];
    [current enumerateSubstringsInRange:NSMakeRange(0, current.length)
                                options:NSStringEnumerationByComposedCharacterSequences
                             usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange, BOOL *stop) {
        if ([substring rangeOfCharacterFromSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].location != NSNotFound) {
            if (collapsed.length > 0) {
                pendingSpace = YES;
            }
            return;
        }
        if (pendingSpace) {
            [collapsed appendString:@" "];
            pendingSpace = NO;
        }
        [collapsed appendString:substring];
    }];
    return [collapsed copy];
}

static NSString *DSHCollapseTooltipLine(NSString *value) {
    if (!value.length) {
        return @"";
    }
    NSMutableString *collapsed = [NSMutableString string];
    __block BOOL pendingSpace = NO;
    [value enumerateSubstringsInRange:NSMakeRange(0, value.length)
                              options:NSStringEnumerationByComposedCharacterSequences
                           usingBlock:^(NSString *substring, NSRange substringRange, NSRange enclosingRange, BOOL *stop) {
        if ([substring rangeOfCharacterFromSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].location != NSNotFound) {
            if (collapsed.length > 0) {
                pendingSpace = YES;
            }
            return;
        }
        if (pendingSpace) {
            [collapsed appendString:@" "];
            pendingSpace = NO;
        }
        [collapsed appendString:substring];
    }];
    return [collapsed copy];
}

/// 安全前缀（不切断代理对）。
static NSString *DSHSafePrefix(NSString *value, NSUInteger maxLength) {
    if (!value.length || maxLength == 0) {
        return @"";
    }
    if (value.length <= maxLength) {
        return value;
    }
    NSRange range = NSMakeRange(0, maxLength);
    NSString *prefix = [value substringWithRange:range];
    if (prefix.length > 0 && CFStringIsSurrogateHighCharacter([prefix characterAtIndex:prefix.length - 1])) {
        prefix = [prefix substringToIndex:prefix.length - 1];
    }
    return prefix;
}

NSString *DSHTruncateText(NSString *text, NSUInteger maxLength) {
    if (!text.length || maxLength == 0) {
        return @"";
    }
    if (text.length <= maxLength) {
        return text;
    }
    NSString *prefix = DSHSafePrefix(text, maxLength - 1);
    return [[prefix stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] stringByAppendingString:@"…"];
}

NSString *DSHNormalizeTooltip(NSString *raw) {
    if (!raw.length) {
        return @"";
    }
    NSString *unified = [raw stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"];
    unified = [unified stringByReplacingOccurrencesOfString:@"\r" withString:@"\n"];

    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (NSString *rawLine in [unified componentsSeparatedByString:@"\n"]) {
        NSString *line = DSHCollapseTooltipLine(rawLine);
        if (line.length > 0) {
            [lines addObject:line];
        }
    }
    if (lines.count == 0) {
        return @"";
    }

    NSString *joined = [lines componentsJoinedByString:@"\n"];
    if (joined.length <= DSHMaxTooltipLength) {
        return joined;
    }

    // 超预算：保留前面整行 + 截断最后一行；仍放不下就丢弃后面的整行。
    for (NSInteger keep = (NSInteger)lines.count; keep >= 1; keep -= 1) {
        NSArray<NSString *> *prefix = [lines subarrayWithRange:NSMakeRange(0, (NSUInteger)(keep - 1))];
        NSString *prefixText = [prefix componentsJoinedByString:@"\n"];
        NSInteger prefixCost = prefixText.length > 0 ? (NSInteger)prefixText.length + 1 : 0;
        NSInteger budget = (NSInteger)DSHMaxTooltipLength - prefixCost - 1;
        if (budget < 1) {
            continue;
        }
        NSString *last = lines[(NSUInteger)(keep - 1)];
        if ((NSInteger)last.length > budget) {
            NSMutableArray<NSString *> *out = [prefix mutableCopy];
            [out addObject:[DSHSafePrefix(last, (NSUInteger)budget) stringByAppendingString:@"…"]];
            return [out componentsJoinedByString:@"\n"];
        }
    }

    NSString *first = lines.firstObject ?: @"";
    return [DSHSafePrefix(first, DSHMaxTooltipLength - 1) stringByAppendingString:@"…"];
}

NSString *DSHFormatMoney(NSString *rawBalance, NSString *currency) {
    NSString *raw = [rawBalance stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!raw.length) {
        return nil;
    }
    NSDecimalNumber *number = [NSDecimalNumber decimalNumberWithString:raw locale:@{ NSLocaleDecimalSeparator : @"." }];
    if (!number || [number isEqualToNumber:[NSDecimalNumber notANumber]]) {
        return nil;
    }
    static NSNumberFormatter *formatter = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSNumberFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.numberStyle = NSNumberFormatterDecimalStyle;
        formatter.usesGroupingSeparator = NO;
        formatter.minimumFractionDigits = 2;
        formatter.maximumFractionDigits = 2;
        formatter.roundingMode = NSNumberFormatterRoundHalfUp;
    });
    NSString *amount = [formatter stringFromNumber:number];
    if (!amount) {
        return nil;
    }
    NSString *currencyToken = [currency stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] ?: @"";
    NSString *symbol = @"";
    if ([currencyToken caseInsensitiveCompare:@"CNY"] == NSOrderedSame) {
        symbol = @"¥";
    } else if ([currencyToken caseInsensitiveCompare:@"USD"] == NSOrderedSame) {
        symbol = @"$";
    } else if (currencyToken.length > 0) {
        symbol = [currencyToken stringByAppendingString:@" "];
    }
    return [symbol stringByAppendingString:amount];
}

NSColor *DSHColorFromHex(NSString *hex) {
    if (!hex.length) {
        return nil;
    }
    NSString *text = [hex stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if ([text hasPrefix:@"#"]) {
        text = [text substringFromIndex:1];
    }
    if (text.length == 3) {
        unichar r = [text characterAtIndex:0];
        unichar g = [text characterAtIndex:1];
        unichar b = [text characterAtIndex:2];
        text = [NSString stringWithFormat:@"%C%C%C%C%C%C", r, r, g, g, b, b];
    }
    if (text.length != 6) {
        return nil;
    }
    unsigned int value = 0;
    NSScanner *scanner = [NSScanner scannerWithString:text];
    if (![scanner scanHexInt:&value]) {
        return nil;
    }
    CGFloat red = (CGFloat)((value >> 16) & 0xFF) / 255.0;
    CGFloat green = (CGFloat)((value >> 8) & 0xFF) / 255.0;
    CGFloat blue = (CGFloat)(value & 0xFF) / 255.0;
    return [NSColor colorWithSRGBRed:red green:green blue:blue alpha:1.0];
}

NSString *DSHHexFromColor(NSColor *color) {
    NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]];
    if (!rgb) {
        rgb = color;
    }
    CGFloat red = 0, green = 0, blue = 0, alpha = 0;
    @try {
        [rgb getRed:&red green:&green blue:&blue alpha:&alpha];
    } @catch (NSException *exception) {
        return @"#9AA0A6";
    }
    NSInteger r = (NSInteger)llround(MAX(0.0, MIN(1.0, red)) * 255.0);
    NSInteger g = (NSInteger)llround(MAX(0.0, MIN(1.0, green)) * 255.0);
    NSInteger b = (NSInteger)llround(MAX(0.0, MIN(1.0, blue)) * 255.0);
    return [NSString stringWithFormat:@"#%02lX%02lX%02lX", (long)r, (long)g, (long)b];
}

NSColor *DSHDarkenColor(NSColor *color, CGFloat factor) {
    NSColor *rgb = [color colorUsingColorSpace:[NSColorSpace sRGBColorSpace]] ?: color;
    CGFloat red = 0, green = 0, blue = 0, alpha = 1;
    @try {
        [rgb getRed:&red green:&green blue:&blue alpha:&alpha];
    } @catch (NSException *exception) {
        return color;
    }
    return [NSColor colorWithSRGBRed:MAX(0.0, MIN(1.0, red * factor))
                               green:MAX(0.0, MIN(1.0, green * factor))
                                blue:MAX(0.0, MIN(1.0, blue * factor))
                               alpha:alpha];
}

#pragma mark - DSHConfig

@interface DSHConfig ()
- (void)applyDictionary:(NSDictionary *)root;
@end

@implementation DSHConfig

static NSArray<NSString *> *DSHStateNames(void) {
    return @[ @"working", @"approval", @"idle", @"offline" ];
}

static NSArray<NSString *> *DSHDefaultColorHexes(void) {
    return @[ @"#F2B705", @"#E5484D", @"#2FA84F", @"#9AA0A6" ];
}

static NSArray<NSString *> *DSHRequiredConfigKeys(void) {
    return @[ @"notifyCompletion", @"notifyApproval", @"playSound", @"soundFile",
              @"showBalance", @"topUpUrl", @"webChatUrl", @"statusUrl", @"hotkey" ];
}

+ (instancetype)defaults {
    DSHConfig *config = [[DSHConfig alloc] init];
    config.consoleURL = DSHDefaultConsoleURL;
    config.pollMs = 500;
    NSMutableDictionary<NSString *, NSColor *> *colors = [NSMutableDictionary dictionary];
    NSArray<NSString *> *names = DSHStateNames();
    NSArray<NSString *> *hexes = DSHDefaultColorHexes();
    for (NSUInteger index = 0; index < names.count; index += 1) {
        NSColor *color = DSHColorFromHex(hexes[index]);
        if (color) {
            colors[names[index]] = color;
        }
    }
    config.stateColors = colors;
    config.notifyCompletion = YES;
    config.notifyApproval = YES;
    config.playSound = YES;
    config.soundFile = @"";
    config.showBalance = YES;
    config.topUpURL = DSHDefaultTopUpURL;
    config.webChatURL = DSHDefaultWebChatURL;
    config.statusURL = DSHDefaultStatusURL;
    config.hotkey = @"";
    config.openConsoleOnLeftClick = NO;
    return config;
}

static BOOL DSHHasLegacyColors(NSDictionary *root) {
    NSDictionary *colors = DSHDictionaryValue(root, @"colors");
    for (NSString *key in colors) {
        if ([key.lowercaseString isEqualToString:@"restricted"] || [key.lowercaseString isEqualToString:@"darkgray"]) {
            return YES;
        }
    }
    return NO;
}

- (NSColor *)colorForState:(NSString *)state {
    if (state.length) {
        NSColor *color = self.stateColors[state.lowercaseString];
        if (color) {
            return color;
        }
    }
    return DSHColorFromHex(@"#9AA0A6") ?: [NSColor grayColor];
}

- (void)setStateColor:(NSColor *)color forState:(NSString *)state {
    if (!state.length || !color) {
        return;
    }
    NSMutableDictionary *colors = [self.stateColors mutableCopy] ?: [NSMutableDictionary dictionary];
    colors[state.lowercaseString] = color;
    self.stateColors = colors;
}

- (void)applyDictionary:(NSDictionary *)root {
    NSString *consoleURL = DSHStringValue(root, @"consoleUrl");
    if (consoleURL.length) {
        self.consoleURL = [consoleURL stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }

    NSInteger pollMs = DSHIntegerValue(root, @"pollMs", self.pollMs);
    self.pollMs = MAX(250, MIN(10000, pollMs));

    NSDictionary *colors = DSHDictionaryValue(root, @"colors");
    if (colors) {
        NSMutableDictionary<NSString *, NSColor *> *parsed = [NSMutableDictionary dictionary];
        for (NSString *rawKey in colors) {
            NSString *state = [rawKey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].lowercaseString;
            NSString *hex = DSHStringValue(colors, rawKey);
            if (!state.length || !hex.length) {
                continue;
            }
            NSColor *color = DSHColorFromHex(hex);
            if (color) {
                parsed[state] = color;
            }
        }

        if (parsed[@"restricted"] || parsed[@"darkgray"]) {
            // v5 迁移：新 idle = 旧 restricted；新 offline = 旧 idle；旧 darkgray / 旧 offline 丢弃。
            NSColor *working = parsed[@"working"] ?: DSHColorFromHex(DSHDefaultColorHexes()[0]);
            NSColor *approval = parsed[@"approval"] ?: DSHColorFromHex(DSHDefaultColorHexes()[1]);
            NSColor *idle = parsed[@"restricted"] ?: DSHColorFromHex(DSHDefaultColorHexes()[2]);
            NSColor *offline = parsed[@"idle"] ?: DSHColorFromHex(DSHDefaultColorHexes()[3]);
            self.stateColors = @{ @"working" : working, @"approval" : approval, @"idle" : idle, @"offline" : offline };
        } else if (parsed.count > 0) {
            NSMutableDictionary *merged = [self.stateColors mutableCopy];
            [merged addEntriesFromDictionary:parsed];
            self.stateColors = merged;
        }
    }

    self.notifyCompletion = DSHBoolValue(root, @"notifyCompletion", YES);
    self.notifyApproval = DSHBoolValue(root, @"notifyApproval", YES);
    self.playSound = DSHBoolValue(root, @"playSound", YES);

    NSString *soundFile = DSHStringValue(root, @"soundFile");
    if (soundFile.length) {
        self.soundFile = [soundFile stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }

    self.showBalance = DSHBoolValue(root, @"showBalance", YES);

    if ([root.allKeys containsObject:@"topUpUrl"]) {
        NSString *topUpURL = DSHStringValue(root, @"topUpUrl");
        if (topUpURL) {
            // 显式空字符串 = 交给 status.json 的 account.topUpUrl / 内置默认值。
            self.topUpURL = [topUpURL stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        }
    }

    NSString *webChatURL = DSHStringValue(root, @"webChatUrl");
    if (webChatURL.length) {
        self.webChatURL = [webChatURL stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }
    NSString *statusURL = DSHStringValue(root, @"statusUrl");
    if (statusURL.length) {
        self.statusURL = [statusURL stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    }

    NSString *hotkey = DSHStringValue(root, @"hotkey");
    self.hotkey = [hotkey stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] ?: @"";

    self.openConsoleOnLeftClick = DSHBoolValue(root, @"openConsoleOnLeftClick", NO);
}

- (NSDictionary *)dictionaryRepresentation {
    NSMutableDictionary *root = [NSMutableDictionary dictionary];
    root[@"consoleUrl"] = self.consoleURL ?: DSHDefaultConsoleURL;
    root[@"pollMs"] = @(self.pollMs);
    NSMutableDictionary *colors = [NSMutableDictionary dictionary];
    for (NSString *state in DSHStateNames()) {
        colors[state] = DSHHexFromColor([self colorForState:state]);
    }
    root[@"colors"] = colors;
    root[@"notifyCompletion"] = @(self.notifyCompletion);
    root[@"notifyApproval"] = @(self.notifyApproval);
    root[@"playSound"] = @(self.playSound);
    root[@"soundFile"] = self.soundFile ?: @"";
    root[@"showBalance"] = @(self.showBalance);
    root[@"topUpUrl"] = self.topUpURL ?: @"";
    root[@"webChatUrl"] = self.webChatURL ?: DSHDefaultWebChatURL;
    root[@"statusUrl"] = self.statusURL ?: DSHDefaultStatusURL;
    root[@"hotkey"] = self.hotkey ?: @"";
    root[@"openConsoleOnLeftClick"] = @(self.openConsoleOnLeftClick);
    return root;
}

- (void)saveToDirectory:(NSString *)directory {
    @try {
        [[NSFileManager defaultManager] createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:NULL];
        NSString *path = [directory stringByAppendingPathComponent:DSHConfigFileName];
        NSData *data = [NSJSONSerialization dataWithJSONObject:[self dictionaryRepresentation]
                                                       options:(NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes)
                                                         error:NULL];
        if (!data) {
            DSHLogError(@"序列化 config.json 失败");
            return;
        }
        NSMutableData *withNewline = [data mutableCopy];
        [withNewline appendBytes:"\n" length:1];
        [withNewline writeToFile:path atomically:YES];
    } @catch (NSException *exception) {
        DSHLogError(@"写入 config.json 失败: %@", exception.reason);
    }
}

+ (instancetype)loadFromDirectory:(NSString *)directory {
    DSHConfig *config = [DSHConfig defaults];
    @try {
        NSString *path = [directory stringByAppendingPathComponent:DSHConfigFileName];
        NSData *data = [NSData dataWithContentsOfFile:path];
        if (!data.length) {
            return config;
        }
        NSError *error = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if (!DSHIsDictionary(parsed)) {
            DSHLogError(@"config.json 解析失败，使用内置默认值: %@", error.localizedDescription);
            return config;
        }
        [config applyDictionary:parsed];
    } @catch (NSException *exception) {
        DSHLogError(@"读取 config.json 失败，使用内置默认值: %@", exception.reason);
    }
    return config;
}

+ (instancetype)loadOrCreateInDirectory:(NSString *)directory {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *path = [directory stringByAppendingPathComponent:DSHConfigFileName];
    if (![fileManager fileExistsAtPath:path]) {
        DSHConfig *config = [DSHConfig defaults];
        [config saveToDirectory:directory];
        DSHLogInfo(@"已生成默认 config.json: %@", path);
        return config;
    }

    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data.length) {
        DSHConfig *config = [DSHConfig defaults];
        [config saveToDirectory:directory];
        return config;
    }

    NSError *error = nil;
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (!DSHIsDictionary(parsed)) {
        // 不覆盖用户损坏的文件。
        DSHLogError(@"config.json 解析失败，使用内置默认值（不覆盖原文件）: %@", error.localizedDescription);
        return [DSHConfig defaults];
    }

    DSHConfig *config = [DSHConfig defaults];
    [config applyDictionary:parsed];

    BOOL needWrite = DSHHasLegacyColors(parsed);
    if (!needWrite) {
        for (NSString *key in DSHRequiredConfigKeys()) {
            if (![[parsed allKeys] containsObject:key]) {
                needWrite = YES;
                break;
            }
        }
    }
    if (needWrite) {
        [config saveToDirectory:directory];
        DSHLogInfo(@"config.json 已补齐缺失的默认配置键 / 迁移旧颜色");
    }
    return config;
}

@end

#pragma mark - 状态模型

@interface DSHStatusSnapshot ()
+ (DSHCompletionAlert *)completionAlertFromDictionary:(NSDictionary *)value;
+ (DSHAttentionAlert *)attentionAlertFromDictionary:(NSDictionary *)value;
@end

@implementation DSHAccountInfo
@end

@implementation DSHCompletionAlert
@end

@implementation DSHAttentionAlert
@end

@implementation DSHStatusSnapshot

static NSString *DSHNormalizeToken(NSString *value) {
    if (!value.length) {
        return nil;
    }
    NSString *token = [value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].lowercaseString;
    return token.length ? token : nil;
}

static NSString *DSHStateFromToken(NSString *token) {
    if (!token) {
        return nil;
    }
    if ([token isEqualToString:@"approval"] || [token isEqualToString:@"working"]
        || [token isEqualToString:@"idle"] || [token isEqualToString:@"offline"]) {
        return token;
    }
    if ([token isEqualToString:@"restricted"]) {
        return @"idle";
    }
    if ([token isEqualToString:@"darkgray"]) {
        return @"offline";
    }
    return nil;
}

static NSString *DSHStateFromColorName(NSString *color) {
    NSString *token = DSHNormalizeToken(color);
    if (!token) {
        return nil;
    }
    if ([token isEqualToString:@"red"]) {
        return @"approval";
    }
    if ([token isEqualToString:@"yellow"]) {
        return @"working";
    }
    if ([token isEqualToString:@"green"]) {
        return @"idle";
    }
    if ([token isEqualToString:@"gray"] || [token isEqualToString:@"darkgray"]) {
        return @"offline";
    }
    if ([token isEqualToString:@"restricted"]) {
        return @"idle";
    }
    return nil;
}

static NSString *DSHColorNameFromState(NSString *state) {
    if ([state isEqualToString:@"approval"]) {
        return @"red";
    }
    if ([state isEqualToString:@"working"]) {
        return @"yellow";
    }
    if ([state isEqualToString:@"idle"]) {
        return @"green";
    }
    return @"gray";
}

static NSString *DSHLabelFromState(NSString *state) {
    if ([state isEqualToString:@"approval"]) {
        return @"需要审批";
    }
    if ([state isEqualToString:@"working"]) {
        return @"工作中";
    }
    if ([state isEqualToString:@"idle"]) {
        return @"空闲";
    }
    if ([state isEqualToString:@"offline"]) {
        return @"未运行";
    }
    return @"未知";
}

+ (instancetype)fromDictionary:(NSDictionary *)root {
    DSHStatusSnapshot *snapshot = [[DSHStatusSnapshot alloc] init];
    snapshot.generatedAt = DSHLongLongValue(root, @"generatedAt", 0);
    snapshot.tooltip = DSHStringValue(root, @"tooltip") ?: @"";
    snapshot.menuStatus = DSHStringValue(root, @"menuStatus") ?: @"";
    snapshot.menuDetail = DSHStringValue(root, @"menuDetail") ?: @"";
    snapshot.agentError = DSHStringValue(root, @"agentError");
    snapshot.colorName = DSHNormalizeToken(DSHStringValue(root, @"color")) ?: @"";

    NSString *state = DSHStateFromToken(DSHNormalizeToken(DSHStringValue(root, @"state")));
    if (!state) {
        state = DSHStateFromColorName(snapshot.colorName);
    }
    if (!state) {
        state = @"offline";
    }
    snapshot.state = state;

    if (!snapshot.colorName.length) {
        snapshot.colorName = DSHColorNameFromState(state);
    }
    snapshot.stateLabel = DSHStringValue(root, @"stateLabel") ?: @"";
    if (!snapshot.stateLabel.length) {
        snapshot.stateLabel = DSHLabelFromState(state);
    }

    NSDictionary *session = DSHDictionaryValue(root, @"activeSession");
    if (session) {
        snapshot.sessionTitle = DSHStringValue(session, @"title");
    }

    NSDictionary *alerts = DSHDictionaryValue(root, @"alerts");
    if (alerts) {
        snapshot.completion = [DSHStatusSnapshot completionAlertFromDictionary:DSHDictionaryValue(alerts, @"completion")];
        snapshot.attention = [DSHStatusSnapshot attentionAlertFromDictionary:DSHDictionaryValue(alerts, @"attention")];
    }

    NSDictionary *account = DSHDictionaryValue(root, @"account");
    if (account) {
        DSHAccountInfo *info = [[DSHAccountInfo alloc] init];
        info.status = DSHStringValue(account, @"status") ?: @"";
        info.balance = DSHStringValue(account, @"balance");
        info.currency = DSHStringValue(account, @"currency");
        info.bonusBalance = DSHStringValue(account, @"bonusBalance");
        info.error = DSHStringValue(account, @"error");
        info.topUpURL = DSHStringValue(account, @"topUpUrl");
        info.fetchedAt = DSHLongLongValue(account, @"fetchedAt", 0);
        snapshot.account = info;
    }
    return snapshot;
}

+ (DSHCompletionAlert *)completionAlertFromDictionary:(NSDictionary *)value {
    if (!value) {
        return nil;
    }
    NSString *key = DSHStringValue(value, @"key");
    if (!key.length) {
        return nil; // 无 key = 非法，不参与通知
    }
    DSHCompletionAlert *alert = [[DSHCompletionAlert alloc] init];
    alert.key = key;
    alert.at = DSHLongLongValue(value, @"at", 0);
    alert.sessionId = DSHStringValue(value, @"sessionId") ?: @"";
    alert.title = DSHStringValue(value, @"title") ?: @"";
    alert.main = DSHBoolValue(value, @"main", YES);
    return alert;
}

+ (DSHAttentionAlert *)attentionAlertFromDictionary:(NSDictionary *)value {
    if (!value) {
        return nil;
    }
    NSString *key = DSHStringValue(value, @"key");
    if (!key.length) {
        return nil;
    }
    DSHAttentionAlert *alert = [[DSHAttentionAlert alloc] init];
    alert.key = key;
    alert.kind = DSHStringValue(value, @"kind") ?: @"";
    alert.at = DSHLongLongValue(value, @"at", 0);
    alert.toolName = DSHStringValue(value, @"toolName");
    alert.sessionId = DSHStringValue(value, @"sessionId") ?: @"";
    alert.title = DSHStringValue(value, @"title") ?: @"";
    alert.main = DSHBoolValue(value, @"main", YES);
    alert.pendingCount = MAX(1, DSHIntegerValue(value, @"pendingCount", 1));
    return alert;
}

@end
