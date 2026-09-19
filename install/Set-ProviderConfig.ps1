#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TargetHome,[Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference='Stop'
# Validate an immutable temporary copy, then publish those same bytes.
$directory=Join-Path $TargetHome '.local/state/pi-kether'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$destination=Join-Path $directory 'provider-config.json'
foreach($path in @($directory,$destination)){
  if((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Configuration paths cannot be links.'}
}
$temporary=Join-Path $directory ('config-'+[guid]::NewGuid().ToString('N')+'.tmp')
try {
  if((Get-Item -LiteralPath $ConfigPath).Length -gt 65536){throw 'Configuration is too large.'}
  Copy-Item -LiteralPath $ConfigPath -Destination $temporary
  & node (Join-Path $PSScriptRoot 'provider-config.mjs') $temporary
  if($LASTEXITCODE -ne 0){throw 'Provider configuration validation failed; existing configuration retained.'}
  Move-Item -LiteralPath $temporary -Destination $destination -Force
  Write-Host 'Provider configuration saved. Defaults are unchanged. Select a configured yhwh API route explicitly; in-flight tasks reject changed configuration.'
} finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
