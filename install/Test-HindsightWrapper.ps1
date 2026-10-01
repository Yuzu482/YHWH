#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('yhwh-hindsight-test-' + [guid]::NewGuid().ToString('N'))
$fullFixture = [IO.Path]::GetFullPath($fixture)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $fullFixture.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test fixture escaped temporary directory.' }
$installer = Join-Path $PSScriptRoot 'Apply-HindsightWrapper.ps1'
$skillDir = Join-Path $fullFixture '.agents/skills/hindsight-coding-agent'
$skill = Join-Path $skillDir 'SKILL.md'
$references = Join-Path $skillDir 'references'
$backupBase = Join-Path $fullFixture '.codex/backups/yhwh-hindsight'
$body = @'
---
name: hindsight-coding-agent
---

# Hindsight Coding-Agent Memory
Overview body.

## Install / update
Install body.

## Configuration
Configuration body.

### Opt-in only
Opt-in body.

### Reference
Reference body.

### Bank resolution
Bank body.

## Diagnostics & logging
Diagnostic body.
'@
try {
  New-Item -ItemType Directory -Force -Path $fullFixture | Out-Null
  & $installer -TargetHome $fullFixture
  if (Test-Path -LiteralPath $backupBase) { throw 'Absent Hindsight skill created an unnecessary backup.' }
  New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
  [IO.File]::WriteAllText($skill, $body, [Text.UTF8Encoding]::new($false))
  & $installer -TargetHome $fullFixture
  & $installer -TargetHome $fullFixture -Check
  $expected = @('overview.md','installation.md','configuration-basics.md','configuration-opt-in.md','configuration-reference.md','bank-resolution.md','diagnostics.md')
  foreach ($name in $expected) {
    if (-not (Test-Path -LiteralPath (Join-Path $references $name) -PathType Leaf)) { throw "Missing reference: $name" }
  }
  $reconstructed = ($expected | ForEach-Object { [IO.File]::ReadAllText((Join-Path $references $_)) }) -join ''
  $normalized = $body.Replace("`r`n", "`n")
  if ($reconstructed -cne $normalized.Substring($normalized.IndexOf('# Hindsight Coding-Agent Memory'))) { throw 'Split references do not preserve the upstream body.' }
  $backupsBefore = @(Get-ChildItem -LiteralPath $backupBase -Directory).Count
  & $installer -TargetHome $fullFixture
  if (@(Get-ChildItem -LiteralPath $backupBase -Directory).Count -ne $backupsBefore) { throw 'Idempotent reapply created a backup.' }
  [IO.File]::WriteAllText($skill, ($body + "`nUpdated upstream."), [Text.UTF8Encoding]::new($false))
  & $installer -TargetHome $fullFixture
  if (-not ([IO.File]::ReadAllText((Join-Path $references 'diagnostics.md')).Contains('Updated upstream.'))) { throw 'Reinstall did not refresh generated references.' }
  $backupsBefore = @(Get-ChildItem -LiteralPath $backupBase -Directory).Count
  $malformed = "---`nname: hindsight-coding-agent`n---`n# Changed upstream layout`n"
  [IO.File]::WriteAllText($skill, $malformed, [Text.UTF8Encoding]::new($false))
  $rejected = $false
  try { & $installer -TargetHome $fullFixture | Out-Null } catch { $rejected = $true }
  if (-not $rejected -or [IO.File]::ReadAllText($skill) -cne $malformed -or @(Get-ChildItem -LiteralPath $backupBase -Directory).Count -ne $backupsBefore) { throw 'Changed upstream layout was not rejected without mutation.' }
  Write-Host '[PASS] Hindsight wrapper split, idempotence, reinstall, and fail-closed layout checks'
} finally {
  if (Test-Path -LiteralPath $fullFixture) { Remove-Item -LiteralPath $fullFixture -Recurse -Force }
}
