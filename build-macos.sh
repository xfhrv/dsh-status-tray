#!/usr/bin/env bash
#
# DSHStatusTray macOS 构建脚本（一键编译 + 打包 .app）。
#
# 用法:
#   ./build-macos.sh              # 默认尝试 arm64 + x86_64 通用二进制
#   DSH_MACOS_NATIVE_ONLY=1 ./build-macos.sh   # 只编译当前架构（交叉编译失败时更快）
#
# 输出: bin/DSHStatusTray.app（含 Info.plist / 图标 / Node 状态引擎脚本，ad-hoc 签名）
# 依赖: Xcode Command Line Tools（clang、sips、iconutil、codesign），无第三方库。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$ROOT/src/macos"
BIN_DIR="$ROOT/bin"
APP="$BIN_DIR/DSHStatusTray.app"
CONTENTS="$APP/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
EXECUTABLE="$MACOS_DIR/DSHStatusTray"

if ! command -v clang >/dev/null 2>&1; then
    echo "ERROR: 找不到 clang。请先安装 Xcode Command Line Tools：xcode-select --install" >&2
    exit 1
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "ERROR: 找不到源码目录 $SRC_DIR" >&2
    exit 1
fi
if [ ! -f "$ROOT/src/status-agent.mjs" ] || [ ! -f "$ROOT/src/status-core.mjs" ]; then
    echo "ERROR: 缺少 Node 状态引擎脚本 src/status-agent.mjs / src/status-core.mjs" >&2
    exit 1
fi

echo "==> 清理旧产物"
rm -rf "$APP"
mkdir -p "$MACOS_DIR" "$RESOURCES/agent" "$BIN_DIR"

COMMON_FLAGS=(
    -fobjc-arc
    -O2
    -Wall
    -Wextra
    -Wno-unused-parameter
    -Wno-deprecated-declarations
    -mmacosx-version-min=11.0
    -I "$SRC_DIR"
    -framework Cocoa
    -framework Carbon
    -framework UserNotifications
)

echo "==> 编译（ObjC / AppKit）"
BUILD_LOG="$BIN_DIR/macos-build.log"
UNIVERSAL_OK=0
if [ "${DSH_MACOS_NATIVE_ONLY:-0}" != "1" ]; then
    if clang "${COMMON_FLAGS[@]}" -arch arm64 -arch x86_64 "$SRC_DIR"/*.m -o "$EXECUTABLE" >"$BUILD_LOG" 2>&1; then
        UNIVERSAL_OK=1
        echo "    arm64 + x86_64 通用二进制"
    else
        echo "    WARN: 通用二进制编译失败，回退到本机架构（日志: $BUILD_LOG）"
        rm -f "$EXECUTABLE"
    fi
fi
if [ "$UNIVERSAL_OK" -ne 1 ]; then
    if ! clang "${COMMON_FLAGS[@]}" "$SRC_DIR"/*.m -o "$EXECUTABLE" >"$BUILD_LOG" 2>&1; then
        echo "ERROR: 编译失败，日志如下（$BUILD_LOG）：" >&2
        cat "$BUILD_LOG" >&2
        exit 1
    fi
    echo "    本机架构: $(uname -m)"
fi

echo "==> 写入 Info.plist 与运行时资源"
cp "$SRC_DIR/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/src/status-agent.mjs" "$RESOURCES/agent/status-agent.mjs"
cp "$ROOT/src/status-core.mjs" "$RESOURCES/agent/status-core.mjs"

echo "==> 生成应用图标"
ICONSET="$BIN_DIR/AppIcon.iconset"
rm -rf "$ICONSET"
if "$EXECUTABLE" --render-app-icon "$BIN_DIR/AppIcon-1024.png" >/dev/null 2>&1; then
    mkdir -p "$ICONSET"
    for size in 16 32 128 256 512; do
        sips -z "$size" "$size" "$BIN_DIR/AppIcon-1024.png" \
            --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
        sips -z "$((size * 2))" "$((size * 2))" "$BIN_DIR/AppIcon-1024.png" \
            --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
    done
    if iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"; then
        echo "    AppIcon.icns"
    else
        echo "    WARN: iconutil 失败，应用图标将使用系统默认图标"
    fi
    rm -rf "$ICONSET"
else
    echo "    WARN: 应用图标渲染失败，跳过"
fi

echo "==> ad-hoc 签名（本机通知 / 权限需要）"
if codesign --force --sign - "$APP" >/dev/null 2>&1; then
    echo "    已签名（ad-hoc）"
else
    echo "    WARN: codesign 失败；通知可能不可用"
fi

if [ ! -x "$EXECUTABLE" ]; then
    echo "ERROR: 编译产物不存在: $EXECUTABLE" >&2
    exit 1
fi

SIZE="$(du -sh "$APP" | awk '{print $1}')"
echo
echo "OK: $APP ($SIZE)"
echo "运行: open \"$APP\""
echo "开机自启: ./install-autostart-macos.sh"
