param(
    [Parameter(Mandatory = $true)][string]$PlrPath,
    [Parameter(Mandatory = $true)][string]$OutputXls,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$dmrDir = "C:\Program Files (x86)\DMR\dmr"
$dmrExe = Join-Path $dmrDir "DMEngine.exe"
$inputFile = (Resolve-Path -LiteralPath $PlrPath).Path
$outputFile = [IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputXls))
$defaultSave = Join-Path $projectRoot "outputs\Untitled1.xls"

if (-not (Test-Path -LiteralPath $dmrExe)) { throw "未找到 DMR：$dmrExe" }
if (Test-Path -LiteralPath $defaultSave) { throw "DMR 默认导出文件已存在，请先改名：$defaultSave" }
New-Item -ItemType Directory -Path (Split-Path -Parent $outputFile) -Force | Out-Null

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class DmrTestMessages {
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@

function Wait-For([scriptblock]$Test, [string]$Description) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $value = & $Test
        if ($value) { return $value }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "等待超时：$Description"
}

function Find-DmrElement([System.Diagnostics.Process]$Process, [scriptblock]$Predicate) {
    $Process.Refresh()
    if ($Process.MainWindowHandle -eq 0) { return $null }
    $root = [Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    if (-not $root) { return $null }
    $all = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
        $element = $all.Item($i)
        if (& $Predicate $element) { return $element }
    }
    return $null
}

$running = Get-Process DMEngine -ErrorAction SilentlyContinue
if ($running) { $running | Stop-Process -Force }

$null = Start-Process -FilePath $inputFile -PassThru
$process = Wait-For { Get-Process DMEngine -ErrorAction SilentlyContinue | Select-Object -First 1 } "DMR 进程"
try {
    Wait-For { $process.Refresh(); if ($process.HasExited) { throw "DMR 提前退出，退出码 $($process.ExitCode)" }; $process.MainWindowHandle -ne 0 } "DMR 主窗口" | Out-Null
    # 旧式 x86 MFC 进程的 MainWindowTitle 在 64 位 PowerShell 中有时不会刷新；
    # 给分析器和设备 DLL 留出固定加载时间，再发送菜单命令。
    Start-Sleep -Seconds 5
    $process.Refresh()

    # 文件 -> Excel导出，命令 ID 32771（由 DMR 3.20.0 菜单枚举确认）
    [DmrTestMessages]::SendMessage($process.MainWindowHandle, 0x0111, [IntPtr]32771, [IntPtr]::Zero) | Out-Null
    $exportButton = Wait-For {
        Find-DmrElement $process { param($e) $e.Current.Name -eq "Excel导出" -and $e.Current.ClassName -eq "Button" -and $e.Current.AutomationId -eq "1058" }
    } "Excel 导出对话框" 
    if (-not $exportButton) { throw "未取得 Excel 导出按钮" }
    $exportHandle = [IntPtr]($exportButton.Current.NativeWindowHandle)
    if ($exportHandle -eq [IntPtr]::Zero) { throw "Excel 导出按钮句柄为空，实际类型：$($exportButton.GetType().FullName)" }
    [DmrTestMessages]::SendMessage($exportHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    $saveButton = Wait-For {
        Find-DmrElement $process { param($e) $e.Current.Name -eq "保存(S)" -and $e.Current.ClassName -eq "Button" -and $e.Current.AutomationId -eq "1" }
    } "另存为对话框"
    if (-not $saveButton) { throw "未取得保存按钮" }
    $saveHandle = [IntPtr]($saveButton.Current.NativeWindowHandle)
    if ($saveHandle -eq [IntPtr]::Zero) { throw "保存按钮句柄为空，实际类型：$($saveButton.GetType().FullName)" }
    [DmrTestMessages]::SendMessage($saveHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

    Wait-For {
        if (-not (Test-Path -LiteralPath $defaultSave)) { return $false }
        $file = Get-Item -LiteralPath $defaultSave
        $file.Length -gt 100000 -and ((Get-Date) - $file.LastWriteTime).TotalMilliseconds -gt 750
    } "DMR 完整写出 $defaultSave" | Out-Null
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    Move-Item -LiteralPath $defaultSave -Destination $outputFile -Force
    Get-Item -LiteralPath $outputFile | Select-Object FullName, Length, LastWriteTime
}
finally {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
