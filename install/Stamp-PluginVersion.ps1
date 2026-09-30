#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceRepositoryRoot,
  [Parameter(Mandatory)][string]$StagingPackageRoot
)
$ErrorActionPreference = 'Stop'
# Source installs intentionally retain the committed manifest; only staged package upgrades are stamped.
$source = [IO.Path]::GetFullPath($SourceRepositoryRoot)
$stage = [IO.Path]::GetFullPath($StagingPackageRoot)
$sourcePrefix = $source.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($stage.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -eq $source.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -or $stage.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Staging root must not equal or be inside the source repository.'
}
function Invoke-GitCommand([string[]]$GitArguments) {
  $gitExecutable = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $gitExecutable
  $info.WorkingDirectory = $source
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  $info.ArgumentList.Add('-c'); $info.ArgumentList.Add("safe.directory=$source")
  foreach ($argument in $GitArguments) { $info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($info)
  $output = $process.StandardOutput.ReadToEnd().Trim()
  $errorText = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw "Git command failed: $errorText" }
  return $output
}
$commit = Invoke-GitCommand -GitArguments @('rev-parse','--verify','HEAD^{commit}')
if ($commit -notmatch '^[0-9a-fA-F]{40,64}$') { throw 'Git did not return a valid full commit hash.' }
$commit = $commit.ToLowerInvariant()
$short = $commit.Substring(0, [Math]::Min(12, $commit.Length))
$status = Invoke-GitCommand -GitArguments @('status','--porcelain','--untracked-files=no')
$dirty = -not [string]::IsNullOrWhiteSpace($status)
$pluginPath = Join-Path $stage 'payload/pi-dispatch/.codex-plugin/plugin.json'
$portablePath = Join-Path $stage 'portable.manifest.json'
if (!(Test-Path -LiteralPath $pluginPath -PathType Leaf) -or !(Test-Path -LiteralPath $portablePath -PathType Leaf)) { throw 'Staging manifests are missing.' }
$plugin = Get-Content -LiteralPath $pluginPath -Raw | ConvertFrom-Json
$portable = Get-Content -LiteralPath $portablePath -Raw | ConvertFrom-Json
if ([string]$plugin.version -notmatch '^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+.*)?$') { throw 'Invalid base plugin version.' }
$pluginVersion = $Matches[1] + '+' + $short + $(if ($dirty) { '.dirty' } else { '' })
$plugin.version = $pluginVersion
$portable.components.piDispatch = $pluginVersion
$plugin | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $pluginPath -Encoding utf8NoBOM
$portable | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $portablePath -Encoding utf8NoBOM
[ordered]@{ schemaVersion = 1; sourceCommit = $commit; shortHash = $short; dirty = $dirty; pluginVersion = $pluginVersion } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'build-provenance.json') -Encoding utf8NoBOM
Write-Output $pluginVersion
