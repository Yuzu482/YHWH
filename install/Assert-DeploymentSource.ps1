#Requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageRoot,[switch]$AllowDirty,[string]$DirtyReason)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PackageRoot)
if(-not (Test-Path -LiteralPath (Join-Path $root '.git'))){throw 'Workflow Install requires a Git checkout to verify its pushed HEAD.'}
$identity=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $root
if($identity.dirty -and -not $AllowDirty){throw 'Dirty worktree: commit changes before Install, or explicitly use -AllowDirty -DirtyReason.'}
if($AllowDirty -and ([string]::IsNullOrWhiteSpace($DirtyReason) -or $DirtyReason.Length -gt 512 -or $DirtyReason -match '[\x00-\x1f\x7f]')){throw 'AllowDirty requires a nonempty single-line DirtyReason of at most 512 characters.'}
$info=[Diagnostics.ProcessStartInfo]::new((Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source)
$info.WorkingDirectory=$root;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$info.Environment['GIT_TERMINAL_PROMPT']='0'
function Invoke-DeploymentGit([string[]]$Arguments) {
$info.ArgumentList.Clear()
foreach($argument in @('-c',"safe.directory=$root",'-c','credential.interactive=false')+$Arguments){$info.ArgumentList.Add($argument)}
$process=[Diagnostics.Process]::Start($info)
try {
  $process.StandardInput.Close()
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  if(-not $process.WaitForExit(15000)){$process.Kill($true);$process.WaitForExit();throw 'Remote HEAD verification timed out.'}
  $output=$stdout.GetAwaiter().GetResult();$errorText=$stderr.GetAwaiter().GetResult()
  if([Text.Encoding]::UTF8.GetByteCount($output)+[Text.Encoding]::UTF8.GetByteCount($errorText) -gt 524288){throw 'Remote HEAD verification exceeded output limit.'}
  return [pscustomobject]@{exitCode=$process.ExitCode;stdout=$output}
} finally {$process.Dispose()}
}
$remote=Invoke-DeploymentGit @('ls-remote','--heads','origin')
if($remote.exitCode -ne 0){throw "Remote HEAD verification failed (exit $($remote.exitCode))."}
$advertised=@($remote.stdout -split '\r?\n' | Where-Object {$_ -match '^[a-f0-9]{40,64}\s+refs/heads/[^\s]+$'})
$matching=@($advertised | Where-Object {($_ -split '\s+',2)[0] -ceq $identity.sourceCommit})
if($matching.Count -eq 0) {
  # Locally provable ancestry is valid only when the exact tip is freshly advertised by origin.
  # Missing local objects fail closed; no fetch, push or tracking-ref mutation is performed here.
  $tracked=Invoke-DeploymentGit @('for-each-ref',('--contains='+$identity.sourceCommit),'--format=%(objectname) %(refname)','refs/remotes/origin/')
  if($tracked.exitCode -ne 0){throw 'Remote ancestry verification failed.'}
  $known=@($tracked.stdout -split '\r?\n' | ForEach-Object {if($_ -match '^([a-f0-9]{40,64}) refs/remotes/origin/(.+)$'){$Matches[1]+"`trefs/heads/"+$Matches[2]}})
  $matching=@($advertised | Where-Object {($_ -replace '\s+',"`t") -cin $known})
}
if($matching.Count -eq 0){throw 'HEAD is not proven pushed to an advertised origin branch; push or refresh remote history before Install.'}
# Check again after network verification; no target-home mutation has occurred.
$current=& (Join-Path $PSScriptRoot 'Get-PluginBuildIdentity.ps1') -PackageRoot $root
if($current.sourceCommit -cne $identity.sourceCommit -or $current.dirty -ne $identity.dirty){throw 'Source changed during deployment admission.'}
return [pscustomobject][ordered]@{sourceCommit=$identity.sourceCommit;pluginVersion=$identity.pluginVersion;dirty=$identity.dirty;allowDirty=[bool]$AllowDirty;dirtyReason=$(if($AllowDirty){$DirtyReason.Trim()}else{$null});remote='origin';remoteRefs=@($matching | ForEach-Object {($_ -split '\s+',2)[1]});remoteVerifiedAt=[DateTime]::UtcNow.ToString('o')}
