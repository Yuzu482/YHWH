#requires -Version 5.1
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'payload/pi-dispatch/scripts/ApiCredentialStore.ps1')
$fixture=Join-Path $repo ('.test/encryption-'+[guid]::NewGuid().ToString('N'))
$dir=Join-Path $fixture '.local/state/pi-kether';New-Item -ItemType Directory -Path $dir -Force|Out-Null
$secret='encryption_fixture_'+'x'*32
$cipher=Protect-YhwhApiKey $secret Provider fixture
if((Unprotect-YhwhApiKey $cipher Provider fixture) -cne $secret){throw 'Roundtrip failed'}
$wrong=$false;try{$null=Unprotect-YhwhApiKey $cipher Provider other}catch{$wrong=$_.Exception.Message -eq 'PI_AUTH_DECRYPT_FAILED'}
if(-not $wrong){throw 'Slot substitution accepted'}
$bytes=[Convert]::FromBase64String($cipher.ciphertext);$bytes[$bytes.Length-8]=$bytes[$bytes.Length-8] -bxor 1
$bad=@{type='api_key_dpapi';version=1;scope='CurrentUser';ciphertext=[Convert]::ToBase64String($bytes)}
$rejected=$false;try{$null=Unprotect-YhwhApiKey $bad Provider fixture}catch{$rejected=$true}
if(-not $rejected){throw 'Tampered ciphertext accepted'}
$legacy=@{fixture=@{type='api_key';key=$secret};other=@{type='api_key';key='other_fixture_'+'y'*32}}
$file=Join-Path $dir 'provider-credentials.json'
$legacy|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $file -Encoding UTF8
& (Join-Path $PSScriptRoot 'Migrate-ApiCredentials.ps1') -TargetHome $fixture
$raw=Get-Content -LiteralPath $file -Raw
if($raw.Contains($secret) -or $raw.Contains('other_fixture_')){throw 'Plaintext remains'}
$store=Read-YhwhApiStore $file
if((Unprotect-YhwhApiKey $store.fixture Provider fixture) -cne $secret){throw 'Migrated value changed'}
$before=(Get-FileHash -LiteralPath $file).Hash
& (Join-Path $PSScriptRoot 'Migrate-ApiCredentials.ps1') -TargetHome $fixture
if((Get-FileHash -LiteralPath $file).Hash -ne $before){throw 'Migration not idempotent'}
# Invalid legacy input must preserve the original file, without a backup containing keys.
[IO.File]::WriteAllText($file,'{"fixture":{"type":"api_key","key":"invalid"}}')
$before=(Get-FileHash -LiteralPath $file).Hash
$rejected=$false;try{& (Join-Path $PSScriptRoot 'Migrate-ApiCredentials.ps1') -TargetHome $fixture}catch{$rejected=$true}
if(-not $rejected -or (Get-FileHash -LiteralPath $file).Hash -ne $before){throw 'Failed migration changed original'}
if(@(Get-ChildItem -LiteralPath $dir -File).Count -ne 1){throw 'Unexpected backup/temp file'}
Write-Host '[PASS] Real DPAPI roundtrip, wrong-slot/tamper rejection, encrypted migration, no plaintext output, idempotence, failed migration preservation, no backup/temp leakage. Fixtures only.'
