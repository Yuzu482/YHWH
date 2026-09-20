#Requires -Version 7.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$plugin=Join-Path $root 'payload/pi-dispatch'
$runner=Join-Path $PSScriptRoot 'Invoke-Headless.ps1'
$scratch=Join-Path $root ('.test/headless-package-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  # Reproduce just this feature's packaged files in an isolated installation.
  foreach($relative in @('scripts/headless-host.mjs','scripts/headless-adapters.mjs','workflow/headless.example.json','workflow/catalog.json')) {
    $destination=Join-Path $scratch $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $plugin $relative) -Destination $destination
  }
  $report=& $runner -Action Doctor -PluginRoot $scratch -ConfigFile (Join-Path $scratch 'workflow/headless.example.json') | ConvertFrom-Json
  if($report.modelCalls -ne 0 -or @($report.clients.psobject.Properties.Value | Where-Object status -ne 'disabled').Count){throw 'Default doctor must be inert.'}
  $parity=& $runner -Action Compare -ComparePluginRoot $scratch | ConvertFrom-Json
  if($parity.status -ne 'matched'){throw 'Packaged feature must match source.'}
  Add-Content -LiteralPath (Join-Path $scratch 'scripts/headless-adapters.mjs') -Value '// drift fixture'
  $rejected=$false
  try { & $runner -Action Compare -ComparePluginRoot $scratch | Out-Null } catch { $rejected=$true }
  if(-not $rejected){throw 'Installed drift was not rejected.'}
  Write-Host '[PASS] Headless wrapper, inert defaults, isolated packaged runtime and installed drift detection.'
} finally {
  $resolved=[IO.Path]::GetFullPath($scratch)
  $expected=[IO.Path]::GetFullPath((Join-Path $root '.test'))+[IO.Path]::DirectorySeparatorChar
  if(-not $resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture cleanup path.'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
$global:LASTEXITCODE=0
