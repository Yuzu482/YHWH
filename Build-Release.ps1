[CmdletBinding()]
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'portable.manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version.' }
$release = Join-Path $root 'release'
New-Item -ItemType Directory -Force -Path $release | Out-Null

& (Join-Path $root 'install\Test-PiKether.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Portable self-test failed.' }
& (Join-Path $root 'install\Test-WorkflowConfig.ps1')
& (Join-Path $root 'install\Sync-HostWorkflow.ps1') -Check

$plugin = Join-Path $root 'payload\pi-dispatch'
if (-not $SkipTests) {
  Push-Location $plugin
  try {
    npm ci --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    # Match the documented release baseline; HTTP tests share process resources.
    node --test --test-concurrency=1 tests/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Plugin tests failed.' }
  } finally { Pop-Location }
}

$validator = Join-Path $HOME '.codex\skills\.system\plugin-creator\scripts\validate_plugin.py'
if (Test-Path -LiteralPath $validator) {
  $validatorDeps = Join-Path ([IO.Path]::GetTempPath()) ('pi-kether-validator-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $validatorDeps | Out-Null
  $oldPythonPath = $env:PYTHONPATH
  try {
    python -m pip install --quiet --disable-pip-version-check --target $validatorDeps PyYAML==6.0.2
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the Codex plugin validator.' }
    $env:PYTHONPATH = $validatorDeps
    python $validator $plugin
    if ($LASTEXITCODE -ne 0) { throw 'Codex plugin validation failed.' }
  } finally {
    $env:PYTHONPATH = $oldPythonPath
    $resolvedDeps = [IO.Path]::GetFullPath($validatorDeps)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedDeps.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedDeps)) {
      Remove-Item -LiteralPath $resolvedDeps -Recurse -Force
    }
  }
}

$stageBase = Join-Path ([IO.Path]::GetTempPath()) ('pi-kether-build-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $stageBase 'pi-kether-portable'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  # Enumerate by allowlist and prune local state even when -SkipTests is used.
  $allowed = @('install','payload','templates','docs','.readme-assets','Workflow.ps1','Build-Release.ps1','Build-OneClick.ps1','Install-YHWH.ps1','Install.cmd','install.config.example.json','portable.manifest.json','README.md','README.en.md','VERIFICATION.md','SECURITY-HARDENING.md','THIRD_PARTY.md','.gitignore')
  function Copy-ReleaseTree([string]$Source, [string]$Destination) {
    $item = Get-Item -LiteralPath $Source -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing release symlink: $Source" }
    if ($item.Name -match '^(node_modules|\.git|\.test|\.runtime|diagnostics|release)$|^\.env|^auth\.json$|\.local\.|\.(log|bak|backup|pyc)$|^(?:.*token|.*key).*\.txt$') { return }
    if ($item.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $Destination | Out-Null
      foreach ($child in Get-ChildItem -LiteralPath $Source -Force) { Copy-ReleaseTree $child.FullName (Join-Path $Destination $child.Name) }
    } else { Copy-Item -LiteralPath $Source -Destination $Destination }
  }
  foreach ($name in $allowed) { Copy-ReleaseTree (Join-Path $root $name) (Join-Path $stage $name) }
  $zip = Join-Path $release "pi-kether-portable-$version.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
  [ordered]@{
    name = 'pi-kether-portable'; version = $version; file = [IO.Path]::GetFileName($zip)
    sha256 = $hash; builtAt = (Get-Date).ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding utf8NoBOM
  Write-Host "Release: $zip"
  Write-Host "SHA256: $hash"
  & (Join-Path $root 'Build-OneClick.ps1') -PortableZip $zip
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'install\Test-OneClick.ps1') -Installer (Join-Path $release "Install-YHWH-$version.ps1")
  if ($LASTEXITCODE -ne 0) { throw 'Generated one-click installer validation failed.' }
} finally {
  $resolvedBase = [IO.Path]::GetFullPath($stageBase)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedBase.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stageBase)) {
    Remove-Item -LiteralPath $stageBase -Recurse -Force
  }
}
