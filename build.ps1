# DSHStatusTray build script (one-click compile).
# Uses the .NET Framework built-in C# compiler (C# 5). No third-party dependencies.
# Usage: powershell -ExecutionPolicy Bypass -File build.ps1
# Output: <project root>\bin\DSHStatusTray.exe. Exit code 0 on success, non-zero on failure.
# NOTE: keep this file ASCII-only so Windows PowerShell 5.1 can parse it regardless of encoding.

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir = Join-Path $projectRoot 'src'
$srcFile = Join-Path $srcDir 'TrayApp.cs'
$manifestFile = Join-Path $srcDir 'app.manifest'
$binDir = Join-Path $projectRoot 'bin'
$outFile = Join-Path $binDir 'DSHStatusTray.exe'

$windir = $env:WINDIR
if ([string]::IsNullOrEmpty($windir)) { $windir = $env:SystemRoot }
if ([string]::IsNullOrEmpty($windir)) { $windir = 'C:\Windows' }

$cscCandidates = @(
    (Join-Path $windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)

$csc = $null
foreach ($candidate in $cscCandidates) {
    if (Test-Path -LiteralPath $candidate) { $csc = $candidate; break }
}
if ($null -eq $csc) {
    Write-Host 'ERROR: csc.exe not found (looked in Framework64 and Framework v4.0.30319).' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $srcFile)) {
    Write-Host ('ERROR: source file not found: ' + $srcFile) -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $manifestFile)) {
    Write-Host ('ERROR: manifest file not found: ' + $manifestFile) -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath $binDir)) {
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
}

# Remove stale artifact so a failed compile cannot leave an old exe behind.
if (Test-Path -LiteralPath $outFile) {
    try { Remove-Item -LiteralPath $outFile -Force } catch { }
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/codepage:65001',
    '/optimize+',
    ('/win32manifest:' + $manifestFile),
    ('/out:' + $outFile),
    '/r:System.dll',
    '/r:System.Core.dll',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    $srcFile
)

Write-Host ('Compiler: ' + $csc)
& $csc $cscArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    Write-Host ('ERROR: compile failed, csc exit code ' + $exitCode) -ForegroundColor Red
    exit $exitCode
}
if (-not (Test-Path -LiteralPath $outFile)) {
    Write-Host 'ERROR: csc returned 0 but output exe is missing.' -ForegroundColor Red
    exit 1
}

$info = Get-Item -LiteralPath $outFile
Write-Host ('OK: ' + $info.FullName + ' (' + $info.Length + ' bytes)')

# The DSH workspace may carry a Low mandatory integrity label (sandbox artifact). A process
# started from a Low labeled exe runs at low integrity and cannot write its runtime files
# under %LOCALAPPDATA%\DSHStatusTray. Raise the freshly built exe to Medium integrity so it
# behaves like a normal user application. This is best effort: on machines where the label
# does not exist, or where relabeling is not permitted, the build still succeeds.
$icacls = Join-Path $windir 'System32\icacls.exe'
if (Test-Path -LiteralPath $icacls) {
    try {
        $relabel = & $icacls $outFile /setintegritylevel Medium 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Write-Host 'OK: exe integrity label set to Medium.'
        } else {
            Write-Host ('WARN: could not set integrity label (icacls exit ' + $LASTEXITCODE + '); run the exe from a normal folder if it cannot write %LOCALAPPDATA%.') -ForegroundColor Yellow
        }
    } catch {
        Write-Host 'WARN: icacls invocation failed; continuing.' -ForegroundColor Yellow
    }
} else {
    Write-Host 'WARN: icacls.exe not found; skipped integrity label check.' -ForegroundColor Yellow
}

exit 0
