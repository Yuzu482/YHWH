#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('yhwh-host-sync-test-' + [guid]::NewGuid().ToString('N'))
$fullFixture = [IO.Path]::GetFullPath($fixture)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not $fullFixture.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test fixture escaped temporary directory.' }
try {
  $codexRoot = Join-Path $fullFixture '.codex'
  $references = Join-Path $codexRoot 'agent-references'
  $pluginManifest = Join-Path $fullFixture 'plugins/pi-dispatch/.codex-plugin/plugin.json'
  New-Item -ItemType Directory -Force -Path $references, (Split-Path -Parent $pluginManifest) | Out-Null
  [IO.File]::WriteAllText((Join-Path $codexRoot 'AGENTS.md'), "# Local instructions`n`n<!-- PI-KETHER:BEGIN -->`nold`n<!-- PI-KETHER:END -->`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $references 'governance.md'), 'retired-rule', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $references 'local-only.md'), 'preserve-this', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($pluginManifest, '{"version":"old"}', [Text.UTF8Encoding]::new($false))
  & (Join-Path $PSScriptRoot 'Sync-HostWorkflow.ps1') -InstallHost -TargetHome $fullFixture | Out-Null
  $agents = [IO.File]::ReadAllText((Join-Path $codexRoot 'AGENTS.md'))
  if (-not $agents.Contains('# Local instructions') -or -not $agents.Contains('../.agents/skills/kether-governance/SKILL.md') -or -not $agents.Contains('agent-references/headless-cli.md')) { throw 'Managed AGENTS index was not correctly installed or local text was lost.' }
  if ([regex]::Matches($agents, [regex]::Escape('<!-- PI-KETHER:BEGIN -->')).Count -ne 1) { throw 'Managed policy block was duplicated.' }
  if (Test-Path -LiteralPath (Join-Path $references 'governance.md')) { throw 'Retired governance reference remained active.' }
  if ([IO.File]::ReadAllText((Join-Path $references 'local-only.md')) -cne 'preserve-this') { throw 'Unmanaged reference was modified.' }
  $sourceManifest = Join-Path $repo 'payload/pi-dispatch/.codex-plugin/plugin.json'
  if ((Get-FileHash -LiteralPath $pluginManifest).Hash -ne (Get-FileHash -LiteralPath $sourceManifest).Hash) { throw 'Installed plugin manifest differs from source.' }
  $backupBase = Join-Path $codexRoot 'backups/yhwh-host-workflow'
  $retiredBackups = @(Get-ChildItem -LiteralPath $backupBase -File -Recurse -Filter 'governance.md')
  if ($retiredBackups.Count -ne 1 -or [IO.File]::ReadAllText($retiredBackups[0].FullName) -cne 'retired-rule') { throw 'Retired governance reference was not backed up.' }
  & (Join-Path $PSScriptRoot 'Sync-HostWorkflow.ps1') -InstallHost -TargetHome $fullFixture | Out-Null
  $agents = [IO.File]::ReadAllText((Join-Path $codexRoot 'AGENTS.md'))
  if ([regex]::Matches($agents, [regex]::Escape('<!-- PI-KETHER:BEGIN -->')).Count -ne 1) { throw 'Second sync duplicated the managed policy block.' }
  Write-Host '[PASS] Host workflow sync preserves local text, retires stale policy, and copies source manifest'
} finally {
  if (Test-Path -LiteralPath $fullFixture) { Remove-Item -LiteralPath $fullFixture -Recurse -Force }
}
