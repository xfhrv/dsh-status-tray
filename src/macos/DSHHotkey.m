//
//  DSHHotkey.m — 全局快捷键（Carbon RegisterEventHotKey）与「设置全局快捷键」窗口
//
//  配置格式与 Windows 版一致：Ctrl+Alt+Shift+Win+Key；在 macOS 上 Win 映射为 Command。
//  录制窗口也接受 Cmd 作为修饰键，保存时仍写成 Win，保证 config.json 跨平台可读。
//

#import "DSHCommon.h"
#import <Carbon/Carbon.h>

enum {
    DSHHotkeyModControl = 1u << 0,
    DSHHotkeyModAlt = 1u << 1,
    DSHHotkeyModShift = 1u << 2,
    DSHHotkeyModWin = 1u << 3, // macOS: Command
};

static const OSType DSHHotkeySignature = 'DSHT';

#pragma mark - 键名表

static NSDictionary<NSString *, NSNumber *> *DSHKeyCodesByName(void) {
    static NSDictionary<NSString *, NSNumber *> *map = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSMutableDictionary<NSString *, NSNumber *> *codes = [NSMutableDictionary dictionary];
        // A-Z
        NSArray<NSNumber *> *letterCodes = @[
            @(kVK_ANSI_A), @(kVK_ANSI_B), @(kVK_ANSI_C), @(kVK_ANSI_D), @(kVK_ANSI_E), @(kVK_ANSI_F),
            @(kVK_ANSI_G), @(kVK_ANSI_H), @(kVK_ANSI_I), @(kVK_ANSI_J), @(kVK_ANSI_K), @(kVK_ANSI_L),
            @(kVK_ANSI_M), @(kVK_ANSI_N), @(kVK_ANSI_O), @(kVK_ANSI_P), @(kVK_ANSI_Q), @(kVK_ANSI_R),
            @(kVK_ANSI_S), @(kVK_ANSI_T), @(kVK_ANSI_U), @(kVK_ANSI_V), @(kVK_ANSI_W), @(kVK_ANSI_X),
            @(kVK_ANSI_Y), @(kVK_ANSI_Z)
        ];
        for (NSUInteger index = 0; index < letterCodes.count; index += 1) {
            unichar letter = (unichar)('A' + index);
            codes[[NSString stringWithFormat:@"%C", letter]] = letterCodes[index];
        }
        // 0-9
        NSArray<NSNumber *> *digitCodes = @[
            @(kVK_ANSI_0), @(kVK_ANSI_1), @(kVK_ANSI_2), @(kVK_ANSI_3), @(kVK_ANSI_4),
            @(kVK_ANSI_5), @(kVK_ANSI_6), @(kVK_ANSI_7), @(kVK_ANSI_8), @(kVK_ANSI_9)
        ];
        for (NSUInteger index = 0; index < digitCodes.count; index += 1) {
            codes[[NSString stringWithFormat:@"%lu", (unsigned long)index]] = digitCodes[index];
        }
        // F1-F20（macOS 没有 F21-F24）
        NSArray<NSNumber *> *functionCodes = @[
            @(kVK_F1), @(kVK_F2), @(kVK_F3), @(kVK_F4), @(kVK_F5),
            @(kVK_F6), @(kVK_F7), @(kVK_F8), @(kVK_F9), @(kVK_F10),
            @(kVK_F11), @(kVK_F12), @(kVK_F13), @(kVK_F14), @(kVK_F15),
            @(kVK_F16), @(kVK_F17), @(kVK_F18), @(kVK_F19), @(kVK_F20),
        ];
        for (NSUInteger index = 0; index < functionCodes.count; index += 1) {
            codes[[NSString stringWithFormat:@"F%lu", (unsigned long)(index + 1)]] = functionCodes[index];
        }

        NSDictionary<NSString *, NSNumber *> *special = @{
            @"SPACE" : @(kVK_Space),
            @"UP" : @(kVK_UpArrow),
            @"DOWN" : @(kVK_DownArrow),
            @"LEFT" : @(kVK_LeftArrow),
            @"RIGHT" : @(kVK_RightArrow),
            @"HOME" : @(kVK_Home),
            @"END" : @(kVK_End),
            @"PAGEUP" : @(kVK_PageUp),
            @"PAGEDOWN" : @(kVK_PageDown),
            @"INSERT" : @(kVK_Help),
            @"DELETE" : @(kVK_ForwardDelete),
            @"RETURN" : @(kVK_Return),
            @"ENTER" : @(kVK_Return),
            @"ESCAPE" : @(kVK_Escape),
            @"TAB" : @(kVK_Tab),
            @"MINUS" : @(kVK_ANSI_Minus),
            @"EQUAL" : @(kVK_ANSI_Equal),
            @"LEFTBRACKET" : @(kVK_ANSI_LeftBracket),
            @"RIGHTBRACKET" : @(kVK_ANSI_RightBracket),
            @"BACKSLASH" : @(kVK_ANSI_Backslash),
            @"SEMICOLON" : @(kVK_ANSI_Semicolon),
            @"QUOTE" : @(kVK_ANSI_Quote),
            @"COMMA" : @(kVK_ANSI_Comma),
            @"PERIOD" : @(kVK_ANSI_Period),
            @"SLASH" : @(kVK_ANSI_Slash),
            @"BACKTICK" : @(kVK_ANSI_Grave),
        };
        [codes addEntriesFromDictionary:special];
        map = [codes copy];
    });
    return map;
}

