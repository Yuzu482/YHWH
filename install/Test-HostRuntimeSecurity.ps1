#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$allowed=[IO.Path]::GetFullPath((Join-Path $repo '.test')).TrimEnd('\')+'\'
$fixture=Join-Path $allowed ('pi-runtime-security-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture path.'}
New-Item -ItemType Directory -Path $fixture -Force|Out-Null
$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Install-PiKether.ps1'),[ref]$null,[ref]$errors)
if($errors){throw 'Installer did not parse.'}
foreach($fn in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){
 if($fn.Name -in @('Assert-Under','Assert-NoReparse')){. ([scriptblock]::Create($fn.Extent.Text))}
}
. (Join-Path $PSScriptRoot 'HostRuntimeSecurity.ps1')
$checks=0
function Check([bool]$Ok,[string]$Name){if(-not $Ok){throw "FAIL: $Name"};$script:checks++;Write-Output "PASS: $Name"}
function MakeRuntime([string]$Path,[string]$Content){
 New-Item -ItemType Directory -Force -Path (Join-Path $Path 'node_modules/.bin'),(Join-Path $Path 'node_modules/fixture')|Out-Null
 foreach($name in @('package.json','package-lock.json','node_modules/.package-lock.json','node_modules/.bin/fixture','node_modules/fixture/file.js')){[IO.File]::WriteAllText((Join-Path $Path $name),$Content)}
}
try {
 $target=Join-Path $fixture 'npm';$stage=Join-Path $fixture '.npm-stage-test';$backupRoot=Join-Path $fixture 'backups';$backup=Join-Path $backupRoot 'npm'
 MakeRuntime $target 'old';MakeRuntime $stage 'new';New-Item -ItemType Directory -Path $backupRoot|Out-Null
 Assert-HostRuntimeSecurityPreserved $target $stage $fixture
 Check $true 'matching owner, group and permissions allow prepared replacement'
 Publish-HostRuntime $target $stage $backup $fixture $backupRoot
 Check ([IO.File]::ReadAllText((Join-Path $target 'node_modules/fixture/file.js')) -ceq 'new') 'prepared runtime is activated'
 Check ([IO.File]::ReadAllText((Join-Path $backup 'node_modules/fixture/file.js')) -ceq 'old') 'original runtime remains in backup'
 $old2=Join-Path $fixture 'old2';$new2=Join-Path $fixture 'stage2';MakeRuntime $old2 'old';MakeRuntime $new2 'new'
 $changed=Join-Path $new2 'node_modules/fixture/file.js';$acl=Get-Acl -LiteralPath $changed;$acl.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $changed -AclObject $acl
 $rejected=$false;try { Assert-HostRuntimeSecurityPreserved $old2 $new2 $fixture } catch {$rejected=$_.Exception.Message.Contains('permissions or owners differ');if(-not $rejected){throw}}
 Check $rejected 'permission mismatch is refused'
 Check ((Test-Path -LiteralPath $old2) -and (Test-Path -LiteralPath $new2) -and [IO.File]::ReadAllText((Join-Path $old2 'node_modules/fixture/file.js')) -ceq 'old') 'refusal preserves the original runtime and prepared files'
 $old3=Join-Path $fixture 'old3';$new3=Join-Path $fixture 'stage3';$backup3=Join-Path $backupRoot 'old3';MakeRuntime $old3 'old';MakeRuntime $new3 'new'
 $script:fixtureMoveCount=0
 function Move-Item {param([string]$LiteralPath,[string]$Destination);$script:fixtureMoveCount++;if($script:fixtureMoveCount -eq 2){throw 'synthetic activation failure'};Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination}
 $failed=$false;try {Publish-HostRuntime $old3 $new3 $backup3 $fixture $backupRoot}catch{$failed=$_.Exception.Message.Contains('synthetic activation failure');if(-not $failed){throw}}finally{Remove-Item Function:\Move-Item -ErrorAction SilentlyContinue}
 Check ($failed -and (Test-Path -LiteralPath $old3) -and (Test-Path -LiteralPath $new3) -and -not (Test-Path -LiteralPath $backup3) -and [IO.File]::ReadAllText((Join-Path $old3 'node_modules/fixture/file.js')) -ceq 'old') 'failed activation restores the original runtime'
 $securityHome=Join-Path $fixture 'security-home';$agent=Join-Path $securityHome '.pi/agent';$state=Join-Path $securityHome '.local/state/pi-kether';New-Item -ItemType Directory -Path $agent,$state -Force|Out-Null
 $beforeAcl=(Get-Acl -LiteralPath $agent).Sddl;$rejected=$false
 try {& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome -CheckOnly}catch{$rejected=$_.Exception.Message.Contains('permissions would change');if(-not $rejected){throw}}
 Check ($rejected -and (Get-Acl -LiteralPath $agent).Sddl -ceq $beforeAcl) 'state security preflight rejects without changing existing permissions'
 & (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome
 $protectedAcl=(Get-Acl -LiteralPath $agent).Sddl;& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome -CheckOnly
 Check ((Get-Acl -LiteralPath $agent).Sddl -ceq $protectedAcl) 'already protected state passes preflight without rewriting permissions'
 $expectedSids=@(@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')|Sort-Object -Unique)
 $agentRules=@((Get-Acl -LiteralPath $agent).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 $actualSids=@($agentRules|ForEach-Object {$_.IdentityReference.Value}|Sort-Object -Unique)
 $allFull=@($agentRules|Where-Object {$_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$_.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl}).Count -eq 0
 Check ($agentRules.Count -eq $expectedSids.Count -and ($actualSids -join ',') -ceq ($expectedSids -join ',') -and $allFull) 'state ACL grants full control to exactly the distinct required identities'
 $statePolicy=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($state),[Security.AccessControl.AccessControlSections]::Access);$extraSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
 $extraRule=[Security.AccessControl.FileSystemAccessRule]::new($extraSid,[Security.AccessControl.FileSystemRights]160,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $statePolicy.AddAccessRule($extraRule);[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($state),$statePolicy);$stateBefore=(Get-Acl -LiteralPath $state).Sddl
 & (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome -CheckOnly
 & (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome
 Check ((Get-Acl -LiteralPath $state).Sddl -ceq $stateBefore) 'existing non-inherited traversal-only sandbox grant is preserved exactly'
 $statePolicy=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($state),[Security.AccessControl.AccessControlSections]::Access);$writeRule=[Security.AccessControl.FileSystemAccessRule]::new($extraSid,[Security.AccessControl.FileSystemRights]::WriteData,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $statePolicy.AddAccessRule($writeRule);[IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($state),$statePolicy);$unsafeBefore=(Get-Acl -LiteralPath $state).Sddl;$unsafeRejected=$false
 try {& (Join-Path $PSScriptRoot 'Protect-PiState.ps1') -TargetHome $securityHome -CheckOnly}catch{$unsafeRejected=$_.Exception.Message.Contains('permissions would change');if(-not $unsafeRejected){throw}}
 Check ($unsafeRejected -and (Get-Acl -LiteralPath $state).Sddl -ceq $unsafeBefore) 'additional write permission is rejected without modifying the state directory'
 $installer=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-PiKether.ps1') -Raw
 Check ($installer.IndexOf('Protect-PiState.ps1'') -TargetHome $TargetHome -CheckOnly') -lt $installer.IndexOf('New-Item -ItemType Directory -Force -Path $TargetHome')) 'state security preflight runs before target mutation'
 Check ($installer.IndexOf('assert-existing-plugin.mjs') -lt $installer.IndexOf('New-Item -ItemType Directory -Force -Path $TargetHome')) 'existing plugin preflight runs before target mutation'
 Check ($installer.IndexOf('Assert-HostRuntimeSecurityPreserved $hostPiRoot $preparedPi $TargetHome') -lt $installer.IndexOf('Copy-WithBackup $installationSource $pluginTarget $backupRoot')) 'runtime security preflight runs before plugin replacement'
 Write-Output "PASS: $checks Windows runtime security checks; isolated fixtures only."
} finally {
 if(Test-Path -LiteralPath $fixture){$resolved=(Resolve-Path -LiteralPath $fixture).Path;if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
}
