<#
  Guardrails health check. Double-click health-check.cmd to run.

  Liveness is proven by evidence, not by a pid:
    - loaded.json version must match package.json
    - loaded.json mtime shows the last time the gate evaluated a call
    - today's audit file shows how many calls were gated

  A stale pid proves nothing: the host process can be replaced while the gate
  keeps working in a new one.
#>
param([switch]$NoPause)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$plugin = Join-Path $root 'dsh-guardrails'
$homeDir = Join-Path $env:USERPROFILE '.dsh\guardrails'
$loaded = Join-Path $homeDir 'loaded.json'
$policy = Join-Path $homeDir 'policy.json'
$auditDir = Join-Path $homeDir 'audit'

$rows = @()
function Add-Row([string]$name, [string]$result, [string]$detail) {
  $script:rows += [pscustomobject]@{ Check = $name; Result = $result; Detail = $detail }
}

# 1. Heartbeat file and version
$heartbeat = $null
if (Test-Path $loaded) {
  try { $heartbeat = Get-Content $loaded -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
$pkg = $null
try {
  $pkgText = [IO.File]::ReadAllText((Join-Path $plugin 'package.json'), [Text.Encoding]::UTF8)
  $pkg = $pkgText | ConvertFrom-Json
} catch {
  $pkg = $null
}

if ($heartbeat -eq $null) {
  Add-Row 'Heartbeat file' 'FAIL' 'loaded.json missing: the plugin never mounted'
} elseif ($pkg -ne $null -and $heartbeat.version -ne $pkg.version) {
  Add-Row 'Heartbeat file' 'FAIL' "version mismatch: plugin $($pkg.version), loaded $($heartbeat.version)"
} else {
  Add-Row 'Heartbeat file' 'OK' "version $($heartbeat.version)"
}

# 2. Freshness of the last evaluation
if (Test-Path $loaded) {
  $age = (Get-Date) - (Get-Item $loaded).LastWriteTime
  $mins = [int]$age.TotalMinutes
  if ($age.TotalDays -gt 7) {
    Add-Row 'Last evaluation' 'WARN' "no gated call for $([int]$age.TotalDays) days (idle or not mounted)"
  } else {
    Add-Row 'Last evaluation' 'OK' "$mins minutes ago"
  }
}

# 3. Today's audit evidence
if (Test-Path $auditDir) {
  $today = Join-Path $auditDir ("audit-" + (Get-Date -Format 'yyyy-MM-dd') + ".jsonl")
  if (Test-Path $today) {
    $count = (Get-Content $today -Encoding UTF8 | Where-Object { $_.Trim() -ne '' }).Count
    Add-Row 'Audit today' 'OK' "$count gated calls"
  } else {
    Add-Row 'Audit today' 'WARN' 'no gated call yet today (normal if nothing was flagged)'
  }
} else {
  Add-Row 'Audit today' 'WARN' 'audit directory not created yet'
}

# 4. package.json must not carry a BOM (DSH skips the whole bundle silently)
$pkgPath = Join-Path $plugin 'package.json'
$bytes = [IO.File]::ReadAllBytes($pkgPath)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Add-Row 'package.json BOM' $(if ($hasBom) { 'FAIL' } else { 'OK' }) $(if ($hasBom) { 'BOM present: DSH cannot parse it and skips the bundle' } else { 'clean' })

# 5. Policy file
try {
  $p = Get-Content $policy -Raw -Encoding UTF8 | ConvertFrom-Json
  $state = if ($p.enabled) { 'OK' } else { 'WARN' }
  Add-Row 'policy.json' $state "enabled=$($p.enabled)  R1=$($p.rules.protectDshHome.mode)  R2=$($p.rules.destructive.mode)  R3=$($p.rules.secrets.mode)"
} catch {
  Add-Row 'policy.json' 'FAIL' "cannot parse: $($_.Exception.Message)"
}

# 6. Audit directory writable
try {
  New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
  $probe = Join-Path $auditDir '.write-probe'
  Set-Content -Path $probe -Value 'ok' -NoNewline
  Remove-Item $probe -Force
  Add-Row 'Audit writable' 'OK' $auditDir
} catch {
  Add-Row 'Audit writable' 'FAIL' $_.Exception.Message
}

# 6. Script encoding: .ps1 needs a BOM to survive Windows PowerShell's ANSI decoding;
#    .bat/.cmd must stay ASCII because cmd.exe uses the OEM codepage.
$problems = @()
Get-ChildItem $here -Filter *.ps1 | ForEach-Object {
  $bytes = [IO.File]::ReadAllBytes($_.FullName)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if (-not $bom) { $problems += "$($_.Name): no BOM" }
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errs)
  if ($errs.Count -gt 0) { $problems += "$($_.Name): $($errs[0].Message)" }
}
Get-ChildItem $here -Include *.bat, *.cmd -File | ForEach-Object {
  $bytes = [IO.File]::ReadAllBytes($_.FullName)
  if (@($bytes | Where-Object { $_ -gt 127 }).Count -gt 0) { $problems += "$($_.Name): non-ASCII bytes" }
}
if ($problems.Count -eq 0) {
  Add-Row 'Script encoding' 'OK' 'ps1 BOM + parse ok, bat/cmd ASCII'
} else {
  Add-Row 'Script encoding' 'FAIL' ($problems -join '; ')
}

$rows | Format-Table -AutoSize -Wrap | Out-String | Write-Host

$failed = ($rows | Where-Object { $_.Result -eq 'FAIL' }).Count
$warned = ($rows | Where-Object { $_.Result -eq 'WARN' }).Count
if ($failed -eq 0 -and $warned -eq 0) {
  Write-Host 'Conclusion: gate is live.' -ForegroundColor Green
} elseif ($failed -eq 0) {
  Write-Host "Conclusion: gate looks live, $warned item(s) worth a look." -ForegroundColor Yellow
} else {
  Write-Host "Conclusion: $failed check(s) FAILED - do not rely on the gate." -ForegroundColor Red
}

if (-not $NoPause) { Read-Host 'Press Enter to exit' | Out-Null }
exit $failed
