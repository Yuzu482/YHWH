#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$allowed=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$fixture=Join-Path $allowed ('pi-downgrade-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture path.'}
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-PiKether.ps1'),[ref]$null,[ref]$errors)
if($errors){throw 'Installer did not parse.'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
 if($fn.Name -in @('Assert-Under','Assert-NoReparse','Compare-ToPinnedRuntimeVersion','Compare-ToPinnedPiVersion','Compare-ToPinnedLspVersion','Get-HostPiMode')){. ([scriptblock]::Create($fn.Extent.Text))}
}
$checks=0
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw "FAIL: $Name"};$script:checks++;Write-Output "PASS: $Name"}
function Reject([scriptblock]$Action,[string]$Reason){$caught=$false;try{& $Action|Out-Null}catch{$caught=$_.Exception.Message.Contains($Reason);if(-not $caught){throw}};Check $caught ('reject '+$Reason)}
function FixtureNode { $global:LASTEXITCODE=0;return $script:fixtureDigest }
function MakeHost([string]$Name,[string]$Declared,[string]$Installed,[string]$LspDeclared='', [string]$LspInstalled='') {
 $fixtureHome=Join-Path $fixture $Name;$root=Join-Path $fixtureHome '.pi/agent/npm';$pkg=Join-Path $root 'node_modules/@earendil-works/pi-coding-agent'
 New-Item -ItemType Directory -Path $pkg -Force|Out-Null
 $deps=@{'@earendil-works/pi-coding-agent'=$Declared};if($LspDeclared){$deps['pi-lsp-extension']=$LspDeclared}
 @{private=$true;dependencies=$deps}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $root 'package.json') -Encoding utf8NoBOM
 @{version=$Installed}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $pkg 'package.json') -Encoding utf8NoBOM
 if($LspInstalled){$lsp=Join-Path $root 'node_modules/pi-lsp-extension';New-Item -ItemType Directory -Path $lsp -Force|Out-Null;@{version=$LspInstalled}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $lsp 'package.json') -Encoding utf8NoBOM}
 $lock=@{packages=@{''=@{dependencies=$deps};'node_modules/@earendil-works/pi-coding-agent'=@{version=$Declared;integrity='sha512-rdu4pRvpQba2ep83nqHaN8L1pvY1OQ3i/2FucogA/eyRxwoUXMUXdk1Z9JnZFJR+9ck9Gs1ajuSb9m7Hz7ejYw=='}}}
 if($LspDeclared){$lock.packages['node_modules/pi-lsp-extension']=@{version=$LspDeclared;integrity='sha512-FOwGIivoZt5YfVY/LGqQZf4+wPXT+73loKOQ3Lu6zeG2UAPCxelHT21zXG/qCVD32epq8FymH9dJ8EnotXkv4Q=='}}
 $lock|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $root 'package-lock.json') -Encoding utf8NoBOM
 [IO.File]::WriteAllText((Join-Path $root 'node_modules/fixture-marker'),'preserve')
 return @{home=$fixtureHome;root=$root}
}
try{
 $old=MakeHost 'old' '0.84.4' '0.84.4'
 Check ((Get-HostPiMode $old.root 'unused-node' 'unused-module' $old.home) -ceq 'replace') 'older standard Pi may be upgraded with backup'
 foreach($version in @('1.5.2','1.6.0-beta.1','2.0.0')){
  $name='new-'+$version.Replace('.','-');$new=MakeHost $name $version $version
  Reject {Get-HostPiMode $new.root 'unused-node' 'unused-module' $new.home} 'refusing to downgrade'
  Check ([IO.File]::ReadAllText((Join-Path $new.root 'node_modules/fixture-marker')) -ceq 'preserve') 'newer host files remain unchanged'
 }
 $unknown=MakeHost 'unknown' 'latest' '1.5.1'
 Reject {Get-HostPiMode $unknown.root 'unused-node' 'unused-module' $unknown.home} 'cannot be safely classified'
 foreach($version in @('1.5.1-beta..x','1.5.1-01')){
  Reject {Compare-ToPinnedPiVersion $version} 'cannot be safely classified'
 }
 $mismatch=MakeHost 'mismatch' '0.84.4' '1.6.0'
 Reject {Get-HostPiMode $mismatch.root 'unused-node' 'unused-module' $mismatch.home} 'refusing to downgrade'
 Check ((Compare-ToPinnedPiVersion '1.5.1-beta.2') -eq -1 -and (Compare-ToPinnedPiVersion '1.5.1+fixture') -eq 0) 'prerelease and build metadata follow version precedence'
 $oldLsp=MakeHost 'old-lsp' '1.5.1' '1.5.1' '1.3.0' '1.3.0'
 $script:fixtureDigest='10b288d4cd2826a8e77520dfbe4e47d29c086c3c85a81bd470a0100c0f49e428'
 Check ((Get-HostPiMode $oldLsp.root 'FixtureNode' 'unused-module' $oldLsp.home) -ceq 'replace') 'verified older LSP is replaced with backup rather than silently reused'
 $currentLsp=MakeHost 'current-lsp' '1.5.1' '1.5.1' '1.4.0' '1.4.0'
 $script:fixtureDigest='06553e705863995121e0a2ad624d61e73b1f773b40a9f12385155e6d548cc4ff'
 Check ((Get-HostPiMode $currentLsp.root 'FixtureNode' 'unused-module' $currentLsp.home) -ceq 'reuse') 'verified Pi and patched LSP runtime is reused'
 $futureLsp=MakeHost 'future-lsp' '1.5.1' '1.5.1' '1.4.0' '1.4.1'
 Reject {Get-HostPiMode $futureLsp.root 'FixtureNode' 'unused-module' $futureLsp.home} 'Existing LSP is newer'
 $unknownLsp=MakeHost 'unknown-lsp' '1.5.1' '1.5.1' 'latest' '1.4.0'
 Reject {Get-HostPiMode $unknownLsp.root 'FixtureNode' 'unused-module' $unknownLsp.home} 'Existing LSP version cannot be safely classified'
 $missingLsp=MakeHost 'missing-lsp' '1.5.1' '1.5.1' '1.4.0' ''
 Reject {Get-HostPiMode $missingLsp.root 'FixtureNode' 'unused-module' $missingLsp.home} 'Existing LSP metadata is incomplete'
 $custom=MakeHost 'custom-lsp' '1.5.1' '1.5.1' '1.3.0' '1.3.0'
 $customPackage=Join-Path $custom.root 'package.json';$customData=Get-Content -LiteralPath $customPackage -Raw|ConvertFrom-Json -AsHashtable;$customData.dependencies['custom-provider']='1.0.0';$customData|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $customPackage -Encoding utf8NoBOM
 $script:fixtureDigest='10b288d4cd2826a8e77520dfbe4e47d29c086c3c85a81bd470a0100c0f49e428'
 Reject {Get-HostPiMode $custom.root 'FixtureNode' 'unused-module' $custom.home} 'custom dependencies or files'
 Check ([IO.File]::ReadAllText((Join-Path $custom.root 'node_modules/fixture-marker')) -ceq 'preserve') 'custom older runtime remains unchanged on refusal'
 $script:fixtureDigest=('0'*64)
 Reject {Get-HostPiMode $currentLsp.root 'FixtureNode' 'unused-module' $currentLsp.home} 'unrecognized dependency tree'

 $python=(Get-Command python.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1 -ExpandProperty Source)
 $guard=Join-Path $PSScriptRoot 'check-pi-downgrade.py';$wslRoot=Join-Path $fixture 'wsl';$metadata=Join-Path $wslRoot 'node_modules/@earendil-works/pi-coding-agent/package.json';New-Item -ItemType Directory -Path $wslRoot -Force|Out-Null
 & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -eq 0) 'fresh WSL Pi is allowed'
 New-Item -ItemType Directory -Path (Split-Path -Parent $metadata) -Force|Out-Null
 & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -ne 0) 'incomplete WSL Pi is preserved'
 $lspMetadata=Join-Path $wslRoot 'node_modules/pi-lsp-extension/package.json';New-Item -ItemType Directory -Path (Split-Path -Parent $lspMetadata) -Force|Out-Null
 [IO.File]::WriteAllText($lspMetadata,'{"version":"1.3.0"}')
 foreach($version in @('0.84.4','1.5.1','1.5.1-beta.1')){
  [IO.File]::WriteAllText($metadata,('{"version":"'+$version+'"}')); & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -eq 0) ('WSL permits '+$version)
 }
 foreach($version in @('1.5.2','2.0.0','latest','1.5.1-beta..x','1.5.1-01')){
  [IO.File]::WriteAllText($metadata,('{"version":"'+$version+'"}')); & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -ne 0) ('WSL rejects '+$version)
 }
 [IO.File]::WriteAllText($metadata,'{"version":"1.5.1"}')
 foreach($version in @('1.3.0','1.4.0','1.4.0-beta.1')){
  [IO.File]::WriteAllText($lspMetadata,('{"version":"'+$version+'"}')); & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -eq 0) ('WSL permits LSP '+$version)
 }
 foreach($version in @('1.4.1','1.5.0','latest','1.4.0-01')){
  [IO.File]::WriteAllText($lspMetadata,('{"version":"'+$version+'"}')); & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -ne 0) ('WSL rejects LSP '+$version)
 }
 [IO.File]::WriteAllText($lspMetadata,'{"version":"1.3.0"}')
 $wslPackage=Join-Path $wslRoot 'package.json';[IO.File]::WriteAllText($wslPackage,'{"dependencies":{"@earendil-works/pi-coding-agent":"1.5.1","pi-lsp-extension":"1.3.0","custom-provider":"1.0.0"}}')
 & $python $guard $wslRoot '1.5.1' 2>&1 | Out-Null;Check ($LASTEXITCODE -ne 0) 'WSL custom dependencies are preserved'
 $scriptText=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'provision-wsl.sh') -Raw
 $guardAt=$scriptText.IndexOf('python3 /tmp/pi-kether-install/check-pi-downgrade.py');$treeAt=$scriptText.IndexOf('/opt/node/bin/node /tmp/pi-kether-install/check-pi-runtime-tree.mjs');$aptAt=$scriptText.IndexOf('apt-get update')
 Check ($guardAt -ge 0 -and $treeAt -gt $guardAt -and $aptAt -gt $treeAt) 'WSL version and dependency-tree guards run before package provisioning'
 $node=(Get-Command node.exe -CommandType Application -ErrorAction Stop|Select-Object -First 1 -ExpandProperty Source)
 $treeGuard=Join-Path $repo 'payload/pi-dispatch/scripts/check-pi-runtime-tree.mjs'
 & $node $treeGuard (Join-Path $wslRoot 'node_modules') 2>&1 | Out-Null
 Check ($LASTEXITCODE -ne 0) 'unrecognized WSL dependency trees are preserved'
 Write-Output "PASS: $checks Pi downgrade checks; isolated fixtures only."
}finally{
 if(Test-Path -LiteralPath $fixture){$resolved=(Resolve-Path -LiteralPath $fixture).Path;if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