/// 规范键名（A / F9 / PageUp / …），供 comboString 使用。
static NSString *DSHCanonicalKeyName(NSString *rawName) {
    if (!rawName.length) {
        return nil;
    }
    NSString *upper = [rawName stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]].uppercaseString;
    if (!upper.length) {
        return nil;
    }
    if (!DSHKeyCodesByName()[upper]) {
        return nil;
    }
    if (upper.length == 1) {
        return upper;
    }
    if ([upper hasPrefix:@"F"] && upper.length <= 3) {
        return upper;
    }
    NSDictionary<NSString *, NSString *> *canonical = @{
        @"SPACE" : @"Space",
        @"UP" : @"Up",
        @"DOWN" : @"Down",
        @"LEFT" : @"Left",
        @"RIGHT" : @"Right",
        @"HOME" : @"Home",
        @"END" : @"End",
        @"PAGEUP" : @"PageUp",
        @"PAGEDOWN" : @"PageDown",
        @"INSERT" : @"Insert",
        @"DELETE" : @"Delete",
        @"RETURN" : @"Return",
        @"ENTER" : @"Return",
        @"ESCAPE" : @"Escape",
        @"TAB" : @"Tab",
        @"MINUS" : @"Minus",
        @"EQUAL" : @"Equal",
        @"LEFTBRACKET" : @"LeftBracket",
        @"RIGHTBRACKET" : @"RightBracket",
        @"BACKSLASH" : @"Backslash",
        @"SEMICOLON" : @"Semicolon",
        @"QUOTE" : @"Quote",
        @"COMMA" : @"Comma",
        @"PERIOD" : @"Period",
        @"SLASH" : @"Slash",
        @"BACKTICK" : @"Backtick",
    };
    return canonical[upper] ?: upper;
}

static NSString *DSHKeyNameForKeyCode(unsigned short keyCode) {
    static NSMutableDictionary<NSNumber *, NSString *> *reverse = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        reverse = [NSMutableDictionary dictionary];
        // 规范名优先：后写入会覆盖同键码的别名（Enter → Return）。
        NSArray<NSString *> *preferredOrder = @[
            @"A", @"B", @"C", @"D", @"E", @"F", @"G", @"H", @"I", @"J", @"K", @"L", @"M",
            @"N", @"O", @"P", @"Q", @"R", @"S", @"T", @"U", @"V", @"W", @"X", @"Y", @"Z",
            @"0", @"1", @"2", @"3", @"4", @"5", @"6", @"7", @"8", @"9",
            @"F1", @"F2", @"F3", @"F4", @"F5", @"F6", @"F7", @"F8", @"F9", @"F10",
            @"F11", @"F12", @"F13", @"F14", @"F15", @"F16", @"F17", @"F18", @"F19", @"F20",
            @"Space", @"Up", @"Down", @"Left", @"Right", @"Home", @"End", @"PageUp", @"PageDown",
            @"Insert", @"Delete", @"Return", @"Escape", @"Tab",
            @"Minus", @"Equal", @"LeftBracket", @"RightBracket", @"Backslash", @"Semicolon",
            @"Quote", @"Comma", @"Period", @"Slash", @"Backtick",
        ];
        NSDictionary<NSString *, NSNumber *> *codes = DSHKeyCodesByName();
        for (NSString *name in preferredOrder) {
            NSNumber *code = codes[name.uppercaseString];
            if (code && !reverse[code]) {
                reverse[code] = name;
            }
        }
    });
    return reverse[@(keyCode)];
}

