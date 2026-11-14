<#
  注册"收工脱敏"计划任务（每天 23:30 跑一次，DSH 在运行时会自动跳过）。

  注册：  .\install-task.ps1
  查看：  schtasks /query /tn "DSH-Guardrails-Redact" /v /fo list
  删除：  schtasks /delete /tn "DSH-Guardrails-Redact" /f
#>
param(
  [string]$Time = '23:30',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$taskName = 'DSH-Guardrails-Redact'

if ($Remove) {
  schtasks /delete /tn $taskName /f | Out-Null
  Write-Host "已删除计划任务 $taskName"
  exit 0
}

$bat = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'redact-silent.bat'
if (-not (Test-Path $bat)) { throw "找不到 $bat" }

schtasks /create /tn $taskName /tr "`"$bat`"" /sc daily /st $Time /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw "注册失败，退出码 $LASTEXITCODE" }

Write-Host "已注册：$taskName，每天 $Time 运行"
Write-Host "运行内容：$bat"
Write-Host 'DSH 正在运行时脚本会自行退出，不会碰正在写入的会话文件。'
