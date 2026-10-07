#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($PackageRoot)
$plugin = Get-Content -LiteralPath (Join-Path $source 'payload/pi-dispatch/.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
if ([string]$plugin.version -notmatch '^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\+.*)?$') { throw 'Invalid base plugin version.' }
$baseVersion = $Matches[1]
if (Test-Path -LiteralPath (Join-Path $source '.git')) {
  function Invoke-IdentityGit([string[]]$GitArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source)
    $info.WorkingDirectory = $source; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.ArgumentList.Add('-c'); $info.ArgumentList.Add("safe.directory=$source")
    foreach ($argument in $GitArguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    try {
      $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(15000)) { $process.Kill($true); $process.WaitForExit(); throw 'Git identity command timed out.' }
      $output = $out.GetAwaiter().GetResult().Trim(); $errorText = $err.GetAwaiter().GetResult()
      if ($process.ExitCode -ne 0) { throw "Git command failed: $errorText" }
      return $output
    } finally { $process.Dispose() }
  }
  $commit = Invoke-IdentityGit @('rev-parse','--verify','HEAD^{commit}')
  if ($commit -notmatch '^[0-9a-fA-F]{40,64}$') { throw 'Git did not return a valid full commit hash.' }
  $commit = $commit.ToLowerInvariant(); $short = $commit.Substring(0,12)
  # Untracked, non-ignored implementation also makes a worktree dirty.
  $dirty = -not [string]::IsNullOrWhiteSpace((Invoke-IdentityGit @('status','--porcelain','--untracked-files=all')))
  return [pscustomobject][ordered]@{schemaVersion=1;sourceCommit=$commit;shortHash=$short;dirty=$dirty;pluginVersion=$baseVersion+'+'+$short+$(if($dirty){'.dirty'}else{''})}
}
$proof = Get-Content -LiteralPath (Join-Path $source 'build-provenance.json') -Raw | ConvertFrom-Json
$portable = Get-Content -LiteralPath (Join-Path $source 'portable.manifest.json') -Raw | ConvertFrom-Json
if ($proof.schemaVersion -ne 1 -or [string]$proof.sourceCommit -cnotmatch '^[0-9a-f]{40,64}$' -or $proof.dirty -isnot [bool] -or
    $proof.shortHash -cne $proof.sourceCommit.Substring(0,12) -or
    $proof.pluginVersion -cne ($baseVersion+'+'+$proof.shortHash+$(if($proof.dirty){'.dirty'}else{''})) -or
    $plugin.version -cne $proof.pluginVersion -or $portable.components.piDispatch -cne $proof.pluginVersion) { throw 'Packaged plugin provenance is missing or inconsistent.' }
return $proof