static NSString *DSHDisplayKeyName(NSString *keyName) {
    NSDictionary<NSString *, NSString *> *symbols = @{
        @"Up" : @"↑",
        @"Down" : @"↓",
        @"Left" : @"←",
        @"Right" : @"→",
        @"Return" : @"↩",
        @"Escape" : @"⎋",
        @"Tab" : @"⇥",
        @"Delete" : @"⌦",
        @"Space" : @"Space",
    };
    return symbols[keyName] ?: keyName;
}

#pragma mark - DSHHotkeyDefinition

@interface DSHHotkeyDefinition ()
@property (nonatomic, readwrite) UInt32 modifiers;
@property (nonatomic, readwrite) UInt32 keyCode;
@property (nonatomic, copy, readwrite) NSString *keyName;
@property (nonatomic, readonly) UInt32 carbonModifiers;
@end

@implementation DSHHotkeyDefinition

+ (UInt32)modifiersFromModifierFlags:(NSEventModifierFlags)flags {
    UInt32 modifiers = 0;
    if (flags & NSEventModifierFlagControl) {
        modifiers |= DSHHotkeyModControl;
    }
    if (flags & NSEventModifierFlagOption) {
        modifiers |= DSHHotkeyModAlt;
    }
    if (flags & NSEventModifierFlagShift) {
        modifiers |= DSHHotkeyModShift;
    }
    if (flags & NSEventModifierFlagCommand) {
        modifiers |= DSHHotkeyModWin;
    }
    return modifiers;
}

+ (NSString *)formatModifiers:(UInt32)modifiers {
    NSMutableString *text = [NSMutableString string];
    if (modifiers & DSHHotkeyModControl) {
        [text appendString:@"Ctrl+"];
    }
    if (modifiers & DSHHotkeyModAlt) {
        [text appendString:@"Alt+"];
    }
    if (modifiers & DSHHotkeyModShift) {
        [text appendString:@"Shift+"];
    }
    if (modifiers & DSHHotkeyModWin) {
        [text appendString:@"Win+"];
    }
    return text;
}

+ (NSString *)displayModifiers:(UInt32)modifiers {
    NSMutableString *text = [NSMutableString string];
    if (modifiers & DSHHotkeyModControl) {
        [text appendString:@"⌃"];
    }
    if (modifiers & DSHHotkeyModAlt) {
        [text appendString:@"⌥"];
    }
    if (modifiers & DSHHotkeyModShift) {
        [text appendString:@"⇧"];
    }
    if (modifiers & DSHHotkeyModWin) {
        [text appendString:@"⌘"];
    }
    return text;
}

+ (BOOL)isModifierKeyCode:(unsigned short)keyCode {
    switch (keyCode) {
        case kVK_Command:
        case kVK_RightCommand:
        case kVK_Shift:
        case kVK_RightShift:
        case kVK_Option:
        case kVK_RightOption:
        case kVK_Control:
        case kVK_RightControl:
        case kVK_CapsLock:
        case kVK_Function:
            return YES;
        default:
            return NO;
    }
}

