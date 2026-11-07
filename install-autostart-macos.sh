#!/usr/bin/env bash
#
# DSH 状态托盘 macOS 开机自启安装 / 卸载（当前用户 LaunchAgent，无需管理员权限）。
#
# 用法:
#   ./install-autostart-macos.sh            # 安装开机自启并启动托盘
#   ./install-autostart-macos.sh --remove   # 取消开机自启（并退出正在运行的托盘）
#   ./install-autostart-macos.sh --status   # 查看 LaunchAgent 状态
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/bin/DSHStatusTray.app"
EXE="$APP/Contents/MacOS/DSHStatusTray"
LABEL="com.dsh.statustray"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

usage() {
    sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//'
}

stop_running_app() {
    if pgrep -f "$EXE" >/dev/null 2>&1; then
        echo "==> 退出正在运行的托盘"
        pkill -TERM -f "$EXE" 2>/dev/null || true
        sleep 1
    fi
}

case "${1:-install}" in
    install|--install)
        if [ ! -x "$EXE" ]; then
            echo "ERROR: 找不到 $EXE" >&2
            echo "请先在本目录运行：./build-macos.sh" >&2
            exit 1
        fi
        mkdir -p "$AGENT_DIR"
        cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${EXE}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
</dict>
</plist>
PLIST_END

        if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
            echo "ERROR: 生成的 LaunchAgent plist 非法: $PLIST" >&2
            exit 1
        fi

        stop_running_app

        # 先卸载旧 job（如果存在），再按现代 API 加载；旧系统回退 load -w。
        launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        if launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
            launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
        else
            launchctl load -w "$PLIST" >/dev/null 2>&1 || true
        fi

        sleep 1
        if pgrep -f "$EXE" >/dev/null 2>&1; then
            echo "已安装开机自启并启动托盘：$PLIST"
            echo "菜单栏右上角应出现彩色圆点；右键（或左键）可打开菜单。"
        else
            echo "已安装开机自启：$PLIST" >&2
            echo "WARN: 托盘进程未检测到，请检查「控制台」或 ~/Library/Application Support/DSHStatusTray/tray.log" >&2
            exit 1
        fi
        ;;
    --remove|uninstall)
        launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
        stop_running_app
        if [ -f "$PLIST" ]; then
            rm -f "$PLIST"
            echo "已取消开机自启：$PLIST"
        else
            echo "没有找到开机自启配置，无需操作。"
        fi
        ;;
    --status|status)
        launchctl print "$DOMAIN/$LABEL" 2>/dev/null || {
            echo "未安装开机自启（$PLIST 不存在或未加载）。"
            exit 1
        }
        ;;
    -h|--help)
        usage
        ;;
    *)
        echo "未知参数: $1" >&2
        usage >&2
        exit 2
        ;;
esac
