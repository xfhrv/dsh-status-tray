//
//  DSHIcon.m — 状态圆点 / 应用图标绘制（纯 AppKit，无资源文件依赖）
//

#import "DSHCommon.h"

@implementation DSHIconPainter

/// 在 18x18 单位坐标系里画圆点；scale 把单位换算成像素。
static void DSHDrawDot(CGFloat scale, NSColor *fill) {
    NSColor *outline = DSHDarkenColor(fill, 0.55);
    [outline setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(2.0 * scale, 2.0 * scale, 14.0 * scale, 14.0 * scale)] fill];

    [fill setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(3.0 * scale, 3.0 * scale, 12.0 * scale, 12.0 * scale)] fill];

    [[NSColor colorWithSRGBRed:1.0 green:1.0 blue:1.0 alpha:0.42] setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(5.3 * scale, 9.4 * scale, 5.4 * scale, 3.6 * scale)] fill];
}

/// 生成 1:1 位图（pixelSize 像素），并在里面按 18 单位设计稿绘制。
static NSBitmapImageRep *DSHCreateBitmap(NSUInteger pixelSize, void (^drawBlock)(CGFloat scale)) {
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                                   pixelsWide:pixelSize
                                                                   pixelsHigh:pixelSize
                                                                bitsPerSample:8
                                                              samplesPerPixel:4
                                                                     hasAlpha:YES
                                                                     isPlanar:NO
                                                               colorSpaceName:NSCalibratedRGBColorSpace
                                                                  bytesPerRow:0
                                                                 bitsPerPixel:0];
    if (!rep) {
        return nil;
    }
    NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
    if (!context) {
        return nil;
    }
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    [[NSColor clearColor] setFill];
    NSRectFill(NSMakeRect(0, 0, (CGFloat)pixelSize, (CGFloat)pixelSize));
    [[NSGraphicsContext currentContext] setShouldAntialias:YES];
    drawBlock((CGFloat)pixelSize / 18.0);
    [NSGraphicsContext restoreGraphicsState];
    return rep;
}

+ (NSImage *)dotImageWithColor:(NSColor *)color pointSize:(CGFloat)pointSize {
    if (!color || pointSize <= 0) {
        return nil;
    }
    NSUInteger scale = 2; // Retina：18pt → 36px
    NSUInteger pixelSize = (NSUInteger)llround(pointSize * (CGFloat)scale);
    NSBitmapImageRep *rep = DSHCreateBitmap(pixelSize, ^(CGFloat unitScale) {
        DSHDrawDot(unitScale, color);
    });
    if (!rep) {
        return nil;
    }
    rep.size = NSMakeSize(pointSize, pointSize);

    NSImage *image = [[NSImage alloc] initWithSize:NSMakeSize(pointSize, pointSize)];
    [image addRepresentation:rep];
    image.template = NO;
    return image;
}

+ (BOOL)writeDotPNGForColor:(NSColor *)color toPath:(NSString *)path pixelSize:(NSUInteger)pixelSize {
    if (!color || !path.length) {
        return NO;
    }
    NSBitmapImageRep *rep = DSHCreateBitmap(MAX((NSUInteger)8, pixelSize), ^(CGFloat unitScale) {
        DSHDrawDot(unitScale, color);
    });
    if (!rep) {
        return NO;
    }
    NSData *data = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!data) {
        return NO;
    }
    return [data writeToFile:path atomically:YES];
}

+ (BOOL)writeAppIconPNGToPath:(NSString *)path pixelSize:(NSUInteger)pixelSize {
    if (!path.length) {
        return NO;
    }
    NSUInteger size = MAX((NSUInteger)128, pixelSize);

    NSBitmapImageRep *rep = DSHCreateBitmap(size, ^(CGFloat scale) {
        CGFloat canvas = scale * 18.0;
        NSRect background = NSMakeRect(canvas * 0.045, canvas * 0.045, canvas * 0.91, canvas * 0.91);
        NSBezierPath *rounded = [NSBezierPath bezierPathWithRoundedRect:background
                                                               xRadius:canvas * 0.21
                                                               yRadius:canvas * 0.21];
        NSGradient *gradient = [[NSGradient alloc] initWithColors:@[
            [NSColor colorWithSRGBRed:0.16 green:0.19 blue:0.24 alpha:1.0],
            [NSColor colorWithSRGBRed:0.07 green:0.09 blue:0.12 alpha:1.0],
        ]];
        [gradient drawInBezierPath:rounded angle:-90.0];

        [[NSColor colorWithSRGBRed:1.0 green:1.0 blue:1.0 alpha:0.14] setStroke];
        rounded.lineWidth = canvas * 0.006;
        [rounded stroke];

        // 四色状态灯（红 / 黄 / 绿 / 灰），与外层深色描边一起构成状态灯的视觉语言。
        NSArray<NSColor *> *colors = @[
            DSHColorFromHex(@"#E5484D") ?: [NSColor redColor],
            DSHColorFromHex(@"#F2B705") ?: [NSColor yellowColor],
            DSHColorFromHex(@"#2FA84F") ?: [NSColor greenColor],
            DSHColorFromHex(@"#9AA0A6") ?: [NSColor grayColor],
        ];
        CGFloat radius = canvas * 0.105;
        CGFloat centers[4][2] = {
            { 0.355, 0.645 },
            { 0.645, 0.645 },
            { 0.355, 0.355 },
            { 0.645, 0.355 },
        };
        for (NSUInteger index = 0; index < colors.count; index += 1) {
            CGFloat cx = centers[index][0] * canvas;
            CGFloat cy = centers[index][1] * canvas;
            NSRect dotRect = NSMakeRect(cx - radius, cy - radius, radius * 2.0, radius * 2.0);
            [DSHDarkenColor(colors[index], 0.55) setFill];
            [[NSBezierPath bezierPathWithOvalInRect:NSInsetRect(dotRect, -canvas * 0.012, -canvas * 0.012)] fill];
            [colors[index] setFill];
            [[NSBezierPath bezierPathWithOvalInRect:dotRect] fill];

            NSRect highlight = NSMakeRect(cx - radius * 0.55, cy + radius * 0.15, radius * 0.85, radius * 0.55);
            [[NSColor colorWithSRGBRed:1.0 green:1.0 blue:1.0 alpha:0.38] setFill];
            [[NSBezierPath bezierPathWithOvalInRect:highlight] fill];
        }
    });
    if (!rep) {
        return NO;
    }
    NSData *data = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!data) {
        return NO;
    }
    return [data writeToFile:path atomically:YES];
}

@end
