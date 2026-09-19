#requires -Version 5.1
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
foreach($name in @('Set-ProviderApiKey.ps1','Set-ProviderConfig.ps1','Open-YhwhProviders.ps1')){
 $errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$null,[ref]$errors)
 if($errors){throw ('Script parse failed: '+$name)}
 if($name -eq 'Set-ProviderApiKey.ps1'){foreach($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}}
}
$fixture=Join-Path $repo ('.test/providers-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
function Save([string]$Ref,[string]$Value){$secure=ConvertTo-SecureString $Value -AsPlainText -Force;try{Set-YhwhProviderApiKey -HomePath $fixture -ApiKey $secure -Reference $Ref}finally{$secure.Dispose()}}
Save 'opencode-go' ('fake_a_'+'x'*30)
Save 'commandcode' ('fake_b_'+'x'*30)
Save 'opencode-go' ('fake_c_'+'x'*30)
$file=Join-Path $fixture '.local/state/pi-kether/provider-credentials.json'
$data=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
if((Unprotect-YhwhApiKey $data.'opencode-go' Provider opencode-go) -cne ('fake_c_'+'x'*30) -or (Unprotect-YhwhApiKey $data.commandcode Provider commandcode) -cne ('fake_b_'+'x'*30)){throw 'Rotation lost a credential.'}
$acl=Get-Acl -LiteralPath $file
if(-not $acl.AreAccessRulesProtected){throw 'ACL inheritance enabled.'}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach($rule in $acl.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unexpected ACL principal.'}}
$before=(Get-FileHash -LiteralPath $file).Hash
$rejected=$false;try{Save 'opencode-go' '!bad'}catch{$rejected=$true}
if(-not $rejected -or (Get-FileHash -LiteralPath $file).Hash -ne $before){throw 'Invalid rotation modified store.'}
$config=Get-Content -LiteralPath (Join-Path $repo 'templates/provider-config.example.json') -Raw | ConvertFrom-Json
foreach($route in $config.routes.PSObject.Properties){$route.Value.capabilities.maxThinking=$true}
$source=Join-Path $fixture 'example.json';$config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $source -Encoding UTF8
& (Join-Path $PSScriptRoot 'Set-ProviderConfig.ps1') -TargetHome $fixture -ConfigPath $source
$installed=Join-Path $fixture '.local/state/pi-kether/provider-config.json'
$before=(Get-FileHash -LiteralPath $installed).Hash
$config.routes.'yhwh-worker-api'.baseUrl='https://wrong.example/v1';$config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $source -Encoding UTF8
$rejected=$false;try{& (Join-Path $PSScriptRoot 'Set-ProviderConfig.ps1') -TargetHome $fixture -ConfigPath $source}catch{$rejected=$true}
if(-not $rejected -or (Get-FileHash -LiteralPath $installed).Hash -ne $before){throw 'Invalid config replaced installed config.'}
if(@(Get-ChildItem -LiteralPath (Split-Path -Parent $file) -Filter '*.tmp').Count){throw 'Temporary files leaked.'}
Write-Host '[PASS] Provider setup: PS5.1 syntax, opaque fake keys, independent references, protected ACL, rotation preservation, config install, invalid config preservation, cleanup. No network/model calls.'
exit 0