+ (instancetype)parse:(NSString *)text error:(NSString * _Nullable * _Nullable)error {
    NSString *trimmed = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (!trimmed.length) {
        if (error) {
            *error = @"快捷键为空";
        }
        return nil;
    }
    NSArray<NSString *> *rawParts = [trimmed componentsSeparatedByString:@"+"];
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *rawPart in rawParts) {
        NSString *part = [rawPart stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (!part.length) {
            if (error) {
                *error = @"快捷键格式非法";
            }
            return nil;
        }
        [parts addObject:part];
    }
    if (parts.count < 2) {
        if (error) {
            *error = @"至少需要一个修饰键 + 一个普通键";
        }
        return nil;
    }

    UInt32 modifiers = 0;
    NSString *keyName = nil;
    for (NSUInteger index = 0; index < parts.count; index += 1) {
        NSString *token = parts[index].lowercaseString;
        if (index + 1 < parts.count) {
            if ([token isEqualToString:@"ctrl"] || [token isEqualToString:@"control"]) {
                modifiers |= DSHHotkeyModControl;
            } else if ([token isEqualToString:@"alt"] || [token isEqualToString:@"option"] || [token isEqualToString:@"opt"]) {
                modifiers |= DSHHotkeyModAlt;
            } else if ([token isEqualToString:@"shift"]) {
                modifiers |= DSHHotkeyModShift;
            } else if ([token isEqualToString:@"win"] || [token isEqualToString:@"windows"]
                       || [token isEqualToString:@"cmd"] || [token isEqualToString:@"command"]
                       || [token isEqualToString:@"meta"] || [token isEqualToString:@"super"]) {
                modifiers |= DSHHotkeyModWin;
            } else {
                if (error) {
                    *error = [NSString stringWithFormat:@"不支持的修饰键: %@", parts[index]];
                }
                return nil;
            }
        } else {
            NSString *upper = parts[index].uppercaseString;
            if (!DSHKeyCodesByName()[upper]) {
                if (error) {
                    *error = [NSString stringWithFormat:@"不支持的按键: %@", parts[index]];
                }
                return nil;
            }
            keyName = DSHCanonicalKeyName(parts[index]);
        }
    }
    if (modifiers == 0) {
        if (error) {
            *error = @"至少需要一个修饰键（Ctrl/Alt/Shift/Win）";
        }
        return nil;
    }

    DSHHotkeyDefinition *definition = [[DSHHotkeyDefinition alloc] init];
    definition.modifiers = modifiers;
    definition.keyName = keyName;
    definition.keyCode = (UInt32)DSHKeyCodesByName()[keyName.uppercaseString].unsignedIntValue;
    return definition;
}

+ (instancetype)definitionWithKeyCode:(unsigned short)keyCode
                        modifierFlags:(NSEventModifierFlags)flags
                                error:(NSString * _Nullable * _Nullable)error {
    NSString *keyName = DSHKeyNameForKeyCode(keyCode);
    if (!keyName) {
        if (error) {
            *error = @"不支持该键，请换一个（支持 A-Z / 0-9 / F1-F20 / Space / 方向键 / Home / End / PageUp / PageDown / Delete 等）";
        }
        return nil;
    }
    UInt32 modifiers = [self modifiersFromModifierFlags:flags];
    if (modifiers == 0) {
        if (error) {
            *error = @"请至少按住 Ctrl / Alt / Shift / Cmd 之一，再按普通键";
        }
        return nil;
    }
    DSHHotkeyDefinition *definition = [[DSHHotkeyDefinition alloc] init];
    definition.modifiers = modifiers;
    definition.keyName = keyName;
    definition.keyCode = keyCode;
    return definition;
}

- (NSString *)comboString {
    return [[[self class] formatModifiers:self.modifiers] stringByAppendingString:self.keyName ?: @""];
}

- (NSString *)displayString {
    return [[[self class] displayModifiers:self.modifiers] stringByAppendingString:DSHDisplayKeyName(self.keyName) ?: @""];
}

- (UInt32)carbonModifiers {
    UInt32 carbon = 0;
    if (self.modifiers & DSHHotkeyModControl) {
        carbon |= controlKey;
    }
    if (self.modifiers & DSHHotkeyModAlt) {
        carbon |= optionKey;
    }
    if (self.modifiers & DSHHotkeyModShift) {
        carbon |= shiftKey;
    }
    if (self.modifiers & DSHHotkeyModWin) {
        carbon |= cmdKey;
    }
    return carbon;
}

