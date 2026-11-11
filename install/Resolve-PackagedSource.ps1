#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$CheckoutParent,
  [string]$SourceRepository
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'DeploymentMainPolicy.ps1')
. (Join-Path $PSScriptRoot 'Release-Files.ps1')
$package=[IO.Path]::GetFullPath($PackageRoot).TrimEnd('\','/')
if(Test-Path -LiteralPath (Join-Path $package '.git')){throw 'Packaged admission requires an extracted package without Git state.'}
& (Join-Path $PSScriptRoot 'Test-ReleaseContents.ps1') -PackageRoot $package 6>$null
$proof=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $package
if($proof.dirty -or [string]$proof.sourceCommit -cnotmatch '^[a-f0-9]{40,64}$'){throw 'Packaged installation requires clean committed source provenance.'}

function Assert-SafeDirectory([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
  if(-not (Test-Path -LiteralPath $full -PathType Container)){throw 'Source directory does not exist.'}
  $cursor=$full
  while($cursor){
    if((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Refusing a linked source directory.'}
    $parent=Split-Path -Parent $cursor;if(-not $parent -or $parent -eq $cursor){break};$cursor=$parent
  }
  return $full
}
function Invoke-IsolatedGit([string]$WorkingDirectory,[string[]]$GitArguments) {
  $git=(Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $gitArgs=@('-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.http.allow=never','-c','protocol.file.allow=never','-c','protocol.ext.allow=never','-c','http.followRedirects=false')+$GitArguments
  $result=Invoke-DeploymentProcess -FilePath $git -Arguments $gitArgs -WorkingDirectory $WorkingDirectory -TimeoutMs 300000 -MaxOutputBytes 65536 -IsolatedGit
  if(-not (Test-DeploymentProcessSuccess $result)){throw "Git source retrieval failed (exit $($result.status), timeout=$($result.timedOut), outputLimit=$($result.outputLimit))."}
}
if($SourceRepository){
  if(-not [IO.Path]::IsPathFullyQualified($SourceRepository)){throw 'SourceRepository must be an absolute local Git checkout.'}
  $source=Assert-SafeDirectory $SourceRepository
  $mode='explicit-source'
} else {
  $parent=Assert-SafeDirectory $CheckoutParent
  $source=Join-Path $parent ('source-'+[guid]::NewGuid().ToString('N'))
  if(Test-Path -LiteralPath $source){throw 'Source checkout destination already exists.'}
  # The automatic route is anchored to the canonical public repository. An
  # explicit local checkout retains the existing source-install origin policy.
  $canonicalRemote='https://github.com/Yuzu482/YHWH.git'
  Invoke-IsolatedGit $parent @('clone','--quiet','--no-checkout','--no-tags','--single-branch','--branch','main','--',$canonicalRemote,$source)
  $source=Assert-SafeDirectory $source
  Invoke-IsolatedGit $source @('checkout','--quiet','--detach',$proof.sourceCommit)
  $mode='canonical-clone'
}
if(-not (Test-Path -LiteralPath (Join-Path $source '.git'))){throw 'SourceRepository must be a Git checkout.'}
$sourceIdentity=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $source -IsolatedGit
if($sourceIdentity.dirty -or $sourceIdentity.sourceCommit -cne $proof.sourceCommit -or $sourceIdentity.pluginVersion -cne $proof.pluginVersion){throw 'Packaged provenance does not match the clean source checkout.'}
# This is the existing remote/pushed/main gate, with no dirty or pre-merge
# exception. It is executed again by Workflow immediately before installation.
$admission=& (Join-Path $PSScriptRoot 'Assert-DeploymentSource.ps1') -PackageRoot $source -IsolatedGit
if($admission.dirty -or $admission.sourceCommit -cne $proof.sourceCommit -or $admission.mainPolicy.relation -cne 'in-main'){throw 'Package source was not admitted from main.'}

$expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$entries=@(Get-ReleaseSourceFiles -SourceRoot $source -IsolatedGit)
Test-ReleaseSourceBytes -SourceRoot $source -Files $entries -FilesRoot $source -IsolatedGit
foreach($entry in $entries){if(-not $expected.Add($entry.relative)){throw 'Duplicate source package path.'}}
foreach($required in @('install/Install-PiKether.ps1','install/HostRuntimeSecurity.ps1','install/HostPolicyPreservation.ps1','install/assert-existing-plugin.mjs','install/provision-wsl.sh','install/check-pi-downgrade.py','payload/pi-dispatch/scripts/sdk-tree-integrity.mjs','payload/pi-dispatch/scripts/check-pi-runtime-tree.mjs','payload/pi-dispatch/scripts/pi-151-home.mjs','payload/pi-dispatch/extensions/data-capacity.js','licenses/pi-1.5.1-MIT.txt')){
  if(-not $expected.Contains($required)){throw 'Admitted source is missing a required Pi runtime file.'}
}
if(-not $expected.Add('build-provenance.json')){throw 'Provenance path collides with source.'}
$actual=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($file in @(Get-ChildItem -LiteralPath $package -Recurse -Force -File)){
  $relative=[IO.Path]::GetRelativePath($package,$file.FullName).Replace('\','/')
  if(-not $actual.Add($relative) -or -not $expected.Contains($relative)){throw 'Package contains an unexpected file.'}
}
if($actual.Count -ne $expected.Count){throw 'Package omits files from the admitted source.'}
$pluginPath='payload/pi-dispatch/.codex-plugin/plugin.json';$manifestPath='portable.manifest.json'
foreach($entry in $entries){
  $pack=Join-Path $package ($entry.relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
  if(-not (Test-Path -LiteralPath $pack -PathType Leaf)){throw 'Package omits an admitted source file.'}
  if($entry.relative -cin @($pluginPath,$manifestPath)){
    $a=Get-Content -LiteralPath $entry.fullPath -Raw | ConvertFrom-Json -AsHashtable
    $b=Get-Content -LiteralPath $pack -Raw | ConvertFrom-Json -AsHashtable
    if($entry.relative -ceq $pluginPath){if($b.version -cne $proof.pluginVersion){throw 'Packaged plugin version differs from provenance.'};$b.version=$a.version}
    else{if($b.components.piDispatch -cne $proof.pluginVersion){throw 'Packaged manifest differs from provenance.'};$b.components.piDispatch=$a.components.piDispatch}
    if(($a|ConvertTo-Json -Depth 100 -Compress) -cne ($b|ConvertTo-Json -Depth 100 -Compress)){throw 'Stamped manifest differs from admitted source.'}
  } elseif((Get-FileHash -LiteralPath $entry.fullPath -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $pack -Algorithm SHA256).Hash) {throw 'Package contents differ from admitted source.'}
}
$manifest=Get-Content -LiteralPath (Join-Path $source $manifestPath) -Raw | ConvertFrom-Json
$lock=(Get-FileHash -LiteralPath (Join-Path $source 'payload/wsl-package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$wslScript=Get-Content -LiteralPath (Join-Path $source 'install/provision-wsl.sh') -Raw
$wslVersions=[regex]::Matches($wslScript,'(?m)^PI_VERSION="([^"\r\n]+)"\r?$')
$wslLspVersions=[regex]::Matches($wslScript,'(?m)^LSP_VERSION="([^"\r\n]+)"\r?$')
if($manifest.components.piCodingAgent -cne '1.5.1' -or $manifest.components.piLspExtension -cne '1.4.0' -or $lock -cne '27887b43d9346d533cf0e7c4fde2d0994cb0e5311cd06c7a3ed253bceeb13389' -or $wslVersions.Count -ne 1 -or $wslVersions[0].Groups[1].Value -cne '1.5.1' -or $wslLspVersions.Count -ne 1 -or $wslLspVersions[0].Groups[1].Value -cne '1.4.0'){throw 'Admitted source does not contain the verified Pi 1.5.1 runtime.'}
$again=& (Join-Path $PSScriptRoot 'Assert-DeploymentSource.ps1') -PackageRoot $source -IsolatedGit
if($again.dirty -or $again.sourceCommit -cne $proof.sourceCommit -or $again.mainPolicy.relation -cne 'in-main'){throw 'Source changed during packaged admission.'}
[pscustomobject]@{sourceRoot=$source;sourceCommit=$proof.sourceCommit;mode=$mode;verifiedFiles=$entries.Count;mainCommit=$again.mainPolicy.mainCommit}|ConvertTo-Json -Compress
