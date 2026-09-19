#requires -Version 5.1
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
$source=Join-Path $PSScriptRoot 'Set-ClaudeApiKey.ps1'
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$null,[ref]$parseErrors)
if($parseErrors){throw 'API setup script does not parse.'}
foreach($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)){. ([scriptblock]::Create($fn.Extent.Text))}
$fixture=Join-Path $repo ('.test/api-setup-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$file=Join-Path $fixture '.local/state/pi-kether/anthropic-api-key.json'
function Set-Fixture([string]$Value){
 $secure=ConvertTo-SecureString -String $Value -AsPlainText -Force
 try{Set-YhwhClaudeApiKey -HomePath $fixture -ApiKey $secure}finally{$secure.Dispose()}
}
$rejected=$false
try{Set-Fixture ('sk-ant-oat01-'+'fixture')}catch{$rejected=$true}
if(-not $rejected -or (Test-Path -LiteralPath $file)){throw 'Subscription input must fail before writing.'}
$first='sk-ant-api03-'+('fixtureA'*8)
Set-Fixture $first
$data=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
if($data.anthropic.type -ne 'api_key_dpapi' -or (Unprotect-YhwhApiKey $data.anthropic Anthropic anthropic) -cne $first -or (Get-Content -LiteralPath $file -Raw).Contains($first)){throw 'API fixture was not saved exactly.'}
$acl=Get-Acl -LiteralPath $file
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if(-not $acl.AreAccessRulesProtected){throw 'Credential ACL must disable inheritance.'}
foreach($rule in $acl.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'Unexpected credential principal.'}}
$second='sk-ant-api03-'+('fixtureB'*8)
Set-Fixture $second
if((Unprotect-YhwhApiKey (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).anthropic Anthropic anthropic) -cne $second){throw 'API fixture rotation failed.'}
$before=(Get-FileHash -LiteralPath $file).Hash
try{Set-Fixture 'invalid'}catch{}
if((Get-FileHash -LiteralPath $file).Hash -ne $before){throw 'Invalid replacement changed the existing key.'}
if(@(Get-ChildItem -LiteralPath (Split-Path -Parent $file) -Filter '*.tmp').Count){throw 'Temporary key files leaked.'}
Write-Host '[PASS] API setup: PS5.1 syntax, invalid/subscription rejection before write, exact save, protected current-user ACL, rotation, failed-rotation preservation, temporary cleanup. Fixture keys only; no model calls.'