@end

#pragma mark - DSHHotkeyManager

@interface DSHHotkeyManager ()
- (void)handleHotkeyEvent;
@end

static OSStatus DSHHotkeyEventHandler(EventHandlerCallRef nextHandler, EventRef event, void *userData) {
    EventHotKeyID hotKeyID;
    OSStatus status = GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID,
                                        NULL, sizeof(hotKeyID), NULL, &hotKeyID);
    if (status == noErr && hotKeyID.signature == DSHHotkeySignature) {
        DSHHotkeyManager *manager = (__bridge DSHHotkeyManager *)userData;
        [manager handleHotkeyEvent];
    }
    return noErr;
}

@implementation DSHHotkeyManager {
    EventHotKeyRef _hotKeyRef;
    EventHandlerRef _handlerRef;
    DSHHotkeyDefinition *_current;
}

- (NSString *)currentCombo {
    return _current.comboString ?: @"";
}

- (BOOL)isRegistered {
    return _hotKeyRef != NULL;
}

- (BOOL)installHandlerIfNeeded {
    if (_handlerRef) {
        return YES;
    }
    EventTypeSpec typeSpec = { kEventClassKeyboard, kEventHotKeyPressed };
    OSStatus status = InstallEventHandler(GetApplicationEventTarget(), DSHHotkeyEventHandler, 1,
                                          &typeSpec, (__bridge void *)self, &_handlerRef);
    if (status != noErr) {
        DSHLogError(@"安装热键事件处理器失败: %d", (int)status);
        return NO;
    }
    return YES;
}

- (BOOL)registerDefinition:(DSHHotkeyDefinition *)definition error:(NSString * _Nullable * _Nullable)error {
    [self unregister];
    if (!definition) {
        return YES;
    }
    if (![self installHandlerIfNeeded]) {
        if (error) {
            *error = @"无法安装热键事件处理器";
        }
        return NO;
    }
    EventHotKeyID hotKeyID = { .signature = DSHHotkeySignature, .id = 1 };
    EventHotKeyRef reference = NULL;
    OSStatus status = RegisterEventHotKey(definition.keyCode, definition.carbonModifiers, hotKeyID,
                                          GetApplicationEventTarget(), 0, &reference);
    if (status != noErr) {
        if (error) {
            *error = @"注册失败：快捷键可能被其他程序占用";
        }
        DSHLogWarn(@"RegisterEventHotKey 失败: %@ (%d)", definition.comboString, (int)status);
        return NO;
    }
    _hotKeyRef = reference;
    _current = definition;
    return YES;
}

- (void)unregister {
    if (_hotKeyRef) {
        UnregisterEventHotKey(_hotKeyRef);
        _hotKeyRef = NULL;
    }
    _current = nil;
}

- (void)handleHotkeyEvent {
    id<DSHHotkeyManagerDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(hotkeyManagerDidTrigger:)]) {
        [delegate hotkeyManagerDidTrigger:self];
    }
}

- (void)dealloc {
    [self unregister];
    if (_handlerRef) {
        RemoveEventHandler(_handlerRef);
        _handlerRef = NULL;
    }
}

@end

#pragma mark - 录制视图

@protocol DSHHotkeyCaptureViewDelegate <NSObject>
- (void)captureView:(id)view didReceiveKeyEvent:(NSEvent *)event;
- (void)captureView:(id)view didChangeModifierFlags:(NSEventModifierFlags)flags;
@end

@interface DSHHotkeyCaptureView : NSView
@property (nonatomic, weak) id<DSHHotkeyCaptureViewDelegate> delegate;
@property (nonatomic, copy) NSString *displayText;
- (void)setDisplayText:(NSString *)displayText;
@end

@implementation DSHHotkeyCaptureView

- (instancetype)initWithFrame:(NSRect)frameRect {
    self = [super initWithFrame:frameRect];
    if (self) {
        _displayText = @"";
    }
    return self;
}

- (BOOL)acceptsFirstResponder {
    return YES;
}

