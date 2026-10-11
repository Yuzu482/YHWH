#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repo ('.test/plugin-version-' + [guid]::NewGuid().ToString('N') + ' space')
$full = [IO.Path]::GetFullPath($fixture)
$allowed = [IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $full.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped repository .test.' }
function Invoke-FixtureGit([string]$directory, [string[]]$GitArguments) {
  $gitExecutable = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  & $gitExecutable -C $directory @GitArguments
  if ($LASTEXITCODE -ne 0) { throw "Git failed: $($GitArguments -join ' ')" }
}
try {
  $source = Join-Path $full 'source repo'
  $stage = Join-Path $full 'stage'
  $pluginRel = 'payload/pi-dispatch/.codex-plugin/plugin.json'
  New-Item -ItemType Directory -Force -Path (Join-Path $source (Split-Path $pluginRel)), $stage | Out-Null
  $pluginText = '{"version":"2.3.4"}'
  $portableText = '{"version":"0.14.0","components":{"piDispatch":"2.3.4"}}'
  [IO.File]::WriteAllText((Join-Path $source $pluginRel), $pluginText)
  [IO.File]::WriteAllText((Join-Path $source 'portable.manifest.json'), $portableText)
  Invoke-FixtureGit $source @('init','-q')
  Invoke-FixtureGit $source @('config','user.email','test@example.invalid')
  Invoke-FixtureGit $source @('config','user.name','Plugin Version Test')
  Invoke-FixtureGit $source @('config','commit.gpgsign','false')
  New-Item -ItemType Directory -Force -Path (Join-Path $full 'empty-hooks') | Out-Null
  Invoke-FixtureGit $source @('config','core.hooksPath', (Join-Path $full 'empty-hooks'))
  Invoke-FixtureGit $source @('add','.')
  Invoke-FixtureGit $source @('commit','-qm','fixture')
  function PrepareStage {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage (Split-Path $pluginRel)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $pluginRel) -Destination (Join-Path $stage $pluginRel) -Force
    Copy-Item -LiteralPath (Join-Path $source 'portable.manifest.json') -Destination $stage -Force
  }
  function Assert-Stamp([bool]$expectDirty) {
    PrepareStage
    & (Join-Path $PSScriptRoot 'Stamp-PluginVersion.ps1') -SourceRepositoryRoot $source -StagingPackageRoot $stage | Out-Null
    $p = Get-Content -LiteralPath (Join-Path $stage $pluginRel) -Raw | ConvertFrom-Json
    $m = Get-Content -LiteralPath (Join-Path $stage 'portable.manifest.json') -Raw | ConvertFrom-Json
    $proof = Get-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Raw | ConvertFrom-Json
    if ($p.version -cne $m.components.piDispatch -or $p.version -notmatch '^2\.3\.4\+[0-9a-f]{12}(?:\.dirty)?$') { throw 'Staged manifest versions do not agree.' }
    $head = (& (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source -C $source rev-parse HEAD).Trim()
    if ([bool]$proof.dirty -ne $expectDirty -or $proof.pluginVersion -cne $p.version -or $proof.sourceCommit -cne $head -or $proof.shortHash -cne $head.Substring(0,12) -or $p.version -notmatch [regex]::Escape($head.Substring(0,12))) { throw 'Staging provenance is inconsistent with fixture HEAD.' }
    if ($m.version -cne '0.14.0') { throw 'Portable product version changed.' }
  }
  Assert-Stamp $false
  function Assert-InstallationStage([bool]$expectDirty) {
    $copy=Join-Path $full ('install-source-'+[guid]::NewGuid().ToString('N'))
    $target=Join-Path $full ('install-target-'+[guid]::NewGuid().ToString('N'))
    $before=[IO.File]::ReadAllText((Join-Path $source $pluginRel))
    $actual=& (Join-Path $PSScriptRoot 'Stage-InstalledPlugin.ps1') -PackageRoot $source -Destination $copy
    Copy-Item -LiteralPath $actual -Destination $target -Recurse
    & node (Join-Path $repo 'payload/pi-dispatch/scripts/plugin-upgrade.mjs') record $actual $target
    if($LASTEXITCODE -ne 0){throw 'Stamped source installation baseline failed.'}
    $marker=Get-Content -LiteralPath (Join-Path $target '.yhwh-managed-files.json') -Raw | ConvertFrom-Json
    if($marker.files.'build-provenance.json' -cne (Get-FileHash -LiteralPath (Join-Path $target 'build-provenance.json')).Hash.ToLowerInvariant()){throw 'Installed provenance was not included in baseline.'}
    $proof=Get-Content -LiteralPath (Join-Path $target 'build-provenance.json') -Raw | ConvertFrom-Json
    if($proof.dirty -ne $expectDirty -or [IO.File]::ReadAllText((Join-Path $source $pluginRel)) -cne $before){throw 'Installation staging changed source identity.'}
    $collision='';try{& (Join-Path $PSScriptRoot 'Stage-InstalledPlugin.ps1') -PackageRoot $source -Destination $copy | Out-Null}catch{$collision=$_.Exception.Message}
    if($collision -cne 'Installation staging destination already exists.'){throw 'Staging overwrote an existing directory.'}
    [IO.File]::AppendAllText((Join-Path $target '.codex-plugin/plugin.json'),' ')
    & node (Join-Path $repo 'payload/pi-dispatch/scripts/plugin-upgrade.mjs') record $actual $target
    if($LASTEXITCODE -eq 0){throw 'Modified installed bytes were accepted.'}
  }
  Assert-InstallationStage $false
  [IO.File]::WriteAllText((Join-Path $source 'untracked.fixture'), 'ignored')
  Assert-Stamp $true
  Assert-InstallationStage $true
  Remove-Item -LiteralPath (Join-Path $source 'untracked.fixture')
  [IO.File]::AppendAllText((Join-Path $source $pluginRel), "`n")
  Assert-Stamp $true
  if ([IO.File]::ReadAllText((Join-Path $source $pluginRel)) -cne ($pluginText + "`n") -or [IO.File]::ReadAllText((Join-Path $source 'portable.manifest.json')) -cne $portableText) { throw 'Source manifests were modified.' }
  $installed = Join-Path $full 'installed plugin'
  New-Item -ItemType Directory -Force -Path (Join-Path $installed '.codex-plugin') | Out-Null
  Copy-Item -LiteralPath (Join-Path $source $pluginRel) -Destination (Join-Path $installed '.codex-plugin/plugin.json')
  & (Join-Path $PSScriptRoot 'Set-InstalledPluginVersion.ps1') -PackageRoot $source -PluginRoot $installed | Out-Null
  $sourceIdentity = & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $source
  $sourceInstall = Get-Content -LiteralPath (Join-Path $installed '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
  if ($sourceInstall.version -cne $sourceIdentity.pluginVersion -or -not $sourceInstall.version.EndsWith('.dirty')) { throw 'Source install lost dirty commit identity.' }
  # No .git: packaged installs use validated build provenance, not a static source version.
  & (Join-Path $PSScriptRoot 'Set-InstalledPluginVersion.ps1') -PackageRoot $stage -PluginRoot $installed | Out-Null
  $packaged = & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $stage
  if ($packaged.pluginVersion -cne $sourceIdentity.pluginVersion) { throw 'Packaged install lost build identity.' }
  $proof = Get-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Raw | ConvertFrom-Json
  $proof.shortHash = '000000000000'
  $proof | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Encoding utf8NoBOM
  $badProof = ''
  try { & (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $stage | Out-Null } catch { $badProof = $_.Exception.Message }
  if ($badProof -ne 'Packaged plugin provenance is missing or inconsistent.') { throw 'Corrupt packaged provenance was accepted.' }
  $empty = Join-Path $full 'no commit'
  New-Item -ItemType Directory -Force -Path $empty | Out-Null
  $previousConfig = $env:GIT_CONFIG_GLOBAL
  $previousNoSystem = $env:GIT_CONFIG_NOSYSTEM
  $env:GIT_CONFIG_GLOBAL = Join-Path $full 'missing-global-config'
  $env:GIT_CONFIG_NOSYSTEM = '1'
  try {
    Invoke-FixtureGit $empty @('init','-q')
    New-Item -ItemType Directory -Force -Path (Join-Path $empty (Split-Path $pluginRel)) | Out-Null
    [IO.File]::WriteAllText((Join-Path $empty $pluginRel), $pluginText)
    PrepareStage
    $proofPath = Join-Path $stage 'build-provenance.json'
    if (Test-Path -LiteralPath $proofPath) { Remove-Item -LiteralPath $proofPath -Force }
    $beforePlugin = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $stage $pluginRel)))
    $beforePortable = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $stage 'portable.manifest.json')))
    $message = ''
    try { & (Join-Path $PSScriptRoot 'Stamp-PluginVersion.ps1') -SourceRepositoryRoot $empty -StagingPackageRoot $stage | Out-Null } catch { $message = $_.Exception.Message }
    if (-not $message.StartsWith('Git command failed:', [StringComparison]::Ordinal) -or !$message.Contains('Needed a single revision')) { throw "Unexpected missing-commit failure: $message" }
    if (Test-Path -LiteralPath $proofPath) { throw 'Missing commit wrote staging provenance.' }
    if ($beforePlugin -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $stage $pluginRel))) -or $beforePortable -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $stage 'portable.manifest.json')))) { throw 'Missing commit modified staged manifests.' }
    Write-Host "[PASS] Missing-commit diagnostic: $message"
  } finally {
    $env:GIT_CONFIG_GLOBAL = $previousConfig
    $env:GIT_CONFIG_NOSYSTEM = $previousNoSystem
  }
  Write-Host '[PASS] Plugin stamping clean/dirty identity, path spaces, source preservation, and missing commit'
} finally {
  if (Test-Path -LiteralPath $full) { Remove-Item -LiteralPath $full -Recurse -Force }
}
