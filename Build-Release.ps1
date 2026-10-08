#requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipTests,[switch]$PublicRelease,[string]$OutputDirectory=(Join-Path $PSScriptRoot 'release'))
$ErrorActionPreference = 'Stop'
function Invoke-ValidationProcess {
  param([string]$FilePath,[string[]]$Arguments,[int]$TimeoutSeconds,[string]$WorkingDirectory=(Get-Location).Path,[Text.Encoding]$StreamEncoding=[Text.Encoding]::UTF8)
  if($TimeoutSeconds -le 0){throw 'TimeoutSeconds must be positive.'}
  $p=$null; $outTask=$null; $errTask=$null; $timedOut=$false; $errorText=''; $status=$null; $signal=''; $stdout=''; $stderr=''
  try {
    $info=[Diagnostics.ProcessStartInfo]::new(); $info.FileName=$FilePath; $info.WorkingDirectory=$WorkingDirectory
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=$StreamEncoding; $info.StandardErrorEncoding=$StreamEncoding
    $legacyPath=[IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'))
    if([string]::Equals([IO.Path]::GetFullPath($FilePath),$legacyPath,[StringComparison]::OrdinalIgnoreCase)){$info.Environment.Remove('PSModulePath')|Out-Null}
    foreach($arg in $Arguments){[void]$info.ArgumentList.Add($arg)}
    $p=[Diagnostics.Process]::new(); $p.StartInfo=$info
    if(-not $p.Start()){throw 'Process.Start returned false.'}
    $outTask=$p.StandardOutput.ReadToEndAsync(); $errTask=$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit($TimeoutSeconds*1000)){$timedOut=$true; try{$p.Kill($true)}catch{}; [void]$p.WaitForExit(5000)}
    if($p.HasExited){$status=$p.ExitCode}else{$signal='child did not terminate within bounded reap period'}
    if($outTask.Wait(5000)){$stdout=$outTask.Result}else{$signal='stdout drain timed out'}
    if($errTask.Wait(5000)){$stderr=$errTask.Result}else{$signal='stderr drain timed out'}
  } catch {$errorText=$_.Exception.Message}
  finally {if($p){try{if(-not $p.HasExited){$p.Kill($true);[void]$p.WaitForExit(5000)}}catch{}; $p.Dispose()}}
  [pscustomobject]@{status=$status;signal=$signal;stdout=$stdout;stderr=$stderr;error=$errorText;timedOut=$timedOut}
}
function Test-ValidationSuccess { param($Result) return ($null -ne $Result -and $Result.status -eq 0 -and -not $Result.error -and -not $Result.signal -and -not $Result.timedOut) }
function Assert-ValidationSuccess { param($Result,[string]$Executable,[int]$TimeoutSeconds) if(-not (Test-ValidationSuccess $Result)){ $code=if($null -eq $Result.status){'unknown'}else{'{0} (0x{0:X})' -f $Result.status}; throw "Validation failed: executable='$Executable' timeout=${TimeoutSeconds}s status=$code signal='$($Result.signal)' timedOut=$($Result.timedOut) error='$($Result.error)'`nstdout:`n$($Result.stdout)`nstderr:`n$($Result.stderr)" }; if($Result.stdout){Write-Host $Result.stdout}; if($Result.stderr){Write-Host $Result.stderr} }
$pwsh=Join-Path $PSHOME 'pwsh.exe'
if(-not (Test-Path -LiteralPath $pwsh) -or $PSVersionTable.PSVersion.Major -lt 7){throw 'Build-Release requires PowerShell 7 at its current engine path.'}
$root = $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'portable.manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid release version.' }
$release = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $release | Out-Null

foreach($script in @('Test-PiKether.ps1','Test-HostWorkflowSync.ps1','Test-HindsightWrapper.ps1','Test-WorkflowConfig.ps1','Test-Headless.ps1','Test-PluginVersion.ps1','Test-DeploymentSource.ps1')) {
  $r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root ('install/'+$script))) 300 $root
  Assert-ValidationSuccess $r $pwsh 300
}
$r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'install/Sync-HostWorkflow.ps1'),'-Check') 300 $root
Assert-ValidationSuccess $r $pwsh 300
$ps51=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$codePageResult=Invoke-ValidationProcess $ps51 @('-NoProfile','-Command','[Console]::Write([Console]::OutputEncoding.CodePage)') 60 $root
Assert-ValidationSuccess $codePageResult $ps51 60
if($codePageResult.stdout -notmatch '^\d+$'){throw "Invalid Windows PowerShell output code page: '$($codePageResult.stdout)'"}
$ps51Encoding=[Text.Encoding]::GetEncoding([int]$codePageResult.stdout)
foreach($script in @('Test-ClaudeApiSetup.ps1','Test-ProviderSetup.ps1','Test-ApiEncryption.ps1')) {
  $path=Join-Path $root ('install/'+$script)
  $r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',$path) 60 $root
  Assert-ValidationSuccess $r $pwsh 60
  Write-Host "Windows PowerShell 5.1 compatibility: $script"
  $r=Invoke-ValidationProcess $ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',$path) 60 $root $ps51Encoding
  Assert-ValidationSuccess $r $ps51 60
}
$r=Invoke-ValidationProcess $ps51 @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'Install-YHWH.ps1'),'-PlanOnly') 60 $root $ps51Encoding
Assert-ValidationSuccess $r $ps51 60