- (BOOL)becomeFirstResponder {
    [self setNeedsDisplay:YES];
    return YES;
}

- (BOOL)resignFirstResponder {
    [self setNeedsDisplay:YES];
    return YES;
}

- (void)setDisplayText:(NSString *)displayText {
    _displayText = [displayText copy] ?: @"";
    [self setNeedsDisplay:YES];
}

- (void)drawRect:(NSRect)dirtyRect {
    NSRect rect = NSInsetRect(self.bounds, 1.5, 1.5);
    NSBezierPath *border = [NSBezierPath bezierPathWithRoundedRect:rect xRadius:7.0 yRadius:7.0];
    [[NSColor controlBackgroundColor] setFill];
    [border fill];
    BOOL focused = [self.window.firstResponder isEqual:self];
    NSColor *stroke = focused ? [NSColor controlAccentColor] : [NSColor separatorColor];
    [stroke setStroke];
    border.lineWidth = focused ? 2.0 : 1.0;
    [border stroke];

    NSString *text = self.displayText.length ? self.displayText : @"按下快捷键…";
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.alignment = NSTextAlignmentCenter;
    NSDictionary<NSAttributedStringKey, id> *attributes = @{
        NSFontAttributeName : [NSFont systemFontOfSize:15.0 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName : self.displayText.length ? [NSColor labelColor] : [NSColor secondaryLabelColor],
        NSParagraphStyleAttributeName : paragraph,
    };
    NSAttributedString *attributed = [[NSAttributedString alloc] initWithString:text attributes:attributes];
    NSSize size = attributed.size;
    [attributed drawAtPoint:NSMakePoint(NSMidX(self.bounds) - size.width / 2.0,
                                        NSMidY(self.bounds) - size.height / 2.0)];
}

- (void)keyDown:(NSEvent *)event {
    id<DSHHotkeyCaptureViewDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(captureView:didReceiveKeyEvent:)]) {
        [delegate captureView:self didReceiveKeyEvent:event];
    }
}

- (void)flagsChanged:(NSEvent *)event {
    id<DSHHotkeyCaptureViewDelegate> delegate = self.delegate;
    if ([delegate respondsToSelector:@selector(captureView:didChangeModifierFlags:)]) {
        [delegate captureView:self didChangeModifierFlags:event.modifierFlags];
    }
}

/// 防止录制 Cmd+Q / Cmd+W 等组合时被系统菜单吞掉。
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if (event.type == NSEventTypeKeyDown) {
        [self keyDown:event];
        return YES;
    }
    return NO;
}

- (void)mouseDown:(NSEvent *)event {
    [self.window makeFirstResponder:self];
}

@end

#pragma mark - 设置窗口

@interface DSHHotkeySettingsWindow () <NSWindowDelegate, DSHHotkeyCaptureViewDelegate>
@property (nonatomic, strong) DSHConfig *config;
@property (nonatomic, strong) DSHHotkeyManager *manager;
@property (nonatomic, copy) NSString *dataDir;
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) DSHHotkeyCaptureView *captureView;
@property (nonatomic, strong) NSTextField *statusLabel;
@property (nonatomic, strong) DSHHotkeyDefinition *captured;
@end

@implementation DSHHotkeySettingsWindow

- (instancetype)initWithConfig:(DSHConfig *)config
                       manager:(DSHHotkeyManager *)manager
                       dataDir:(NSString *)dataDir {
    self = [super init];
    if (self) {
        _config = config;
        _manager = manager;
        _dataDir = [dataDir copy];
        [self buildWindow];
    }
    return self;
}

