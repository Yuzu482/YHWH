#requires -Version 5.1
<#
YHWH Windows x64 bootstrap. Source form works from an extracted repository.
Build-OneClick.ps1 embeds the portable ZIP into this same script.
No credentials are embedded. PlanOnly makes no changes or network requests.
#>
[CmdletBinding(DefaultParameterSetName='Install')]
param(
  [Parameter(ParameterSetName='Install')][string[]]$WorkspaceRoots,
  [Parameter(ParameterSetName='Install')][string]$Hosts = 'generic',
  [Parameter(ParameterSetName='Install')][string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'YHWH'),
  [Parameter(ParameterSetName='Install')][switch]$NonInteractive,
  [Parameter(ParameterSetName='Install')][switch]$UpgradeExisting,
  [Parameter(ParameterSetName='Install')][switch]$PlanOnly,
  [Parameter(Mandatory,ParameterSetName='Extract')][switch]$ExtractOnly,
  [Parameter(Mandatory,ParameterSetName='Extract')][string]$Destination
)
$ErrorActionPreference = 'Stop'
$script:PayloadSha256 = '__YHWH_PAYLOAD_SHA256__'
$script:PayloadBase64 = '__YHWH_PAYLOAD_BASE64__'

function Assert-YhwhHash([string]$Path, [string]$Expected) {
  if ($Expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) {
    throw "SHA256 verification failed: $Path"
  }
}

function Assert-YhwhDestination([string]$Path) {
  if ($Path -notmatch '^[a-zA-Z]:[\\/]') { throw 'An absolute local drive path is required.' }
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing a junction or symbolic link in destination: $cursor"
      }
    }
    $cursor = Split-Path -Parent $cursor
  }
  return $full
}

function Expand-YhwhArchive([string]$ZipPath, [string]$Target) {
  $full = Assert-YhwhDestination $Target
  if (Test-Path -LiteralPath $full) { throw "Extraction requires a new directory: $full" }
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$size = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      $segments = $name.TrimEnd('/') -split '/'
      if ($name -match '^/|:|[\x00-\x1f]' -or $segments -contains '..' -or $segments -contains '.' -or $segments -contains '' -or
          $name -match '(?i)(^|/)(con|prn|aux|nul|com[1-9]|lpt[1-9])([./]|$)' -or $name -match '[. ](/|$)' -or
          -not $names.Add($name.TrimEnd('/'))) { throw "Unsafe or duplicate ZIP entry: $name" }
      $resolved = [IO.Path]::GetFullPath((Join-Path $full $name))
      if (-not $resolved.StartsWith($full.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP entry escapes destination.' }
      $size += $entry.Length
      if ($size -gt 2GB -or $names.Count -gt 100000) { throw 'ZIP exceeds extraction limits.' }
    }
    # Validate every entry before creating any destination files.
    New-Item -ItemType Directory -Path $full | Out-Null
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      $out = Join-Path $full $name
      if ($name.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $out | Out-Null; continue }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $false)
    }
  } finally { $zip.Dispose() }
}

function Expand-YhwhPayload([string]$Target) {
  if ($script:PayloadBase64.StartsWith('__YHWH_')) { throw 'No embedded payload. Build the one-click artifact first.' }
  $bytes = [Convert]::FromBase64String($script:PayloadBase64)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($actual -ne $script:PayloadSha256) { throw 'Embedded payload checksum mismatch.' }
  $tempZip = Join-Path ([IO.Path]::GetTempPath()) ('yhwh-' + [guid]::NewGuid().ToString('N') + '.zip')
  try {
    [IO.File]::WriteAllBytes($tempZip, $bytes)
    Expand-YhwhArchive $tempZip $Target
  } finally { if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip -Force } }
  return (Join-Path $Target 'pi-kether-portable')
}

