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
  $hashManifestPath = Join-Path $codexRoot 'yhwh-managed-hashes.json'
  if (-not (Test-Path -LiteralPath $hashManifestPath -PathType Leaf)) { throw 'Managed hash manifest was not created.' }
  $hashManifest = Get-Content -LiteralPath $hashManifestPath -Raw | ConvertFrom-Json
  if ($hashManifest.schemaVersion -ne 1) { throw 'Managed hash manifest schema version is incorrect.' }
  $managedBlock = [regex]::Match($agents, '(?s)<!-- PI-KETHER:BEGIN -->.*?<!-- PI-KETHER:END -->').Value
  $blockHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($managedBlock))).ToLowerInvariant()
  if ($hashManifest.files.'.codex/AGENTS.md#PI-KETHER' -cne $blockHash) { throw 'Managed AGENTS block hash is incorrect.' }
  $referenceKey = '.codex/agent-references/headless-cli.md'
  if ($hashManifest.files.$referenceKey -cne (Get-FileHash -LiteralPath (Join-Path $references 'headless-cli.md')).Hash.ToLowerInvariant()) { throw 'Managed reference hash is incorrect.' }
  $piKey = 'plugins/pi-dispatch/skills/pi-dispatch/SKILL.md'
  if ($hashManifest.files.$piKey -cne (Get-FileHash -LiteralPath (Join-Path $fullFixture $piKey)).Hash.ToLowerInvariant()) { throw 'Pi dispatch skill hash is incorrect.' }
  $manifestBeforeSecondSync = [IO.File]::ReadAllText($hashManifestPath)
  $backupBase = Join-Path $codexRoot 'backups/yhwh-host-workflow'
  $retiredBackups = @(Get-ChildItem -LiteralPath $backupBase -File -Recurse -Filter 'governance.md')
  if ($retiredBackups.Count -ne 1 -or [IO.File]::ReadAllText($retiredBackups[0].FullName) -cne 'retired-rule') { throw 'Retired governance reference was not backed up.' }
  & (Join-Path $PSScriptRoot 'Sync-HostWorkflow.ps1') -InstallHost -TargetHome $fullFixture | Out-Null
  $agents = [IO.File]::ReadAllText((Join-Path $codexRoot 'AGENTS.md'))
  if ([regex]::Matches($agents, [regex]::Escape('<!-- PI-KETHER:BEGIN -->')).Count -ne 1) { throw 'Second sync duplicated the managed policy block.' }
  if ([IO.File]::ReadAllText($hashManifestPath) -cne $manifestBeforeSecondSync) { throw 'Managed hash manifest changed across repeated sync.' }
  $manifestBackups = @(Get-ChildItem -LiteralPath $backupBase -File -Recurse -Filter 'yhwh-managed-hashes.json')
  if ($manifestBackups.Count -ne 1) { throw 'Previous managed hash manifest was not archived.' }
  Write-Host '[PASS] Host workflow sync preserves local text, retires stale policy, and copies source manifest'
} finally {
  if (Test-Path -LiteralPath $fullFixture) { Remove-Item -LiteralPath $fullFixture -Recurse -Force }
}
