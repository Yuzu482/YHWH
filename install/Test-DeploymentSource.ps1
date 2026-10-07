#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path $repo ('.test/deployment source '+[guid]::NewGuid().ToString('N'))
$allowed=[IO.Path]::GetFullPath((Join-Path $repo '.test'))+[IO.Path]::DirectorySeparatorChar
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture escaped .test.'}
$checks=0
function Check([bool]$ok,[string]$label){if(-not $ok){throw "FAIL: $label"};$script:checks++;Write-Output "PASS: $label"}
function Git([string]$cwd,[string[]]$arguments){& git.exe -c "safe.directory=$cwd" -C $cwd @arguments 2>&1 | Out-Null;if($LASTEXITCODE -ne 0){throw 'Fixture Git failed.'}}
function Reject([scriptblock]$action,[string]$fragment){$failed=$false;try{& $action | Out-Null}catch{$failed=$_.Exception.Message.Contains($fragment);if(-not $failed){throw}};Check $failed "reject $fragment"}
try {
  $source=Join-Path $fixture 'source';$remote=Join-Path $fixture 'remote.git';$target=Join-Path $fixture 'target'
  New-Item -ItemType Directory -Force -Path (Join-Path $source 'install'),(Join-Path $source 'payload/pi-dispatch/.codex-plugin') | Out-Null
  foreach($p in @('Workflow.ps1','install/Assert-DeploymentSource.ps1','install/Get-PluginBuildIdentity.ps1')){Copy-Item -LiteralPath (Join-Path $repo $p) -Destination (Join-Path $source $p)}
  [IO.File]::WriteAllText((Join-Path $source 'payload/pi-dispatch/.codex-plugin/plugin.json'),'{"version":"1.0.0"}')
  # Inert installer fixture: verifies front-end admission and records without touching services, policies or WSL.
  [IO.File]::WriteAllText((Join-Path $source 'install/Install-PiKether.ps1'),'param($ConfigFile,$TargetHome,[switch]$PlanOnly,[switch]$SkipWsl,[switch]$SkipTunnel,[switch]$SkipCodexRegistration) if(-not $PlanOnly){[IO.File]::WriteAllText((Join-Path $TargetHome "installed-fixture"),"installed") }')
  Git $source @('init','-q');Git $source @('config','user.name','Deployment Fixture');Git $source @('config','user.email','fixture@example.invalid');Git $source @('config','commit.gpgsign','false')
  New-Item -ItemType Directory -Path (Join-Path $fixture 'empty-hooks') | Out-Null
  Git $source @('config','core.hooksPath',(Join-Path $fixture 'empty-hooks'))
  Git $source @('add','.');Git $source @('commit','-qm','fixture')
  Git $fixture @('init','--bare','-q',$remote);Git $source @('remote','add','origin',$remote)
  $workflow=Join-Path $source 'Workflow.ps1';$guard=Join-Path $source 'install/Assert-DeploymentSource.ps1'
  Reject {& $workflow -Action Install -TargetHome $target -SkipWsl -SkipTunnel -SkipCodexRegistration} 'HEAD is not'
  Check (-not (Test-Path -LiteralPath $target)) 'unpublished HEAD does not mutate target'
  Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  $admission=& $guard -PackageRoot $source
  Check (-not $admission.dirty -and $admission.remoteRefs -contains 'refs/heads/fixture') 'clean pushed source admitted'
  [IO.File]::WriteAllText((Join-Path $source 'untracked'), 'dirty')
  Reject {& $workflow -Action Install -TargetHome $target} 'Dirty worktree'
  Reject {& $guard -PackageRoot $source -AllowDirty} 'DirtyReason'
  Reject {& $guard -PackageRoot $source -AllowDirty -DirtyReason "bad`nreason"} 'DirtyReason'
  Check (-not (Test-Path -LiteralPath $target)) 'dirty rejections do not mutate target'
  & $workflow -Action Install -TargetHome $target -AllowDirty -DirtyReason 'explicit synthetic acceptance fixture' -SkipWsl -SkipTunnel -SkipCodexRegistration
  $records=@(Get-ChildItem -LiteralPath (Join-Path $target '.local/state/pi-kether/installation-records') -Filter '*.json')
  $record=Get-Content -LiteralPath $records[0].FullName -Raw | ConvertFrom-Json
  Check ($records.Count -eq 1 -and $record.status -eq 'completed' -and $record.admission.dirty -and $record.admission.allowDirty -and $record.admission.dirtyReason -eq 'explicit synthetic acceptance fixture') 'explicit dirty allowance and reason persisted'
  Remove-Item -LiteralPath (Join-Path $source 'untracked')
  [IO.File]::AppendAllText((Join-Path $source 'Workflow.ps1'),"`n# tracked fixture change`n")
  Reject {& $guard -PackageRoot $source} 'Dirty worktree'
  Git $source @('add','Workflow.ps1');Git $source @('commit','-qm','unpublished change')
  Reject {& $guard -PackageRoot $source -AllowDirty -DirtyReason 'must not bypass unpublished HEAD'} 'HEAD is not'
  Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  Check (-not (& $guard -PackageRoot $source).dirty) 'newly pushed clean HEAD admitted'
  $cleanTarget=Join-Path $fixture 'clean-target'
  & $workflow -Action Install -TargetHome $cleanTarget -SkipWsl -SkipTunnel -SkipCodexRegistration
  $cleanFile=Get-ChildItem -LiteralPath (Join-Path $cleanTarget '.local/state/pi-kether/installation-records') -Filter '*.json'
  $cleanRecord=Get-Content -LiteralPath $cleanFile.FullName -Raw | ConvertFrom-Json
  Check ($cleanRecord.status -eq 'completed' -and -not $cleanRecord.admission.dirty -and -not $cleanRecord.admission.allowDirty -and $null -eq $cleanRecord.admission.dirtyReason) 'clean Workflow Install records pushed source without dirty exemption'
  [IO.File]::AppendAllText((Join-Path $source 'install/Install-PiKether.ps1'),"`nthrow 'fixture installer failure'`n")
  $failedTarget=Join-Path $fixture 'failed-target'
  Reject {& $workflow -Action Install -TargetHome $failedTarget -AllowDirty -DirtyReason 'synthetic failure record' -SkipWsl -SkipTunnel -SkipCodexRegistration} 'fixture installer failure'
  $failedFile=Get-ChildItem -LiteralPath (Join-Path $failedTarget '.local/state/pi-kether/installation-records') -Filter '*.json'
  $failedRecord=Get-Content -LiteralPath $failedFile.FullName -Raw | ConvertFrom-Json
  Check ($failedRecord.status -eq 'failed' -and $failedRecord.admission.dirtyReason -eq 'synthetic failure record') 'installer failure preserved without false completion'
  Git $source @('restore','install/Install-PiKether.ps1')
  $older=& git.exe -C $source rev-parse HEAD
  [IO.File]::WriteAllText((Join-Path $source 'later'), 'later commit')
  Git $source @('add','later');Git $source @('commit','-qm','later remote tip');Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  Git $source @('checkout','--detach','-q',$older)
  Check (-not (& $guard -PackageRoot $source).dirty) 'pushed ancestor accepted against freshly advertised descendant'
  Git $source @('remote','set-url','origin',(Join-Path $fixture 'missing-remote.git'))
  Reject {& $guard -PackageRoot $source} 'Remote HEAD verification failed'
  Write-Output "PASS: $checks deployment admission checks; real Git, inert installer, no production deployment"
} finally {if(Test-Path -LiteralPath $fixture){$resolved=[IO.Path]::GetFullPath($fixture);if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup.'};Remove-Item -LiteralPath $resolved -Recurse -Force}}