function Get-YhwhDownload($Dependency, [string]$Cache) {
  if ($Dependency.url -notmatch '^https://' -or $Dependency.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid dependency manifest.' }
  $file = Join-Path $Cache ([IO.Path]::GetFileName(([uri]$Dependency.url).AbsolutePath))
  if (Test-Path -LiteralPath $file) { Assert-YhwhHash $file $Dependency.sha256; return $file }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $partial = $file + '.' + [guid]::NewGuid().ToString('N') + '.partial'
  $client = New-Object Net.WebClient
  try {
    Write-Host "[YHWH] Downloading $($Dependency.url)"
    $client.DownloadFile($Dependency.url, $partial)
    Assert-YhwhHash $partial $Dependency.sha256
    Move-Item -LiteralPath $partial -Destination $file
  } finally {
    $client.Dispose()
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  }
  return $file
}

function Assert-YhwhInstallAllowed([string]$PluginPath, [switch]$Upgrade) {
  if ((Test-Path -LiteralPath $PluginPath) -and -not $Upgrade) {
    throw 'Pi is already installed. Stop its tasks and runtime, then explicitly use -UpgradeExisting to replace it with backups.'
  }
  $active = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object {
    $_.CommandLine -and $_.CommandLine.Replace('/','\').IndexOf($PluginPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($active.Count) { throw 'Pi runtime is active. Close its host connections and stop the runtime before installing; nothing was stopped automatically.' }
}

function Initialize-YhwhWsl([switch]$Unattended) {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (-not (Test-Path -LiteralPath $wsl)) { throw 'Windows 11 with wsl.exe is required. Enable WSL through Windows setup first.' }
  & $wsl --status *> $null
  if ($LASTEXITCODE -eq 0) { return $true }
  if ($Unattended) { throw 'WSL is not ready. Run wsl --install --no-distribution as administrator, restart Windows and rerun.' }
  Write-Host '[ACTION] Windows will request administrator approval to enable WSL. After restarting Windows, run this installer again.'
  $process = Start-Process -FilePath $wsl -ArgumentList '--install','--no-distribution' -Verb RunAs -WindowStyle Hidden -PassThru -Wait
  if ($process.ExitCode -notin @(0,3010)) { throw "WSL setup failed (exit $($process.ExitCode))." }
  return $false
}

function Initialize-YhwhDistro([string]$Root, $Dependency, [string]$Cache) {
  $ownerFile = Join-Path $Root 'distro-owner.json'
  $names = @((& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate WSL distributions.' }
  if ($names -contains 'YHWH') {
    if (-not (Test-Path -LiteralPath $ownerFile)) { throw 'An unmanaged YHWH distribution exists. It will not be modified.' }
    $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if ([string]$owner.id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid distribution ownership record.' }
    $inside = (& wsl.exe -d YHWH -u root -- cat /etc/yhwh-owner 2>$null) -join ''
    if ($LASTEXITCODE -ne 0 -or $inside.Trim() -ne $owner.id) { throw 'WSL ownership mismatch. Refusing to harden this distribution.' }
    return
  }
  $distroPath = Join-Path $Root 'wsl'
  if (Test-Path -LiteralPath $distroPath) { throw 'WSL import directory already exists without a registered distro; inspect it manually before retrying.' }
  $archive = Get-YhwhDownload $Dependency $Cache
  $id = [guid]::NewGuid().ToString('N')
  @{ id=$id; distro='YHWH' } | ConvertTo-Json | Set-Content -LiteralPath $ownerFile -Encoding UTF8
  & wsl.exe --import YHWH $distroPath $archive --version 2
  if ($LASTEXITCODE -ne 0) { throw 'WSL import failed; existing distributions were not removed.' }
  & wsl.exe -d YHWH -u root -- sh -c "printf %s $id > /etc/yhwh-owner && chmod 600 /etc/yhwh-owner"
  if ($LASTEXITCODE -ne 0) { throw 'Could not record ownership of the imported WSL distribution.' }
}

function Invoke-YhwhMain {
  if ($ExtractOnly) {
    $package = Expand-YhwhPayload $Destination
    Write-Host "[PASS] Verified package extracted: $package"
    return
  }
  $root = Assert-YhwhDestination $InstallRoot
  $selectedHosts=@($Hosts.Split(',')|ForEach-Object{$_.Trim()})
  foreach($hostId in $selectedHosts){if($hostId -notin @('generic','codex','cherry-studio','opencode','opencode-v2','claude-code','claude-desktop','deepseek-harness','cursor','vscode-copilot','windsurf','cline','roo-code','gemini-cli','kiro','zed','continue','lm-studio')){throw "Unknown host: $hostId"}}
  if(@($selectedHosts|Select-Object -Unique).Count -ne $selectedHosts.Count){throw 'Duplicate hosts are not allowed.'}
  if (-not $WorkspaceRoots) { $WorkspaceRoots = @(Join-Path $HOME 'YHWH-Workspace') }
  $roots = @($WorkspaceRoots | ForEach-Object { Assert-YhwhDestination $_ })
  Write-Host "[YHWH] Install directory: $root"
  Write-Host "[YHWH] Allowed workspace directories: $($roots -join ', ')"
  Write-Host "[YHWH] Pinned PowerShell + Node; dedicated YHWH WSL2; primary hosts: $($selectedHosts -join ', '); no Tunnel."
  if ($PlanOnly) {
    Write-Host '[PLAN] No changes or network requests. Full installation requires Windows 11 x64, network access, WSL2/virtualization and a stopped Pi runtime. Provider login remains manual.'
    return
  }
  if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or [Environment]::OSVersion.Version.Build -lt 22000) {
    throw 'This installer supports Windows 11 x64 only. Use 64-bit Windows PowerShell.'
  }
  Assert-YhwhInstallAllowed (Join-Path $HOME 'plugins\pi-dispatch') -Upgrade:$UpgradeExisting
  if (-not (Initialize-YhwhWsl -Unattended:$NonInteractive)) { exit 3010 }
  if (-not $NonInteractive -and -not $script:PSBoundParameters.ContainsKey('WorkspaceRoots')) {
    $answer = Read-Host "Workspace directory (Enter for $($roots[0]))"
    if ($answer) { $roots = @(Assert-YhwhDestination $answer) }
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $package = $PSScriptRoot
  if (-not $script:PayloadBase64.StartsWith('__YHWH_')) {
    $package = Expand-YhwhPayload (Join-Path $root ('packages\' + [guid]::NewGuid().ToString('N')))
  }
  if (-not (Test-Path -LiteralPath (Join-Path $package 'Workflow.ps1'))) { throw 'Run this source script from a complete checkout or use the generated self-contained installer.' }
  $deps = Get-Content -LiteralPath (Join-Path $package 'install\bootstrap-dependencies.json') -Raw | ConvertFrom-Json
  $cache = Join-Path $root 'downloads'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $psDir = Join-Path $root ('runtime\powershell-' + $deps.powershell.version)
  $nodeDir = Join-Path $root ('runtime\node-' + $deps.node.version)
  foreach ($entry in @(@{dependency=$deps.powershell;path=$psDir}, @{dependency=$deps.node;path=$nodeDir})) {
    $archive = Get-YhwhDownload $entry.dependency $cache
    if (-not (Test-Path -LiteralPath $entry.path)) {
      $stage = $entry.path + '.stage-' + [guid]::NewGuid().ToString('N')
      Expand-YhwhArchive $archive $stage
      Move-Item -LiteralPath $stage -Destination $entry.path
    }
  }
  $pwsh = Join-Path $psDir 'pwsh.exe'
  $nodeBin = Join-Path $nodeDir ('node-v' + $deps.node.version + '-win-x64')
  $node = Join-Path $nodeBin 'node.exe'
  if ((& $node --version) -ne ('v' + $deps.node.version)) { throw 'Private Node runtime version mismatch.' }
  if ((& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()') -ne $deps.powershell.version) { throw 'Private PowerShell runtime version mismatch.' }
  Initialize-YhwhDistro $root $deps.ubuntu $cache
  foreach ($workspace in $roots) { New-Item -ItemType Directory -Force -Path $workspace | Out-Null }
  $configPath = Join-Path $root 'install.config.json'
  $config = [ordered]@{schemaVersion=1;hosts=$selectedHosts;workspaceRoots=$roots;wslDistro='YHWH';installWsl=$true;allowDistroHardening=$true;installTunnel=$false}
  $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8
  $oldPath = $env:PATH
  try {
    $env:PATH = $nodeBin + ';' + $psDir + ';' + $oldPath
    & $pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Workflow.ps1') -Action Install -ConfigFile $configPath
    if ($LASTEXITCODE -ne 0) { throw "Workflow installation failed (exit $LASTEXITCODE). Inspect the error and backups, then retry with -UpgradeExisting." }
  } finally { $env:PATH = $oldPath }
  # Store paths as JSON data; never interpolate user paths into executable command text.
  @{node=$node;pwsh=$pwsh;package=$package;config=$configPath;home=$HOME} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'installation.json') -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $package 'install\Open-YhwhPi.ps1') -Destination (Join-Path $root 'Open-Pi.ps1') -Force
  foreach ($provider in @('OpenAI','Claude')) {
    $name = if ($provider -eq 'OpenAI') { 'Open-Pi.cmd' } else { 'Login-Claude.cmd' }
    $loginCmd = '@echo off' + "`r`n" + ('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Open-Pi.ps1" -Provider ' + $provider) + "`r`n" + 'pause' + "`r`n"
    [IO.File]::WriteAllText((Join-Path $root $name), $loginCmd, [Text.Encoding]::ASCII)
  }
  Write-Host '[PASS] Files, dependencies and sandbox checks completed.'
  Write-Host "[ACTION] Open $root\Open-Pi.cmd and use /login for OpenAI. Use Login-Claude.cmd for the reviewer account. Import the selected host profile and primary-agent instructions; keep the host's approval gates."
  Write-Host '[UNVERIFIED] Provider authentication/model heartbeat and ChatGPT Tunnel connectivity are not established by installation.'
}

$installMutex = $null
$ownsMutex = $false
try {
  if (-not $PlanOnly -and -not $ExtractOnly) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $installMutex = [Threading.Mutex]::new($false, ('Local\YHWH-Install-' + $sid))
    try { $ownsMutex = $installMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) { throw 'Another YHWH installer is already running for this account.' }
  }
  Invoke-YhwhMain
} catch { Write-Error $_; exit 1 } finally {
  if ($ownsMutex) { $installMutex.ReleaseMutex() }
  if ($installMutex) { $installMutex.Dispose() }
}
