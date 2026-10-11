#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot,[switch]$AllowDirty,[string]$DirtyReason,[switch]$PreMergeDeploy,[string]$Reason)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'DeploymentMainPolicy.ps1')
$root=[IO.Path]::GetFullPath($PackageRoot)
if(-not (Test-Path -LiteralPath (Join-Path $root '.git'))){throw 'Workflow Install requires a Git checkout to verify its pushed HEAD.'}
if($PreMergeDeploy -and ([string]::IsNullOrWhiteSpace($Reason) -or $Reason.Length -gt 512 -or [Text.Encoding]::UTF8.GetByteCount($Reason) -gt 2048 -or $Reason -match '[\x00-\x1f\x7f-\x9f\u2028\u2029]')){throw 'PreMergeDeploy requires a nonempty single-line Reason of at most 512 characters and 2048 UTF-8 bytes.'}
if(-not $PreMergeDeploy -and -not [string]::IsNullOrEmpty($Reason)){throw 'Reason requires -PreMergeDeploy.'}
$identity=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $root
function Get-AdmissionSourceState {
  $head=Invoke-DeploymentGit -Repository $root -GitArguments @('rev-parse','--verify','HEAD^{commit}')
  $status=Invoke-DeploymentGit -Repository $root -GitArguments @('status','--porcelain','--untracked-files=all')
  $branch=Invoke-DeploymentGit -Repository $root -GitArguments @('branch','--show-current')
  if(-not (Test-DeploymentProcessSuccess $head) -or -not (Test-DeploymentProcessSuccess $status) -or -not (Test-DeploymentProcessSuccess $branch)){throw 'Source identity verification failed.'}
  return [pscustomobject]@{head=$head.stdout.Trim();dirty=(-not [string]::IsNullOrWhiteSpace($status.stdout));branch=$branch.stdout.Trim();detached=[string]::IsNullOrWhiteSpace($branch.stdout)}
}
$initial=Get-AdmissionSourceState
if($initial.head -cne $identity.sourceCommit -or $initial.dirty -ne $identity.dirty){throw 'Source identity environment mismatch.'}
if($identity.dirty -and -not $AllowDirty){throw 'Dirty worktree: commit changes before Install, or explicitly use -AllowDirty -DirtyReason.'}
if($AllowDirty -and ([string]::IsNullOrWhiteSpace($DirtyReason) -or $DirtyReason.Length -gt 512 -or $DirtyReason -match '[\x00-\x1f\x7f]')){throw 'AllowDirty requires a nonempty single-line DirtyReason of at most 512 characters.'}
$remote=Invoke-DeploymentGit -Repository $root -GitArguments @('ls-remote','--heads','origin')
if(-not (Test-DeploymentProcessSuccess $remote)){throw "Remote HEAD verification failed (exit $($remote.status); timeout=$($remote.timedOut); outputLimit=$($remote.outputLimit))."}
$advertised=@($remote.stdout -split '\r?\n' | Where-Object {$_ -cmatch '^[a-f0-9]{40,64}\s+refs/heads/[^\s]+$'})
$matching=@($advertised | Where-Object {($_ -split '\s+',2)[0] -ceq $identity.sourceCommit})
if($matching.Count -eq 0) {
  # Pushed ancestry must bind a local containing ref to the exact freshly advertised tip.
  $tracked=Invoke-DeploymentGit -Repository $root -GitArguments @('for-each-ref',('--contains='+$identity.sourceCommit),'--format=%(objectname) %(refname)','refs/remotes/origin/')
  if(-not (Test-DeploymentProcessSuccess $tracked)){throw 'Remote ancestry verification failed.'}
  $known=@($tracked.stdout -split '\r?\n' | ForEach-Object {if($_ -cmatch '^([a-f0-9]{40,64}) refs/remotes/origin/(.+)$'){$Matches[1]+[char]9+'refs/heads/'+$Matches[2]}})
  $matching=@($advertised | Where-Object {($_ -replace '\s+',([string][char]9)) -cin $known})
}
if($matching.Count -eq 0){throw 'HEAD is not proven pushed to an advertised origin branch; push or refresh remote history before Install.'}
$main=Get-DeploymentMainState -Repository $root -Commit $identity.sourceCommit -AdvertisedHeads $advertised
if($main.relation -eq 'unknown'){throw "Main ancestry is unknown: $($main.reason); fetch origin/main explicitly and retry."}
if($main.relation -ne 'in-main' -and -not $PreMergeDeploy){throw 'HEAD is not in origin/main; merge through PR/CI first, or explicitly use -PreMergeDeploy -Reason.'}
$ci=if($PreMergeDeploy){Get-DeploymentCiEvidence -Repository $root -Commit $identity.sourceCommit}else{$null}
$current=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $root
$final=Get-AdmissionSourceState
if($current.sourceCommit -cne $identity.sourceCommit -or $current.dirty -ne $identity.dirty -or $final.head -cne $initial.head -or $final.dirty -ne $initial.dirty -or $final.branch -cne $initial.branch -or $final.detached -ne $initial.detached){throw 'Source changed during deployment admission.'}
return [pscustomobject][ordered]@{sourceCommit=$identity.sourceCommit;pluginVersion=$identity.pluginVersion;dirty=$identity.dirty;allowDirty=[bool]$AllowDirty;dirtyReason=$(if($AllowDirty){$DirtyReason.Trim()}else{$null});remote='origin';remoteRefs=@($matching | ForEach-Object {($_ -split '\s+',2)[1]});remoteVerifiedAt=$main.verifiedAt;mainPolicy=[ordered]@{schemaVersion=1;relation=$main.relation;mainCommit=$main.mainCommit;verifiedAt=$main.verifiedAt;branch=$(if($initial.detached){'(detached)'}else{$initial.branch});detached=$initial.detached;preMergeDeploy=[bool]$PreMergeDeploy;reason=$(if($PreMergeDeploy){$Reason.Trim()}else{$null});ci=$ci}}
