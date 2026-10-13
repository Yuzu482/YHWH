#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repo ('.test/plugin-version-' + [guid]::NewGuid().ToString('N') + ' space')
$full = [IO.Path]::GetFullPath($fixture)
$allowed = [IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $full.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture escaped repository .test.' }
$installerPath=Join-Path $repo 'install/Install-PiKether.ps1'
$installerText=[IO.File]::ReadAllText($installerPath)
$installerAst=[Management.Automation.Language.Parser]::ParseFile($installerPath,[ref]$null,[ref]$null)
$recordCommands=@($installerAst.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -match 'plugin-upgrade\.mjs.*\brecord\s+\$installationSource\s+\$pluginTarget'},$true))
$selfTestCommands=@($installerAst.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -match 'Test-PiKether\.ps1.*-Installed'},$true))
if($recordCommands.Count -ne 1 -or $selfTestCommands.Count -ne 1 -or $recordCommands[0].Extent.StartOffset -ge $selfTestCommands[0].Extent.StartOffset){throw 'Installation baseline must be recorded before the installed selftest.'}
$statements=@($installerAst.EndBlock.Statements)
$recordIndex=-1
for($i=0;$i -lt $statements.Count;$i++){if($statements[$i].Extent.StartOffset -eq $recordCommands[0].Extent.StartOffset){$recordIndex=$i;break}}
if($recordIndex -lt 0 -or $statements[$recordIndex+2].Extent.StartOffset -ne $selfTestCommands[0].Extent.StartOffset){throw 'Record and selftest must be consecutive guarded completion steps.'}
$recordGuard=$statements[$recordIndex+1];$selfTestGuard=$statements[$recordIndex+3]
foreach($guard in @($recordGuard,$selfTestGuard)){
  if($guard -isnot [Management.Automation.Language.IfStatementAst] -or $guard.Extent.Text -notmatch '\$LASTEXITCODE\s+-ne\s+0' -or -not @($guard.FindAll({param($n) $n -is [Management.Automation.Language.ThrowStatementAst]},$true)).Count){throw 'Completion command failure must throw before continuing.'}
}
$completionSequence=[scriptblock]::Create($installerText.Substring($recordCommands[0].Extent.StartOffset,$selfTestGuard.Extent.EndOffset-$recordCommands[0].Extent.StartOffset))
$selfTestAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'install/Test-PiKether.ps1'),[ref]$null,[ref]$null)
if(@($selfTestAst.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.Extent.Text -match 'install-integrity\.mjs.*--require-installed'},$true)).Count -ne 1){throw 'The actual installed selftest must require the managed manifest.'}
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
  New-Item -ItemType Directory -Path (Join-Path $source 'payload/pi-dispatch/scripts') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo 'payload/pi-dispatch/scripts/plugin-upgrade.mjs') -Destination (Join-Path $source 'payload/pi-dispatch/scripts/plugin-upgrade.mjs')
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
    $nodePath=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $checker=Join-Path $repo 'payload/pi-dispatch/scripts/install-integrity.mjs'
    $missing=& $nodePath $checker --plugin-root $target --require-installed | ConvertFrom-Json
    if($LASTEXITCODE -ne 1 -or $missing.code -ne 'PI_INSTALL_DRIFT' -or $missing.drift[0].reason -ne 'missing-manifest'){throw 'Missing installation manifest was not rejected.'}
    $packageRoot=Join-Path $full ('completion-package-'+[guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path (Join-Path $packageRoot 'install') -Force | Out-Null
    $selfTestSentinel=Join-Path $full ('selftest-sentinel-'+[guid]::NewGuid().ToString('N'))
    # Exercise the actual production completion sequence. Only the broader host
    # selftest is adapted; this adapter runs its real integrity checker/flag.
    [IO.File]::WriteAllText((Join-Path $packageRoot 'install/Test-PiKether.ps1'),@'
param([switch]$Installed,[string]$TargetHome,[string]$WslDistro,[string[]]$Hosts,[switch]$SkipWsl)
$result=& $nodePath $checker --plugin-root $pluginTarget --require-installed | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $result.state -ne 'verified'){throw 'Fixture installed integrity selftest failed.'}
[IO.File]::AppendAllText($selfTestSentinel,"selftest`n")
'@)
    $pluginTarget=$target;$installationSource=$actual;$TargetHome=$full;$WslDistro='synthetic';$Hosts=@('generic');$installWsl=$false
    & $completionSequence
    if(-not (Test-Path -LiteralPath $selfTestSentinel)){throw 'Ordered completion never reached the verified selftest.'}
    $verified=& $nodePath $checker --plugin-root $target --require-installed | ConvertFrom-Json
    if($LASTEXITCODE -ne 0 -or $verified.state -ne 'verified'){throw 'Recorded installation did not verify.'}
    $marker=Get-Content -LiteralPath (Join-Path $target '.yhwh-managed-files.json') -Raw | ConvertFrom-Json
    if($marker.files.'build-provenance.json' -cne (Get-FileHash -LiteralPath (Join-Path $target 'build-provenance.json')).Hash.ToLowerInvariant()){throw 'Installed provenance was not included in baseline.'}
    $proof=Get-Content -LiteralPath (Join-Path $target 'build-provenance.json') -Raw | ConvertFrom-Json
    if($proof.dirty -ne $expectDirty -or [IO.File]::ReadAllText((Join-Path $source $pluginRel)) -cne $before){throw 'Installation staging changed source identity.'}
    $collision='';try{& (Join-Path $PSScriptRoot 'Stage-InstalledPlugin.ps1') -PackageRoot $source -Destination $copy | Out-Null}catch{$collision=$_.Exception.Message}
    if($collision -cne 'Installation staging destination already exists.'){throw 'Staging overwrote an existing directory.'}
    $markerBefore=[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $target '.yhwh-managed-files.json')))
    $sentinelBefore=[IO.File]::ReadAllText($selfTestSentinel)
    [IO.File]::AppendAllText((Join-Path $target '.codex-plugin/plugin.json'),' ')
    $drift=& $nodePath $checker --plugin-root $target --require-installed | ConvertFrom-Json
    if($LASTEXITCODE -ne 1 -or $drift.code -ne 'PI_INSTALL_DRIFT'){throw 'Altered installed bytes did not report drift.'}
    $failed='';try{& $completionSequence}catch{$failed=$_.Exception.Message}
    if($failed -cne 'Managed installation baseline could not be recorded.'){throw 'Modified installed bytes were not rejected before the selftest.'}
    if([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $target '.yhwh-managed-files.json'))) -cne $markerBefore -or [IO.File]::ReadAllText($selfTestSentinel) -cne $sentinelBefore){throw 'Failed record changed the manifest or reached the selftest.'}
    if([IO.File]::ReadAllText((Join-Path $source $pluginRel)) -cne $before){throw 'Completion fixture changed source bytes.'}
    Write-Host '[PASS] Actual installer completion: missing manifest -> record -> verified selftest; drift rejects re-record before selftest'
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
