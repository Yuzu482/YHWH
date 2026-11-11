#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$testRoot=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$fixture=Join-Path $testRoot ('packaged-admission-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe test root.'}
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$checks=0
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw "FAIL: $Name"};$script:checks++;Write-Output "PASS: $Name"}
function Reject([scriptblock]$Action,[string]$Reason){$caught=$false;try{& $Action | Out-Null}catch{$caught=$_.Exception.Message.Contains($Reason);if(-not $caught){throw}};Check $caught ('reject '+$Reason)}
function Git([string]$Dir,[string[]]$GitArgs){& git.exe -c "safe.directory=$Dir" -c protocol.file.allow=always -C $Dir @GitArgs 2>&1 | Out-Null;if($LASTEXITCODE -ne 0){throw 'Fixture Git failed.'}}
function CopyFixture([string]$Relative){$target=Join-Path $source $Relative;New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath (Join-Path $repo $Relative) -Destination $target}
function Stage([string]$Name){
 $stage=Join-Path $fixture $Name;New-Item -ItemType Directory -Path $stage | Out-Null
 . (Join-Path $source 'install/DeploymentMainPolicy.ps1');. (Join-Path $source 'install/Release-Files.ps1')
 foreach($entry in @(Get-ReleaseSourceFiles -SourceRoot $source)){$dest=Join-Path $stage $entry.relative;New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force|Out-Null;Copy-Item -LiteralPath $entry.fullPath -Destination $dest}
 & (Join-Path $source 'install/Stamp-PluginVersion.ps1') -SourceRepositoryRoot $source -StagingPackageRoot $stage | Out-Null
 return $stage
}
function ResolveFixture([string]$Stage,[string]$Checkout=$source){
 $wire=@(& (Join-Path $Stage 'install/Resolve-PackagedSource.ps1') -PackageRoot $Stage -CheckoutParent $checkoutParent -SourceRepository $Checkout)
 if($wire.Count -ne 1){throw 'Unexpected resolver output.'};return ($wire[0]|ConvertFrom-Json)
}
function Test-DefaultCloneFixture {
 # Fixture-only substitution lets the real clone path use an isolated local
 # remote. Production has a fixed HTTPS origin and rejects file transport.
 $savedSource=$script:source;$savedRemote=$env:YHWH_FIXTURE_REMOTE
 $variant=Join-Path $fixture 'auto-clone source';$remote=Join-Path $fixture 'auto-clone remote.git'
 try{
  Git $fixture @('-c','core.autocrlf=false','clone','-q','--branch','main',$script:remote,$variant)
  Git $variant @('config','user.name','Fixture');Git $variant @('config','user.email','fixture@example.invalid');Git $variant @('config','commit.gpgsign','false');Git $variant @('config','core.hooksPath',$hooks)
  $file=Join-Path $variant 'install/Resolve-PackagedSource.ps1';$text=[IO.File]::ReadAllText($file)
  $originNeedle="`$canonicalRemote='https://github.com/Yuzu482/YHWH.git'"
  $fileNeedle='protocol.file.allow=never'
  if(([regex]::Matches($text,[regex]::Escape($originNeedle))).Count -ne 1 -or ([regex]::Matches($text,[regex]::Escape($fileNeedle))).Count -ne 1){throw 'Fixture substitution anchors changed.'}
  $text=$text.Replace($originNeedle,'$canonicalRemote=$env:YHWH_FIXTURE_REMOTE').Replace($fileNeedle,'protocol.file.allow=always')
  [IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($false))
  Git $variant @('add','install/Resolve-PackagedSource.ps1');Git $variant @('commit','-qm','fixture local clone transport')
  Git $fixture @('init','--bare','-q','-b','main',$remote);Git $variant @('remote','set-url','origin',$remote);Git $variant @('push','-q','origin','HEAD:refs/heads/main')
  $script:source=$variant;$env:YHWH_FIXTURE_REMOTE=$remote;$stage=Stage 'auto-clone package'
  $wire=@(& (Join-Path $stage 'install/Resolve-PackagedSource.ps1') -PackageRoot $stage -CheckoutParent $checkoutParent)
  if($wire.Count -ne 1){throw 'Unexpected automatic-clone output.'};$value=$wire[0]|ConvertFrom-Json
  $expected=(& git.exe -C $variant rev-parse HEAD).Trim()
  Check ($value.mode -ceq 'canonical-clone' -and $value.sourceCommit -ceq $expected -and (Test-Path -LiteralPath (Join-Path $value.sourceRoot '.git'))) 'automatic clone verifies the local fixture remote and exact commit'
 }finally{
  $script:source=$savedSource
  if($null -eq $savedRemote){Remove-Item Env:YHWH_FIXTURE_REMOTE -ErrorAction SilentlyContinue}else{$env:YHWH_FIXTURE_REMOTE=$savedRemote}
 }
}
function Test-BootstrapFixture([string]$Stage) {
 $archiveRoot=Join-Path $fixture 'bootstrap-archive';$archiveStage=Join-Path $archiveRoot 'pi-kether-portable'
 New-Item -ItemType Directory -Path $archiveStage -Force | Out-Null
 & robocopy.exe $Stage $archiveStage /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
 if($LASTEXITCODE -ge 8){throw 'Could not copy bootstrap fixture.'}
 $zip=Join-Path $archiveRoot 'portable.zip';Compress-Archive -LiteralPath $archiveStage -DestinationPath $zip
 & (Join-Path $source 'Build-OneClick.ps1') -PortableZip $zip 6>$null
 $portableVersion=(Get-Content -LiteralPath (Join-Path $source 'portable.manifest.json') -Raw|ConvertFrom-Json).version
 $generated=Join-Path $archiveRoot ("Install-YHWH-$portableVersion.ps1")
 if(-not(Test-Path -LiteralPath $generated)){throw 'Fixture one-click artifact missing.'}
 $beforeOutput=(Get-FileHash -LiteralPath $generated -Algorithm SHA256).Hash
 Reject {& (Join-Path $source 'Build-OneClick.ps1') -PortableZip $zip 6>$null} 'One-click output already exists'
 Check ((Get-FileHash -LiteralPath $generated -Algorithm SHA256).Hash -ceq $beforeOutput) 'existing one-click artifact remains unchanged'
 $text=[IO.File]::ReadAllText($generated)
 $encoded=[regex]::Match($text,"(?m)^\`$script:PayloadBase64\s*=\s*'([A-Za-z0-9+/=]+)'")
 $checksum=[regex]::Match($text,"(?m)^\`$script:PayloadSha256\s*=\s*'([a-f0-9]{64})'")
 if(-not $encoded.Success -or -not $checksum.Success){throw 'Generated fixture payload missing.'}
 $validBase64=$encoded.Groups[1].Value;$validSha=$checksum.Groups[1].Value
 [IO.File]::WriteAllText((Join-Path $archiveStage 'README.md'),'tampered package')
 $badZip=Join-Path $archiveRoot 'tampered.zip';Compress-Archive -LiteralPath $archiveStage -DestinationPath $badZip
 $badBase64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($badZip));$badSha=(Get-FileHash -LiteralPath $badZip -Algorithm SHA256).Hash.ToLowerInvariant()
 $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $source 'Install-YHWH.ps1'),[ref]$null,[ref]$errors)
 if($errors){throw 'Bootstrap fixture did not parse.'}
 foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
 $InstallRoot=Join-Path $fixture 'bootstrap-root';$WorkspaceRoots=@((Join-Path $fixture 'bootstrap-workspace'));$Hosts='generic';$NonInteractive=$true;$PlanOnly=$false;$ExtractOnly=$false;$UpgradeExisting=$false;$SourceRepository=$source
 $fixtureTarget=Join-Path $fixture 'bootstrap-target';$script:fixtureWslUsed=$false;$script:fixtureWorkflowUsed=$false
 $psDir=Join-Path $InstallRoot 'runtime/powershell-7.6.5';$nodeDir=Join-Path $InstallRoot 'runtime/node-22.23.1/node-v22.23.1-win-x64'
 New-Item -ItemType Directory -Path $psDir,$nodeDir -Force|Out-Null
 & robocopy.exe $PSHOME $psDir /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
 if($LASTEXITCODE -ge 8){throw 'Could not copy PowerShell fixture runtime.'}
 Copy-Item -LiteralPath (Get-Command node.exe -CommandType Application | Select-Object -First 1 -ExpandProperty Source) -Destination (Join-Path $nodeDir 'node.exe')
 function Assert-YhwhInstallAllowed([string]$PluginPath,[switch]$Upgrade) { }
 function Get-YhwhDownload($Dependency,[string]$Cache) { return (Join-Path $fixture 'no-download.fixture') }
 function Initialize-YhwhWsl([switch]$Unattended) { $script:fixtureWslUsed=$true;return $true }
 function Initialize-YhwhDistro([string]$Root,$Dependency,[string]$Cache) { }
 function Invoke-YhwhWorkflow([string]$Pwsh,[string]$Source,[string]$Config) {
   if([IO.Path]::GetFullPath($Source) -ine [IO.Path]::GetFullPath($source)){throw 'Bootstrap selected an unverified source.'}
   $script:fixtureWorkflowUsed=$true
   & $Pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Source 'Workflow.ps1') -Action Install -ConfigFile $Config -TargetHome $fixtureTarget -SkipWsl -SkipTunnel -SkipCodexRegistration
   if($LASTEXITCODE -ne 0){throw 'Fixture Workflow failed.'}
 }
 $script:PayloadBase64=$badBase64;$script:PayloadSha256=$badSha
 Reject {Invoke-YhwhMain} 'Packaged source verification failed'
 Check (-not $script:fixtureWslUsed -and -not $script:fixtureWorkflowUsed -and -not(Test-Path -LiteralPath $fixtureTarget)) 'tampered package stops before WSL and install'
 $script:PayloadBase64=$validBase64;$script:PayloadSha256=$validSha
 Invoke-YhwhMain
 Check ($script:fixtureWslUsed -and $script:fixtureWorkflowUsed -and [IO.File]::ReadAllText((Join-Path $fixtureTarget 'fixture-install.txt')) -ceq '1.5.1') 'generated bootstrap reaches verified source and isolated installer'
}
try{
 $source=Join-Path $fixture 'source with spaces';$remote=Join-Path $fixture 'remote.git';$checkoutParent=Join-Path $fixture 'checkouts';$target=Join-Path $fixture 'target'
 New-Item -ItemType Directory -Path $source,$checkoutParent | Out-Null
 foreach($path in @('.gitattributes','Workflow.ps1','Install-YHWH.ps1','Build-OneClick.ps1','install/bootstrap-dependencies.json','install/Open-YhwhPi.ps1','install/Open-YhwhProviders.ps1','install/Assert-DeploymentSource.ps1','install/DeploymentMainPolicy.ps1','install/Get-PluginBuildIdentity.ps1','install/Release-Files.ps1','install/Resolve-PackagedSource.ps1','install/Test-ReleaseContents.ps1','install/Stamp-PluginVersion.ps1','install/HostRuntimeSecurity.ps1','install/HostPolicyPreservation.ps1','install/assert-existing-plugin.mjs','install/provision-wsl.sh','install/check-pi-downgrade.py','payload/wsl-package-lock.json','payload/pi-dispatch/.codex-plugin/plugin.json','payload/pi-dispatch/scripts/sdk-tree-integrity.mjs','payload/pi-dispatch/scripts/check-pi-runtime-tree.mjs','payload/pi-dispatch/scripts/pi-151-home.mjs','payload/pi-dispatch/extensions/data-capacity.js','licenses/pi-1.5.1-MIT.txt','portable.manifest.json')){CopyFixture $path}
 $inert=Join-Path $source 'install/Install-PiKether.ps1'
 [IO.File]::WriteAllText($inert,'param($ConfigFile,$TargetHome,[switch]$SkipWsl,[switch]$SkipTunnel,[switch]$SkipCodexRegistration) [IO.File]::WriteAllText((Join-Path $TargetHome "fixture-install.txt"),"1.5.1")')
 [IO.File]::WriteAllText((Join-Path $source 'README.md'),"Synthetic release fixture.`n")
 $excludedFixtures=@('payload/pi-dispatch/tests/card-lab-interrupted-request-recovery.test.mjs','payload/pi-dispatch/tests/review-quota-adjudication.test.mjs','payload/pi-dispatch/tests/review-quota-material-reconsideration.test.mjs','payload/pi-dispatch/tests/review-quota-exception.test.mjs','payload/pi-dispatch/tests/review-quota-recovery.test.mjs','payload/pi-dispatch/tests/fixtures/card-lab-review-ledger-five.json','payload/pi-dispatch/tests/helpers/legacy-state-fixtures.mjs','payload/pi-dispatch/tests/fixtures/legacy-state-pins.json','payload/pi-dispatch/tests/historical-local-evidence/original.txt','payload/pi-dispatch/tests/historical-synthetic-source/package.json')
 foreach($relative in $excludedFixtures){$file=Join-Path $source $relative;New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force|Out-Null;[IO.File]::WriteAllText($file,'synthetic fixture')}
 Git $source @('init','-q','-b','main');Git $source @('config','user.name','Fixture');Git $source @('config','user.email','fixture@example.invalid');Git $source @('config','commit.gpgsign','false')
 $hooks=Join-Path $fixture 'empty-hooks';New-Item -ItemType Directory -Path $hooks|Out-Null;Git $source @('config','core.hooksPath',$hooks)
 Git $source @('add','.');Git $source @('commit','-qm','clean fixture')
 Git $fixture @('init','--bare','-q',$remote);Git $source @('remote','add','origin',$remote);Git $source @('push','-q','origin','HEAD:refs/heads/main')
 $first=(& git.exe -C $source rev-parse HEAD).Trim();$stage=Stage 'package first'
 Check (@($excludedFixtures|Where-Object {Test-Path -LiteralPath (Join-Path $stage $_)}).Count -eq 0) 'original-host history and repository-only fixtures remain outside the package'
 $accepted=ResolveFixture $stage
 Check ($accepted.sourceCommit -ceq $first -and $accepted.mode -ceq 'explicit-source' -and $accepted.verifiedFiles -gt 10) 'clean package matches pushed main source'
 $clone=Join-Path $fixture 'fresh checkout';Git $fixture @('-c','core.autocrlf=false','clone','--quiet','--no-checkout','--no-tags','--single-branch','--branch','main','--',$remote,$clone);Git $clone @('checkout','--quiet','--detach',$first)
 Check ((ResolveFixture $stage $clone).sourceCommit -ceq $first) 'fresh checkout from the real fixture remote matches package bytes'
 . (Join-Path $source 'install/DeploymentMainPolicy.ps1');. (Join-Path $source 'install/Release-Files.ps1')
 $readme=Join-Path $source 'README.md';$readmeSaved=[IO.File]::ReadAllBytes($readme)
 [IO.File]::WriteAllText($readme,"Synthetic release fixture.`r`n",[Text.UTF8Encoding]::new($false))
 $sourceEntries=@(Get-ReleaseSourceFiles -SourceRoot $source)
 Reject {Test-ReleaseSourceBytes -SourceRoot $source -Files $sourceEntries -FilesRoot $source} 'Release bytes differ from the committed Git blob'
 [IO.File]::WriteAllBytes($readme,$readmeSaved)
 Test-DefaultCloneFixture
 & (Join-Path $source 'Workflow.ps1') -Action Install -TargetHome $target -SkipWsl -SkipTunnel -SkipCodexRegistration
 $record=@(Get-ChildItem -LiteralPath (Join-Path $target '.local/state/pi-kether/installation-records') -Filter '*.json')
 Check ($record.Count -eq 1 -and (Get-Content -Raw -LiteralPath $record[0].FullName|ConvertFrom-Json).status -eq 'completed' -and [IO.File]::ReadAllText((Join-Path $target 'fixture-install.txt')) -ceq '1.5.1') 'admitted Workflow reaches only isolated installer target'
 Test-BootstrapFixture $stage

 $file=Join-Path $stage 'README.md';$saved=[IO.File]::ReadAllBytes($file)
 [IO.File]::WriteAllText($file,'tampered');Reject {ResolveFixture $stage} 'Package contents differ';[IO.File]::WriteAllBytes($file,$saved)
 $extra=Join-Path $stage 'unexpected.txt';[IO.File]::WriteAllText($extra,'extra');Reject {ResolveFixture $stage} 'unexpected file';Remove-Item -LiteralPath $extra
 Remove-Item -LiteralPath $file;Reject {ResolveFixture $stage} 'omits files';[IO.File]::WriteAllBytes($file,$saved)
 $manifestPath=Join-Path $stage 'portable.manifest.json';$manifestSaved=[IO.File]::ReadAllBytes($manifestPath)
 $manifest=Get-Content -Raw -LiteralPath $manifestPath|ConvertFrom-Json -AsHashtable;$manifest.components.piCodingAgent='0.84.4';[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))
 Reject {ResolveFixture $stage} 'Stamped manifest differs';[IO.File]::WriteAllBytes($manifestPath,$manifestSaved)
 $dirtyFile=Join-Path $source 'untracked-fixture';[IO.File]::WriteAllText($dirtyFile,'dirty');Reject {ResolveFixture $stage} 'clean source checkout';Remove-Item -LiteralPath $dirtyFile
 Git $source @('remote','set-url','origin',(Join-Path $fixture 'missing.git'));Reject {ResolveFixture $stage} 'Remote HEAD verification failed';Git $source @('remote','set-url','origin',$remote)

 [IO.File]::AppendAllText((Join-Path $source 'README.md'),"`nnew unpushed content")
 Git $source @('add','README.md');Git $source @('commit','-qm','unpushed fixture')
 $second=Stage 'package second';Reject {ResolveFixture $second} 'HEAD is not proven pushed'
 Git $source @('push','-q','origin','HEAD:refs/heads/side');Reject {ResolveFixture $second} 'HEAD is not in origin/main'
 Git $source @('push','-q','origin','HEAD:refs/heads/main');$accepted=ResolveFixture $second
 Check ($accepted.sourceCommit -cne $first) 'new main commit admitted only after push'
 Git $source @('fetch','-q','origin');Git $source @('checkout','-q','--detach',$first)
 Check ((ResolveFixture $stage).sourceCommit -ceq $first) 'pushed main ancestor remains admissible'
 Git $source @('checkout','-q','main')
 $oldManifest=Join-Path $source 'portable.manifest.json';$m=Get-Content -LiteralPath $oldManifest -Raw|ConvertFrom-Json -AsHashtable;$m.components.piCodingAgent='0.84.4'
 $oldJson=($m|ConvertTo-Json -Depth 30).Replace("`r`n","`n")
 [IO.File]::WriteAllText($oldManifest,$oldJson,[Text.UTF8Encoding]::new($false));Git $source @('add','portable.manifest.json');Git $source @('commit','-qm','old version fixture');Git $source @('push','-q','origin','HEAD:refs/heads/main')
 $oldStage=Stage 'package old';Reject {ResolveFixture $oldStage} 'does not contain the verified Pi 1.5.1 runtime'
 Write-Output "PASS: $checks packaged-source admission checks; isolated local Git remote and inert installer."
}finally{
 if(Test-Path -LiteralPath $fixture){$resolved=(Resolve-Path -LiteralPath $fixture).Path;if(-not $resolved.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
