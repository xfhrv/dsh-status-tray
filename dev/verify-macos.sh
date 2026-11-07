#!/usr/bin/env bash
#
# macOS 验收脚本（需要先运行 ./build-macos.sh）。
# 不启动托盘/状态引擎，只用一次快照验证：图标导出、菜单结构、状态读取。
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/bin/DSHStatusTray.app"
EXE="$APP/Contents/MacOS/DSHStatusTray"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-macos-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

if [ ! -x "$EXE" ]; then
    echo "ERROR: 先运行 ./build-macos.sh 生成 $APP" >&2
    exit 1
fi

echo "==> 生成一次状态快照"
node "$ROOT/src/status-agent.mjs" --once > "$TMP/status.json"

echo "==> 导出四色图标"
"$EXE" --no-agent --status "$TMP/status.json" --render-icons "$TMP/icons" >/dev/null
for state in working approval idle offline; do
    if [ ! -s "$TMP/icons/$state.png" ]; then
        echo "ERROR: 缺少图标 $state.png" >&2
        exit 1
    fi
done

echo "==> 打印菜单结构"
MENU="$("$EXE" --no-agent --status "$TMP/status.json" --print-menu)"
printf '%s\n' "$MENU"
for expected in "打开控制台" "打开网页版 DeepSeek" "查看 DS 服务器状态" "设置全局快捷键…" "退出"; do
    if ! printf '%s' "$MENU" | grep -q "$expected"; then
        echo "ERROR: 菜单缺少「$expected」" >&2
        exit 1
    fi
done

echo
echo "OK: macOS 验收检查通过"