$licenseArgs=@('--check')
if($PublicRelease){$licenseArgs+='--public'}
node (Join-Path $root 'install/license-inventory.mjs') @licenseArgs
if ($LASTEXITCODE -ne 0) { throw 'License inventory validation failed.' }

$plugin = Join-Path $root 'payload\pi-dispatch'
if (-not $SkipTests) {
  Push-Location $plugin
  try {
    npm ci --ignore-scripts=false
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    # Match the documented release baseline; HTTP tests share process resources.
    node --test --test-concurrency=1 tests/*.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Plugin tests failed.' }
    node --expose-gc tests/memory-regression.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Plugin memory regression failed.' }
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
  $allowed = @('install','payload','templates','docs','.readme-assets','.test','Workflow.ps1','Build-Release.ps1','Build-OneClick.ps1','Install-YHWH.ps1','Install.cmd','install.config.example.json','portable.manifest.json','README.md','README.en.md','VERIFICATION.md','SECURITY-HARDENING.md','THIRD_PARTY.md','THIRD_PARTY.en.md','LICENSE','NOTICE','licenses','.gitignore')
  # Use only paths recorded in the Git index; never recursively enumerate local trees.
  $gitInfo = New-Object System.Diagnostics.ProcessStartInfo
  $gitInfo.FileName = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $gitInfo.Arguments = ' -c safe.directory="' + $root.Replace('"','\"') + '" ls-files -z'
  $gitInfo.WorkingDirectory = $root
  $gitInfo.UseShellExecute = $false
  $gitInfo.CreateNoWindow = $true
  $gitInfo.RedirectStandardOutput = $true
  $gitInfo.RedirectStandardError = $true
  $gitInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $gitInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
  $gitProcess = New-Object System.Diagnostics.Process
  $gitProcess.StartInfo = $gitInfo
  try {
    if (-not $gitProcess.Start()) { throw 'Could not start git.' }
    $trackedOutput = $gitProcess.StandardOutput.ReadToEnd()
    $gitError = $gitProcess.StandardError.ReadToEnd()
    $gitProcess.WaitForExit()
    if ($gitProcess.ExitCode -ne 0) { throw "git ls-files failed: $gitError" }
  } catch { throw "Cannot enumerate tracked release files; refusing to build: $($_.Exception.Message)" }
  finally { $gitProcess.Dispose() }
  $allowedSet = @{}
  foreach ($name in $allowed) { $allowedSet[$name] = $true }
  foreach ($relative in ($trackedOutput -split "`0")) {
    if (-not $relative) { continue }
    $relative = $relative.Replace('\\','/')
    if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)') { throw "Unsafe tracked path: $relative" }
    $parts = $relative.Split('/')
    if (-not $allowedSet.ContainsKey($parts[0])) { continue }
    $isBaselineFile = $relative -eq '.test/baseline-failures.json'
    $skip = $false
    foreach ($part in $parts) {
      if ($part -match '^(node_modules|\.git|\.runtime|diagnostics|release)$|^\.env|^auth\.json$|^(anthropic-api-key|provider-config|provider-credentials)\.json$|\.local\.|\.(log|bak|backup|pyc)$|^(?:.*token|.*key).*\.txt$') { $skip = $true; break }
      if ($part -eq '.test' -and -not $isBaselineFile) { $skip = $true; break }
    }
    if ($skip) { continue }
    $source = Join-Path $root ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $item = Get-Item -LiteralPath $source -Force -ErrorAction Stop
    if ($item.PSIsContainer) { continue }
    $checkPath = $source
    while ($checkPath -and $checkPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
      $checkItem = Get-Item -LiteralPath $checkPath -Force -ErrorAction Stop
      if ($checkItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing release symlink: $checkPath" }
      if ([IO.Path]::GetFullPath($checkPath).TrimEnd([IO.Path]::DirectorySeparatorChar) -eq [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)) { break }
      $checkPath = Split-Path -Parent $checkPath
    }
    $destination = Join-Path $stage ($relative.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
  & (Join-Path $root 'install\Stamp-PluginVersion.ps1') -SourceRepositoryRoot $root -StagingPackageRoot $stage | Out-Null
  $provenanceData = Get-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Raw | ConvertFrom-Json
  $zip = Join-Path $release "pi-kether-portable-$version.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $([IO.Path]::GetFileName($zip))" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
  [ordered]@{
    name = 'pi-kether-portable'; version = $version; file = [IO.Path]::GetFileName($zip)
    sha256 = $hash; builtAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceCommit = $provenanceData.sourceCommit; shortHash = $provenanceData.shortHash
    dirty = $provenanceData.dirty; pluginVersion = $provenanceData.pluginVersion
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $release 'release-manifest.json') -Encoding utf8NoBOM
  Write-Host "Release: $zip"
  Write-Host "SHA256: $hash"
  $r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'Build-OneClick.ps1'),'-PortableZip',$zip) 300 $root
  Assert-ValidationSuccess $r $pwsh 300
  $r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'install/Test-OneClick.ps1'),'-Installer',(Join-Path $release "Install-YHWH-$version.ps1")) 180 $root
  Assert-ValidationSuccess $r $pwsh 180
} finally {
  $resolvedBase = [IO.Path]::GetFullPath($stageBase)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedBase.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stageBase)) {
    Remove-Item -LiteralPath $stageBase -Recurse -Force
  }
}
