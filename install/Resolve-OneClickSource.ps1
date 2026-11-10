#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$CheckoutPath,
  [Parameter(Mandatory)][string]$SourceUrl,
  [switch]$PreMergeDeploy,
  [string]$Reason
)
$ErrorActionPreference='Stop'
$package=[IO.Path]::GetFullPath($PackageRoot)
$checkout=[IO.Path]::GetFullPath($CheckoutPath)
$parent=Split-Path -Parent $checkout
if(-not (Test-Path -LiteralPath $parent -PathType Container) -or (Test-Path -LiteralPath $checkout)){throw 'Source checkout requires an existing parent and a new destination.'}
$cursor=$parent
while($cursor){
  if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Source checkout parent contains a link or junction.'}
  $cursor=Split-Path -Parent $cursor
}
$uri=$null
$https=[Uri]::TryCreate($SourceUrl,[UriKind]::Absolute,[ref]$uri) -and $uri.Scheme -ceq 'https' -and -not $uri.UserInfo -and -not $uri.Query -and -not $uri.Fragment -and $SourceUrl -cmatch '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/[A-Za-z0-9._/-]+$'
$local=[IO.Path]::IsPathRooted($SourceUrl) -and (Test-Path -LiteralPath $SourceUrl -PathType Container)
if(-not $https -and -not $local){throw 'Source origin must be a credential-free HTTPS URL or a local repository.'}
$identity=& (Join-Path $package 'install/Get-PluginBuildIdentity.ps1') -PackageRoot $package
if($identity.dirty){throw 'A package built from dirty source cannot establish an exact source checkout.'}
. (Join-Path $package 'install/DeploymentMainPolicy.ps1')
$git=(Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$filePolicy=if($local){'always'}else{'never'}
$options=@('-c','protocol.allow=never','-c','protocol.https.allow=always','-c',('protocol.file.allow='+$filePolicy),'-c','protocol.ext.allow=never','-c','core.hooksPath=NUL')
$clone=Invoke-DeploymentProcess -FilePath $git -Arguments ($options+@('clone','--no-checkout','--config','core.hooksPath=NUL','--',$SourceUrl,$checkout)) -WorkingDirectory $parent -TimeoutMs 300000
if(-not (Test-DeploymentProcessSuccess $clone)){throw "Source checkout clone failed (exit $($clone.status); timeout=$($clone.timedOut); outputLimit=$($clone.outputLimit))."}
$origin=Invoke-DeploymentGit -Repository $checkout -GitArguments @('remote','get-url','origin')
if(-not (Test-DeploymentProcessSuccess $origin) -or ($https -and $origin.stdout.Trim() -cne $SourceUrl)){throw 'Source origin changed during checkout.'}
$switch=Invoke-DeploymentProcess -FilePath $git -Arguments ($options+@('-C',$checkout,'checkout','--detach',$identity.sourceCommit)) -WorkingDirectory $parent -TimeoutMs 300000
if(-not (Test-DeploymentProcessSuccess $switch)){throw "Source commit checkout failed (exit $($switch.status); timeout=$($switch.timedOut); outputLimit=$($switch.outputLimit))."}
$shallow=Invoke-DeploymentGit -Repository $checkout -GitArguments @('rev-parse','--is-shallow-repository')
if(-not (Test-DeploymentProcessSuccess $shallow) -or $shallow.stdout.Trim() -cne 'false'){throw 'Source checkout must have complete Git history.'}
$admission=& (Join-Path $checkout 'install/Assert-DeploymentSource.ps1') -PackageRoot $checkout -PreMergeDeploy:$PreMergeDeploy -Reason $Reason
if($admission.sourceCommit -cne $identity.sourceCommit -or $admission.dirty){throw 'Source checkout does not match the clean packaged commit.'}
[ordered]@{path=$checkout;sourceCommit=$admission.sourceCommit;mainRelation=$admission.mainPolicy.relation;preMergeDeploy=$admission.mainPolicy.preMergeDeploy} | ConvertTo-Json -Compress
