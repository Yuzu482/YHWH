#requires -Version 5.1
# SPDX-License-Identifier: Apache-2.0
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Add-Type -AssemblyName System.Security
function Get-YhwhCredentialFile([string]$HomePath,[string]$Store) {
 if($Store -notin @('Anthropic','Provider')){throw 'PI_AUTH_INVALID'}
 $name=if($Store -eq 'Anthropic'){'anthropic-api-key.json'}else{'provider-credentials.json'}
 $directory=Join-Path $HomePath '.local/state/pi-kether'
 foreach($part in @($HomePath,(Join-Path $HomePath '.local'),(Join-Path $HomePath '.local/state'),$directory,(Join-Path $directory $name))){
  if((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PI_AUTH_INVALID'}
 }
 return (Join-Path $directory $name)
}
function Assert-YhwhApiKey([string]$Value,[string]$Store) {
 if($Value -cnotmatch '^[A-Za-z0-9._~-]{16,4096}$' -or $Value.StartsWith('sk-ant-oat') -or $Value.Contains("`r") -or $Value.Contains("`n")){throw 'PI_AUTH_INVALID'}
 if($Store -eq 'Anthropic' -and $Value -cnotmatch '^sk-ant-api[0-9]+-[A-Za-z0-9_-]{16,}$'){throw 'PI_AUTH_INVALID'}
}
function Get-YhwhEntropy([string]$Store,[string]$Reference) {
 if($Reference -cnotmatch '^[a-z][a-z0-9-]{0,39}$' -or ($Store -eq 'Anthropic' -and $Reference -ne 'anthropic')){throw 'PI_AUTH_INVALID'}
 return [Text.Encoding]::UTF8.GetBytes('YHWH/API/v1/'+$Store+'/'+$Reference)
}
function Protect-YhwhApiKey([string]$Value,[string]$Store,[string]$Reference) {
 Assert-YhwhApiKey $Value $Store
 $bytes=[Text.Encoding]::UTF8.GetBytes($Value)
 try {
  $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,(Get-YhwhEntropy $Store $Reference),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  return @{type='api_key_dpapi';version=1;scope='CurrentUser';ciphertext=[Convert]::ToBase64String($encrypted)}
 } catch {throw 'PI_AUTH_ENCRYPT_FAILED'} finally {[Array]::Clear($bytes,0,$bytes.Length)}
}
function Unprotect-YhwhApiKey($Entry,[string]$Store,[string]$Reference) {
 if($Entry.type -eq 'api_key'){throw 'PI_AUTH_MIGRATION_REQUIRED'}
 if($Entry.type -ne 'api_key_dpapi' -or $Entry.version -ne 1 -or $Entry.scope -ne 'CurrentUser' -or $Entry.ciphertext -isnot [string] -or $Entry.ciphertext.Length -gt 16384){throw 'PI_AUTH_INVALID'}
 $bytes=$null
 try {
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($Entry.ciphertext),(Get-YhwhEntropy $Store $Reference),[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $value=[Text.Encoding]::UTF8.GetString($bytes)
  Assert-YhwhApiKey $value $Store
  return $value
 } catch {throw 'PI_AUTH_DECRYPT_FAILED'} finally {if($bytes){[Array]::Clear($bytes,0,$bytes.Length)};$value=$null}
}
function Read-YhwhApiStore([string]$File) {
 if(-not(Test-Path -LiteralPath $File)){throw 'PI_AUTH_MISSING'}
 $item=Get-Item -LiteralPath $File
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 262144){throw 'PI_AUTH_INVALID'}
 try {$data=Get-Content -LiteralPath $File -Raw | ConvertFrom-Json}catch{throw 'PI_AUTH_INVALID'}
 if($data -isnot [pscustomobject]){throw 'PI_AUTH_INVALID'}
 $entries=@{}
 foreach($property in $data.PSObject.Properties){
  if($property.Name -cnotmatch '^[a-z][a-z0-9-]{0,39}$'){throw 'PI_AUTH_INVALID'}
  $entries[$property.Name]=$property.Value
 }
 return $entries
}
function Write-YhwhEncryptedStore([string]$File,[hashtable]$Entries) {
 # This writer admits encrypted envelopes only, including temporary files.
 foreach($entry in $Entries.Values){if($entry.type -ne 'api_key_dpapi' -or $entry.scope -ne 'CurrentUser' -or $entry.version -ne 1 -or $entry.key){throw 'PI_AUTH_INVALID'}}
 $directory=Split-Path -Parent $File
 New-Item -ItemType Directory -Force -Path $directory | Out-Null
 $temporary=Join-Path $directory ('encrypted-'+[guid]::NewGuid().ToString('N')+'.tmp')
 try {
  [IO.File]::WriteAllText($temporary,'')
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
  Set-Acl -LiteralPath $temporary -AclObject $acl
  $json=$Entries|ConvertTo-Json -Depth 5 -Compress
  [IO.File]::WriteAllText($temporary,$json,(New-Object Text.UTF8Encoding($false)))
  # Validate the ciphertext file before replacement. Never create a plaintext backup.
  $null=Read-YhwhApiStore $temporary
  if(Test-Path -LiteralPath $File){[IO.File]::Replace($temporary,$File,[NullString]::Value)}else{[IO.File]::Move($temporary,$File)}
  # Replace may retain destination security, so enforce the restricted ACL again.
  $saved=Get-Acl -LiteralPath $File
  if(-not $saved.AreAccessRulesProtected -or @($saved.Access|Where-Object{$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value}).Count){
    $newAcl=New-Object Security.AccessControl.FileSecurity
    $newAcl.SetOwner($sid);$newAcl.SetAccessRuleProtection($true,$false)
    $newAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
    Set-Acl -LiteralPath $File -AclObject $newAcl
  }
 } finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force};$json=$null}
}
function Set-YhwhEncryptedApiKey([string]$HomePath,[string]$Store,[string]$Reference,[Security.SecureString]$ApiKey) {
 $pointer=[IntPtr]::Zero;$value=$null
 try {
  $file=Get-YhwhCredentialFile $HomePath $Store
  $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)
  $value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $encrypted=Protect-YhwhApiKey $value $Store $Reference
  if((Unprotect-YhwhApiKey $encrypted $Store $Reference) -cne $value){throw 'PI_AUTH_ENCRYPT_FAILED'}
  $entries=@{}
  if(Test-Path -LiteralPath $file){$entries=Read-YhwhApiStore $file;foreach($entry in $entries.Values){if($entry.type -ne 'api_key_dpapi'){throw 'PI_AUTH_MIGRATION_REQUIRED'}}}
  $entries[$Reference]=$encrypted
  Write-YhwhEncryptedStore $file $entries
  Write-Host 'API key saved with Windows CurrentUser DPAPI encryption and restricted file permissions. No network/model call.'
 } finally {if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)};$value=$null}
}
