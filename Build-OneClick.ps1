#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PortableZip)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'portable.manifest.json') -Raw | ConvertFrom-Json
$archive = (Resolve-Path -LiteralPath $PortableZip).Path
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$template = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Install-YHWH.ps1') -Raw
foreach ($marker in @('__YHWH_PAYLOAD_SHA256__','__YHWH_PAYLOAD_BASE64__')) {
  if ([regex]::Matches($template, $marker).Count -ne 1) { throw "Expected exactly one marker: $marker" }
}
$script = $template.Replace('__YHWH_PAYLOAD_SHA256__', $hash).Replace('__YHWH_PAYLOAD_BASE64__', [Convert]::ToBase64String([IO.File]::ReadAllBytes($archive)))
$fileName = "Install-YHWH-$($manifest.version).ps1"
$output = Join-Path (Split-Path -Parent $archive) $fileName
$launcher = Join-Path (Split-Path -Parent $archive) 'Install-YHWH.cmd'
$bundle = Join-Path (Split-Path -Parent $archive) "YHWH-OneClick-$($manifest.version).zip"
foreach($path in @($output,"$output.sha256",$launcher,$bundle)){if(Test-Path -LiteralPath $path){throw 'One-click output already exists; use an empty output directory.'}}
function Write-NewText([string]$Path,[string]$Text,[Text.Encoding]$Encoding) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$writer=[IO.StreamWriter]::new($stream,$Encoding);try{$writer.Write($Text)}finally{$writer.Dispose()}}finally{$stream.Dispose()}
}
Write-NewText $output $script ([Text.UTF8Encoding]::new($true))
$installerHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
Write-NewText "$output.sha256" ("$installerHash  $fileName`r`n") ([Text.Encoding]::ASCII)
$cmd = '@echo off' + "`r`n" + ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + $fileName + '" %*') + "`r`n" + 'set "YHWH_EXIT=%ERRORLEVEL%"' + "`r`n" + 'pause' + "`r`n" + 'exit /b %YHWH_EXIT%' + "`r`n"
Write-NewText $launcher $cmd ([Text.Encoding]::ASCII)
Compress-Archive -LiteralPath @($output, "$output.sha256", $launcher) -DestinationPath $bundle
Write-Host "One-click script: $output"
Write-Host "Double-click bundle: $bundle"
