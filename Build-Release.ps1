#requires -Version 7.0
[CmdletBinding()]
param([switch]$SkipTests,[switch]$PublicRelease,[string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if($PublicRelease -and $SkipTests){throw 'Public release requires the full plugin regression; -SkipTests is allowed only for local preview builds.'}
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
$release = if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{[IO.Path]::GetFullPath((Join-Path $root ('release/'+$version)))}
foreach($name in @("pi-kether-portable-$version.zip","pi-kether-portable-$version.zip.sha256","Install-YHWH-$version.ps1","Install-YHWH-$version.ps1.sha256","YHWH-OneClick-$version.zip",'Install-YHWH.cmd','release-manifest.json')){
  if(Test-Path -LiteralPath (Join-Path $release $name)){throw "Release output already exists; choose an empty output directory: $name"}
}

# A portable installer must be reproducible from the published main history.
# Existing source-install exceptions remain available only through Workflow.
$admission = & (Join-Path $root 'install/Assert-DeploymentSource.ps1') -PackageRoot $root
if ($admission.dirty -or $admission.mainPolicy.relation -cne 'in-main') { throw 'A clean, pushed mainline source is required for a portable release.' }
# Fail the unchanged public-license gate before creating output or running
# lengthy checks. A preview still receives the regular license inventory check.
$licenseArgs=@('--check')
if($PublicRelease){$licenseArgs+='--public'}
node (Join-Path $root 'install/license-inventory.mjs') @licenseArgs
if ($LASTEXITCODE -ne 0) { throw 'License inventory validation failed.' }
# Several mandatory installer checks import the plugin. Prepare the pinned
# dependencies before those checks, including for a local -SkipTests preview.
$plugin = Join-Path $root 'payload\pi-dispatch'
Push-Location $plugin
try {
  npm ci --ignore-scripts=false
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
} finally { Pop-Location }
New-Item -ItemType Directory -Force -Path $release | Out-Null

foreach($script in @('Test-PiKether.ps1','Test-HostWorkflowSync.ps1','Test-HindsightWrapper.ps1','Test-WorkflowConfig.ps1','Test-Headless.ps1','Test-PluginVersion.ps1','Test-DeploymentSource.ps1','Test-CiReleasePreview.ps1','Test-PackagedAdmission.ps1','Test-ReleaseContentScan.ps1','Test-PiRuntimeDowngrade.ps1','Test-HostRuntimeSecurity.ps1','Test-HostPolicyPreservation.ps1','Test-PiLspPatch.ps1','Test-PublicReleaseGate.ps1')) {
  $r=Invoke-ValidationProcess $pwsh @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root ('install/'+$script))) 300 $root
  Assert-ValidationSuccess $r $pwsh 300
}
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)
$r=Invoke-ValidationProcess $node @('--test',(Join-Path $root 'install/Test-LspLicenseGate.mjs'),(Join-Path $root 'install/Test-ExistingPluginSafety.mjs')) 120 $root
Assert-ValidationSuccess $r $node 120
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

if (-not $SkipTests) {
  Push-Location $plugin
  try {
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
  . (Join-Path $root 'install/DeploymentMainPolicy.ps1')
  . (Join-Path $root 'install/Release-Files.ps1')
  $releaseFiles=@(Get-ReleaseSourceFiles -SourceRoot $root)
  Test-ReleaseSourceBytes -SourceRoot $root -Files $releaseFiles -FilesRoot $root
  foreach ($entry in $releaseFiles) {
    $destination = Join-Path $stage ($entry.relative.Replace('/',[IO.Path]::DirectorySeparatorChar))

    $parent = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $entry.fullPath -Destination $destination
  }
  Test-ReleaseSourceBytes -SourceRoot $root -Files $releaseFiles -FilesRoot $stage
  # A dirty checkout can reference untracked implementation files that the
  # tracked-only release enumeration intentionally excludes. Fail closed
  # instead of emitting an installer that cannot start or re-provision Pi.
  foreach ($required in @('payload/pi-dispatch/scripts/stdio-proxy.mjs','payload/pi-dispatch/scripts/lsp-approval-runner.mjs','payload/pi-dispatch/scripts/lsp-approval-state.mjs','payload/pi-dispatch/scripts/lsp-approval-worker.mjs','payload/pi-dispatch/scripts/lsp-change-detector.mjs','payload/pi-dispatch/scripts/sdk-tree-integrity.mjs','payload/pi-dispatch/scripts/check-pi-runtime-tree.mjs','payload/pi-dispatch/scripts/pi-151-home.mjs','payload/pi-dispatch/extensions/data-capacity.js','licenses/pi-1.5.1-MIT.txt','licenses/pi-lsp-extension-1.4.0-evidence.json','licenses/pi-lsp-extension-1.4.0.package.json','licenses/pi-lsp-extension-upstream-20260924-LICENSE.txt','install/patch-pi-lsp.mjs','install/Test-PiLspPatch.mjs','install/Test-PiLspPatch.ps1','install/Test-LspLicenseGate.mjs','install/check-pi-downgrade.py','install/Test-PiRuntimeDowngrade.ps1','install/HostRuntimeSecurity.ps1','install/HostPolicyPreservation.ps1','install/assert-existing-plugin.mjs','install/Test-HostRuntimeSecurity.ps1','install/Test-HostPolicyPreservation.ps1','install/Test-ExistingPluginSafety.mjs','install/Test-PublicReleaseGate.ps1','install/Release-Files.ps1','install/Resolve-PackagedSource.ps1','install/Test-ReleaseContents.ps1','install/Test-PackagedAdmission.ps1','install/Test-ReleaseContentScan.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $required) -PathType Leaf)) { throw "Required release file is not in the Git index: $required" }
  }
  & (Join-Path $root 'install\Stamp-PluginVersion.ps1') -SourceRepositoryRoot $root -StagingPackageRoot $stage | Out-Null
  $provenanceData = Get-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Raw | ConvertFrom-Json
  if ($provenanceData.dirty -or $provenanceData.sourceCommit -cne $admission.sourceCommit) { throw 'Source changed after release admission.' }
  & (Join-Path $root 'install/Test-ReleaseContents.ps1') -PackageRoot $stage
  # Admission is fresh, including remote main ancestry, after staging and before
  # any release archive is emitted. A changed checkout or remote fails closed.
  $finalAdmission = & (Join-Path $root 'install/Assert-DeploymentSource.ps1') -PackageRoot $root
  if ($finalAdmission.sourceCommit -cne $admission.sourceCommit -or $finalAdmission.dirty -or $finalAdmission.mainPolicy.relation -cne 'in-main') { throw 'Source changed before release creation.' }
  $zip = Join-Path $release "pi-kether-portable-$version.zip"
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