- (void)buildWindow {
    NSRect frame = NSMakeRect(0, 0, 460, 268);
    NSWindowStyleMask style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable;
    self.window = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    self.window.title = @"设置全局快捷键";
    self.window.delegate = self;
    self.window.releasedWhenClosed = NO;
    [self.window center];

    NSView *content = self.window.contentView;

    NSTextField *instruction = [NSTextField wrappingLabelWithString:
        @"按下新的快捷键组合（至少包含 Ctrl / Alt / Shift / Cmd 之一 + 一个普通键）。"
        @"按 Esc 取消捕获，按 Delete 清除捕获。"];
    instruction.frame = NSMakeRect(24, 205, 412, 46);
    instruction.font = [NSFont systemFontOfSize:12.0];
    instruction.textColor = [NSColor secondaryLabelColor];
    [content addSubview:instruction];

    self.captureView = [[DSHHotkeyCaptureView alloc] initWithFrame:NSMakeRect(24, 158, 412, 40)];
    self.captureView.delegate = self;
    [content addSubview:self.captureView];

    self.statusLabel = [NSTextField wrappingLabelWithString:@""];
    self.statusLabel.frame = NSMakeRect(24, 100, 412, 46);
    self.statusLabel.font = [NSFont systemFontOfSize:12.0];
    self.statusLabel.textColor = [NSColor labelColor];
    [content addSubview:self.statusLabel];

    NSButton *saveButton = [NSButton buttonWithTitle:@"保存并注册" target:self action:@selector(onSave:)];
    saveButton.frame = NSMakeRect(52, 40, 118, 32);
    saveButton.bezelStyle = NSBezelStyleRounded;
    saveButton.keyEquivalent = @"\r";
    [content addSubview:saveButton];

    NSButton *clearButton = [NSButton buttonWithTitle:@"清除" target:self action:@selector(onClear:)];
    clearButton.frame = NSMakeRect(184, 40, 92, 32);
    clearButton.bezelStyle = NSBezelStyleRounded;
    [content addSubview:clearButton];

    NSButton *cancelButton = [NSButton buttonWithTitle:@"取消" target:self action:@selector(onCancel:)];
    cancelButton.frame = NSMakeRect(290, 40, 118, 32);
    cancelButton.bezelStyle = NSBezelStyleRounded;
    cancelButton.keyEquivalent = @"\e";
    [content addSubview:cancelButton];
}

- (NSString *)savedStatusText {
    if (!self.config.hotkey.length) {
        return @"当前：未设置";
    }
    return [NSString stringWithFormat:@"当前：%@（窗口关闭后恢复注册）", self.config.hotkey];
}

- (void)runModal {
    // 打开期间临时注销旧热键，防止按旧组合触发控制台。
    [self.manager unregister];
    self.captured = nil;
    [self.captureView setDisplayText:self.config.hotkey];
    self.statusLabel.stringValue = [self savedStatusText];
    DSHLogInfo(@"打开全局快捷键设置窗口，已暂停旧热键: %@", self.config.hotkey.length ? self.config.hotkey : @"(未设置)");

    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
    [self.window makeFirstResponder:self.captureView];
    [NSApp runModalForWindow:self.window];
}

- (void)windowWillClose:(NSNotification *)notification {
    [NSApp stopModalWithCode:NSModalResponseCancel];
    [self restoreRegistrationFromConfig];
}

- (void)closeWindow {
    [self.window close];
}

- (void)restoreRegistrationFromConfig {
    NSString *saved = self.config.hotkey;
    if (!saved.length) {
        [self.manager unregister];
        DSHLogInfo(@"全局快捷键设置窗口关闭：未设置");
        return;
    }
    NSString *parseError = nil;
    DSHHotkeyDefinition *definition = [DSHHotkeyDefinition parse:saved error:&parseError];
    if (!definition) {
        [self.manager unregister];
        DSHLogWarn(@"保存的全局快捷键非法，未注册: %@ (%@)", saved, parseError);
        return;
    }
    if (self.manager.isRegistered && [self.manager.currentCombo isEqualToString:saved]) {
        return;
    }
    NSString *registerError = nil;
    if ([self.manager registerDefinition:definition error:&registerError]) {
        DSHLogInfo(@"全局快捷键已重新注册: %@", saved);
    } else {
        DSHLogWarn(@"恢复全局快捷键注册失败: %@ - %@", saved, registerError);
    }
}

#pragma mark 按钮

