# DSH 状态托盘 — 开机自启安装/卸载（当前用户，无需管理员）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1          # 安装开机自启并启动托盘
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove  # 取消开机自启
#
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root 'bin\DSHStatusTray.exe'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'DSH 状态托盘.lnk'

if ($Remove) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
        Write-Host "已取消开机自启：$shortcutPath" -ForegroundColor Green
    } else {
        Write-Host "没有找到开机自启快捷方式，无需操作。" -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "找不到 $exe" -ForegroundColor Red
    Write-Host "请先在本目录运行：powershell -ExecutionPolicy Bypass -File build.ps1" -ForegroundColor Yellow
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exe
$shortcut.WorkingDirectory = Split-Path -Parent $exe
$shortcut.Description = 'DSH 状态托盘状态灯'
$shortcut.IconLocation = "$exe,0"
$shortcut.Save()
Write-Host "已创建开机自启快捷方式：$shortcutPath" -ForegroundColor Green

$running = Get-Process -Name 'DSHStatusTray' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "DSH 状态托盘已在运行，跳过启动。" -ForegroundColor Yellow
} else {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
    Write-Host "已启动 DSH 状态托盘。若任务栏看不到图标，请点击任务栏的“显示隐藏的图标”（^）并把圆点拖到任务栏常驻。" -ForegroundColor Green
}
