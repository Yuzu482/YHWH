#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$base=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$fixture=Join-Path $base ('oneclick-source-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture escaped .test.'}
$checks=0
function Check([bool]$value,[string]$name){if(-not $value){throw "FAIL: $name"};$script:checks++;Write-Output "PASS: $name"}
function Git([string]$cwd,[string[]]$arguments){& git.exe -c protocol.file.allow=always -c "safe.directory=$cwd" -C $cwd @arguments 2>&1 | Out-Null;if($LASTEXITCODE -ne 0){throw 'Fixture Git failed.'}}
function Reject([scriptblock]$action,[string]$message){$seen=$false;try{& $action | Out-Null}catch{if(-not $_.Exception.Message.Contains($message)){throw};$seen=$true};Check $seen "reject $message"}
try {
  $bootstrap=[IO.File]::ReadAllText((Join-Path $repo 'Install-YHWH.ps1'))
  $main=$bootstrap.Substring($bootstrap.IndexOf('function Invoke-YhwhMain'))
  Check ($main.IndexOf('Resolve-OneClickSource.ps1') -ge 0 -and $main.IndexOf('Resolve-OneClickSource.ps1') -lt $main.IndexOf('Initialize-YhwhWsl -Unattended') -and $main.IndexOf('Resolve-OneClickSource.ps1') -lt $main.IndexOf('Initialize-YhwhDistro $root')) 'source verification precedes WSL setup and provisioning'
  $source=Join-Path $fixture 'source';$remote=Join-Path $fixture 'remote.git';$target=Join-Path $fixture 'target'
  New-Item -ItemType Directory -Force -Path (Join-Path $source 'install'),(Join-Path $source 'payload/pi-dispatch/.codex-plugin') | Out-Null
  foreach($file in @('Workflow.ps1','install/Assert-DeploymentSource.ps1','install/Get-PluginBuildIdentity.ps1','install/DeploymentMainPolicy.ps1')){Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $source $file)}
  [IO.File]::WriteAllText((Join-Path $source 'payload/pi-dispatch/.codex-plugin/plugin.json'),'{"version":"1.0.0"}')
  [IO.File]::WriteAllText((Join-Path $source 'portable.manifest.json'),'{"version":"1.0.0","components":{"piDispatch":"1.0.0"}}')
  [IO.File]::WriteAllText((Join-Path $source 'install/Install-PiKether.ps1'),'param($ConfigFile,$TargetHome,[switch]$SkipWsl,[switch]$SkipTunnel,[switch]$SkipCodexRegistration) [IO.File]::WriteAllText((Join-Path $TargetHome "installed-fixture"),"installed")')
  Git $source @('init','-q','-b','main');Git $source @('config','user.name','One Click Fixture');Git $source @('config','user.email','fixture@example.invalid');Git $source @('config','commit.gpgsign','false')
  New-Item -ItemType Directory -Path (Join-Path $fixture 'empty-hooks') | Out-Null
  Git $source @('config','core.hooksPath',(Join-Path $fixture 'empty-hooks'))
  Git $source @('add','.');Git $source @('commit','-qm','main fixture')
  Git $fixture @('init','--bare','-q',$remote);Git $remote @('symbolic-ref','HEAD','refs/heads/main');Git $source @('remote','add','origin',$remote);Git $source @('push','-q','origin','HEAD:refs/heads/main')
  function MakePackage([string]$name){
    $package=Join-Path $fixture $name
    New-Item -ItemType Directory -Force -Path (Join-Path $package 'install'),(Join-Path $package 'payload/pi-dispatch/.codex-plugin') | Out-Null
    foreach($file in @('portable.manifest.json','payload/pi-dispatch/.codex-plugin/plugin.json','install/Get-PluginBuildIdentity.ps1','install/DeploymentMainPolicy.ps1')){Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $package $file)}
    & (Join-Path $repo 'install/Stamp-PluginVersion.ps1') -SourceRepositoryRoot $source -StagingPackageRoot $package | Out-Null
    return $package
  }
  $resolver=Join-Path $repo 'install/Resolve-OneClickSource.ps1'
  $package=MakePackage 'package-main'
  $clone=Join-Path $fixture 'verified main'
  $result=(& $resolver -PackageRoot $package -CheckoutPath $clone -SourceUrl $remote | ConvertFrom-Json)
  $expected=(& git.exe -C $source rev-parse HEAD).Trim()
  Check ($result.sourceCommit -ceq $expected -and $result.mainRelation -eq 'in-main' -and -not $result.preMergeDeploy -and (Test-Path -LiteralPath (Join-Path $clone '.git'))) 'packaged commit resolves to a clean published main checkout'
  & (Join-Path $clone 'Workflow.ps1') -Action Install -TargetHome $target -SkipWsl -SkipTunnel -SkipCodexRegistration
  $record=Get-ChildItem -LiteralPath (Join-Path $target '.local/state/pi-kether/installation-records') -Filter '*.json' | Select-Object -First 1
  $entry=Get-Content -LiteralPath $record.FullName -Raw | ConvertFrom-Json
  Check ((Test-Path -LiteralPath (Join-Path $target 'installed-fixture')) -and $entry.status -eq 'completed' -and $entry.admission.sourceCommit -ceq $expected) 'resolved source passes the real guard and inert installer'
  Reject {& $resolver -PackageRoot $package -CheckoutPath $clone -SourceUrl $remote} 'new destination'
  Reject {& $resolver -PackageRoot $package -CheckoutPath (Join-Path $fixture 'bad-url') -SourceUrl 'http://example.invalid/repo'} 'credential-free HTTPS'
  $bad=MakePackage 'package-bad'
  $pluginPath=Join-Path $bad 'payload/pi-dispatch/.codex-plugin/plugin.json'
  $plugin=Get-Content -Raw -LiteralPath $pluginPath | ConvertFrom-Json;$plugin.version='1.0.0+invalid';$plugin | ConvertTo-Json | Set-Content -LiteralPath $pluginPath -Encoding utf8NoBOM
  Reject {& $resolver -PackageRoot $bad -CheckoutPath (Join-Path $fixture 'bad-proof') -SourceUrl $remote} 'provenance is missing or inconsistent'
  Check (-not (Test-Path -LiteralPath (Join-Path $fixture 'bad-proof'))) 'invalid package is rejected before cloning'
  Git $source @('checkout','-qb','side')
  [IO.File]::AppendAllText((Join-Path $source 'Workflow.ps1'),"`n# side fixture`n")
  Git $source @('add','Workflow.ps1');Git $source @('commit','-qm','side fixture')
  $sidePackage=MakePackage 'package-side'
  Reject {& $resolver -PackageRoot $sidePackage -CheckoutPath (Join-Path $fixture 'unpublished') -SourceUrl $remote} 'Source commit checkout failed'
  Git $source @('push','-q','origin','HEAD:refs/heads/side')
  Reject {& $resolver -PackageRoot $sidePackage -CheckoutPath (Join-Path $fixture 'side-default') -SourceUrl $remote} 'HEAD is not in origin/main'
  Reject {& $resolver -PackageRoot $sidePackage -CheckoutPath (Join-Path $fixture 'side-no-reason') -SourceUrl $remote -PreMergeDeploy} 'requires a nonempty single-line Reason'
  $side=(& $resolver -PackageRoot $sidePackage -CheckoutPath (Join-Path $fixture 'side-approved') -SourceUrl $remote -PreMergeDeploy -Reason 'synthetic premerge fixture' | ConvertFrom-Json)
  Check ($side.mainRelation -eq 'not-in-main' -and $side.preMergeDeploy -and $side.sourceCommit -ceq (& git.exe -C $source rev-parse HEAD).Trim()) 'explicit premerge branch uses the unchanged admission guard'
  $dirty=MakePackage 'package-dirty'
  $proofPath=Join-Path $dirty 'build-provenance.json';$portablePath=Join-Path $dirty 'portable.manifest.json';$pluginPath=Join-Path $dirty 'payload/pi-dispatch/.codex-plugin/plugin.json'
  $proof=Get-Content -Raw -LiteralPath $proofPath | ConvertFrom-Json;$proof.dirty=$true;$proof.pluginVersion+='.dirty';$proof | ConvertTo-Json | Set-Content -LiteralPath $proofPath -Encoding utf8NoBOM
  $plugin=Get-Content -Raw -LiteralPath $pluginPath | ConvertFrom-Json;$plugin.version=$proof.pluginVersion;$plugin | ConvertTo-Json | Set-Content -LiteralPath $pluginPath -Encoding utf8NoBOM
  $portable=Get-Content -Raw -LiteralPath $portablePath | ConvertFrom-Json;$portable.components.piDispatch=$proof.pluginVersion;$portable | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $portablePath -Encoding utf8NoBOM
  Reject {& $resolver -PackageRoot $dirty -CheckoutPath (Join-Path $fixture 'dirty-proof') -SourceUrl $remote} 'dirty source'
  Check (-not (Test-Path -LiteralPath (Join-Path $fixture 'dirty-proof'))) 'dirty package is rejected before cloning'
  $builder=Join-Path $fixture 'builder'
  New-Item -ItemType Directory -Path $builder | Out-Null
  foreach($file in @('Build-OneClick.ps1','Install-YHWH.ps1','portable.manifest.json')){Copy-Item -LiteralPath (Join-Path $repo $file) -Destination (Join-Path $builder $file)}
  [IO.File]::WriteAllText((Join-Path $builder 'portable.zip'),'synthetic zip bytes')
  Git $builder @('init','-q');Git $builder @('remote','add','origin','https://user:fixture-secret@example.invalid/repo')
  Reject {& (Join-Path $builder 'Build-OneClick.ps1') -PortableZip (Join-Path $builder 'portable.zip')} 'credential-free HTTPS origin'
  Check (-not (Test-Path -LiteralPath (Join-Path $builder 'Install-YHWH-0.15.0.ps1'))) 'credential-bearing origin is not embedded in an installer'
  Write-Output "PASS: $checks one-click source checks; real isolated Git and inert installer, no production installation"
} finally {
  if(Test-Path -LiteralPath $fixture){$resolved=[IO.Path]::GetFullPath($fixture);if(-not $resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture cleanup.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
