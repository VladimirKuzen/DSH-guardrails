<#
  End-of-day redaction (PowerShell wrapper)
  -----------------------------------------
  1. Refuse to run while DSH is open (it writes session files as we speak).
  2. Run redact.mjs: encrypted snapshot -> redact only matching files -> verify.
  3. Print a Chinese summary; the Node part prints machine-oriented English.

  Usage:
    .\redact.ps1              interactive
    .\redact.ps1 -NoPause     for the scheduled task
    .\redact.ps1 -DryRun      report only, writes nothing
#>
param(
  [switch]$DryRun,
  [switch]$NoPause,
  [switch]$Force,
  [int]$KeepDays = 90
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:USERPROFILE '.dsh\guardrails'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'redact-shell.log'

function Write-Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $log -Value $line -Encoding utf8
  Write-Host $text
}

try {
  $dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($dsh -and -not $Force) {
    Write-Log 'DSH 正在运行，会话文件正被写入，现在改有损坏风险。'
    Write-Log '请完全退出 DSH（含托盘图标）后再运行。'
    if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
    exit 1
  }

  $node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (-not (Test-Path $node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source } else { throw 'Node runtime not found' }
  }

  $script = Join-Path $here 'redact.mjs'
  if (-not (Test-Path $script)) { throw "Missing $script" }

  $nodeArgs = @($script, '--keep-days', $KeepDays)
  if ($DryRun) { $nodeArgs += '--dry-run' } else { $nodeArgs += '--apply' }

  Write-Log "使用 Node: $node"
  & $node @nodeArgs
  $code = $LASTEXITCODE
  if ($code -eq 0 -and -not $DryRun) {
    Write-Log '完成。备份在 ~/.dsh/guardrails/vault，清单在 manifests 子目录。'
    Write-Log '还原：.\restore.ps1 -List 查看快照，.\restore.ps1 -Manifest <清单> -Target <目录>'
  } elseif ($code -eq 0) {
    Write-Log '演练结束，未写入任何文件。'
  } else {
    Write-Log "脚本返回 $code，请看上面的输出。"
  }
}
catch {
  Write-Log ("出错：" + $_.Exception.Message)
  $code = 1
}
finally {
  if (-not $NoPause) { Read-Host '按回车退出' | Out-Null }
}
exit $code
