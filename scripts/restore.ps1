<#
  Restore session logs from an encrypted snapshot.

  Usage:
    .\restore.ps1 -Manifest "$env:USERPROFILE\.dsh\guardrails\vault\manifests\2026-11-13_004012.json"
    .\restore.ps1 -Manifest <manifest> -Target D:\restore
    .\restore.ps1 -Manifest <manifest> -Only "ws\session-xxx\session.v4.jsonl.zstd"
    .\restore.ps1 -List                                      # list snapshots

  Notes:
    - Blobs are DPAPI-encrypted for the current Windows user; another account
      or a rebuilt machine cannot decrypt them.
    - Restoring into ~/.dsh/sessions while DSH is running will be overwritten
      by the live process. Close DSH first.
#>
param(
  [string]$Manifest,
  [string]$Target,
  [string]$Only,
  [switch]$List
)

$ErrorActionPreference = 'Stop'

# The vault is derived from the manifest location: <vault>\manifests\<stamp>.json
$manifestDir = Split-Path -Parent (Resolve-Path $Manifest -ErrorAction SilentlyContinue)
if (-not $manifestDir) { $manifestDir = Split-Path -Parent $Manifest }
if ((Split-Path -Leaf $manifestDir) -eq 'manifests') {
  $vault = Split-Path -Parent $manifestDir
} else {
  $vault = Join-Path $env:USERPROFILE '.dsh\guardrails\vault'
}
$manifestsDir = Join-Path $vault 'manifests'
$blobsDir = Join-Path $vault 'blobs'

if ($List -or -not $Manifest) {
  if (-not (Test-Path $manifestsDir)) { Write-Host 'No snapshots yet.'; exit 0 }
  Get-ChildItem $manifestsDir -Filter *.json | Sort-Object Name |
    Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
  Write-Host "Vault: $vault"
  exit 0
}

if (-not (Test-Path $Manifest)) { throw "Manifest not found: $Manifest" }
if (-not $Target) { $Target = Join-Path $env:TEMP ("dsh-restore-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Add-Type -AssemblyName System.Security
$data = Get-Content $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json

$restored = 0
$failed = 0
foreach ($entry in $data.files) {
  if ($Only -and $entry.path -ne $Only) { continue }

  $blob = Join-Path $blobsDir ("{0}.dpapi" -f $entry.sha256)
  if (-not (Test-Path $blob)) {
    Write-Warning "Missing blob for $($entry.path)"
    $failed += 1
    continue
  }

  $outPath = Join-Path $Target ($entry.path -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null

  try {
    $enc = [System.IO.File]::ReadAllBytes($blob)
    $plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $enc,
      $null,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.IO.File]::WriteAllBytes($outPath, $plain)

    $hash = (Get-FileHash -Path $outPath -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $entry.sha256) {
      Write-Warning "Hash mismatch after restore: $($entry.path)"
      $failed += 1
    } else {
      $restored += 1
    }
  } catch {
    Write-Warning "Failed to restore $($entry.path): $($_.Exception.Message)"
    $failed += 1
  }
}

Write-Host ""
Write-Host "Snapshot : $Manifest"
Write-Host "Target   : $Target"
Write-Host "Restored : $restored files, $failed failed"
if ($failed -eq 0) { Write-Host 'All restored files match their recorded SHA-256.' -ForegroundColor Green }