- (void)onSave:(id)sender {
    @try {
        if (!self.captured) {
            // 未捕获到有效组合：视为清除。
            [self.manager unregister];
            self.config.hotkey = @"";
            [self.config saveToDirectory:self.dataDir];
            self.statusLabel.stringValue = @"当前：未设置";
            DSHLogInfo(@"全局快捷键已清除（保存空组合）");
            [self closeWindow];
            return;
        }

        NSString *combo = self.captured.comboString;
        NSString *error = nil;
        BOOL registered = [self.manager registerDefinition:self.captured error:&error];
        // 无论注册成功与否都持久化（下次启动仍尝试）。
        self.config.hotkey = combo;
        [self.config saveToDirectory:self.dataDir];
        if (!registered) {
            self.statusLabel.stringValue = @"注册失败：快捷键可能被其他程序占用";
            DSHLogWarn(@"全局快捷键注册失败: %@ - %@", combo, error);
            return;
        }
        self.statusLabel.stringValue = [NSString stringWithFormat:@"当前：%@（已注册）", combo];
        DSHLogInfo(@"全局快捷键已保存并注册: %@", combo);
        [self closeWindow];
    } @catch (NSException *exception) {
        DSHLogError(@"保存全局快捷键失败: %@", exception.reason);
        self.statusLabel.stringValue = [NSString stringWithFormat:@"保存失败：%@", exception.reason];
    }
}

- (void)onClear:(id)sender {
    @try {
        [self.manager unregister];
        self.config.hotkey = @"";
        [self.config saveToDirectory:self.dataDir];
        self.captured = nil;
        [self.captureView setDisplayText:@""];
        self.statusLabel.stringValue = @"当前：未设置";
        DSHLogInfo(@"全局快捷键已清除");
        [self closeWindow];
    } @catch (NSException *exception) {
        DSHLogError(@"清除全局快捷键失败: %@", exception.reason);
        self.statusLabel.stringValue = [NSString stringWithFormat:@"清除失败：%@", exception.reason];
    }
}

- (void)onCancel:(id)sender {
    [self closeWindow];
}

#pragma mark 录制回调

- (void)captureView:(id)view didChangeModifierFlags:(NSEventModifierFlags)flags {
    if (self.captured) {
        return;
    }
    UInt32 modifiers = [DSHHotkeyDefinition modifiersFromModifierFlags:flags];
    if (modifiers != 0) {
        [self.captureView setDisplayText:[DSHHotkeyDefinition displayModifiers:modifiers]];
        self.statusLabel.stringValue = @"请再按一个普通键";
    } else {
        [self.captureView setDisplayText:self.config.hotkey];
        self.statusLabel.stringValue = self.config.hotkey.length ? [self savedStatusText] : @"当前：未设置";
    }
}

- (void)captureView:(id)view didReceiveKeyEvent:(NSEvent *)event {
    @try {
        unsigned short keyCode = event.keyCode;
        NSEventModifierFlags flags = event.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagOption
                                                           | NSEventModifierFlagShift | NSEventModifierFlagCommand);

        if (keyCode == kVK_Escape && flags == 0) {
            self.captured = nil;
            [self.captureView setDisplayText:self.config.hotkey];
            self.statusLabel.stringValue = @"已取消当前捕获";
            return;
        }
        if ((keyCode == kVK_Delete || keyCode == kVK_ForwardDelete) && flags == 0) {
            self.captured = nil;
            [self.captureView setDisplayText:@""];
            self.statusLabel.stringValue = @"已清除捕获（点「保存并注册」生效）";
            return;
        }
        if ([DSHHotkeyDefinition isModifierKeyCode:keyCode]) {
            return;
        }

        NSString *error = nil;
        DSHHotkeyDefinition *definition = [DSHHotkeyDefinition definitionWithKeyCode:keyCode
                                                                      modifierFlags:flags
                                                                              error:&error];
        if (!definition) {
            self.statusLabel.stringValue = error ?: @"不支持该键";
            return;
        }
        self.captured = definition;
        [self.captureView setDisplayText:definition.displayString];
        self.statusLabel.stringValue = [NSString stringWithFormat:@"已捕获：%@（点「保存并注册」生效）",
                                                                 definition.displayString];
    } @catch (NSException *exception) {
        DSHLogError(@"捕获快捷键失败: %@", exception.reason);
    }
}

@end
