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
[IO.File]::WriteAllText($output, $script, [Text.UTF8Encoding]::new($true))
$installerHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
"$installerHash  $fileName" | Set-Content -LiteralPath "$output.sha256" -Encoding ascii
$cmd = '@echo off' + "`r`n" + ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + $fileName + '" %*') + "`r`n" + 'set "YHWH_EXIT=%ERRORLEVEL%"' + "`r`n" + 'pause' + "`r`n" + 'exit /b %YHWH_EXIT%' + "`r`n"
$launcher = Join-Path (Split-Path -Parent $archive) 'Install-YHWH.cmd'
[IO.File]::WriteAllText($launcher, $cmd, [Text.Encoding]::ASCII)
$bundle = Join-Path (Split-Path -Parent $archive) "YHWH-OneClick-$($manifest.version).zip"
Compress-Archive -LiteralPath @($output, "$output.sha256", $launcher) -DestinationPath $bundle -Force
Write-Host "One-click script: $output"
Write-Host "Double-click bundle: $bundle"
