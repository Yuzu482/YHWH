#Requires -Version 7.0
# Shared, read-only installation ancestry and bounded evidence collection.
function Invoke-DeploymentProcess {
  param([Parameter(Mandatory)][string]$FilePath,[string[]]$Arguments=@(),[Parameter(Mandatory)][string]$WorkingDirectory,[ValidateRange(1,300000)][int]$TimeoutMs=15000,[ValidateRange(1,524288)][int]$MaxOutputBytes=524288)
  $process=$null;$status=$null;$signal='';$errorText='';$timedOut=$false;$outputLimit=$false
  $stdout=[Text.StringBuilder]::new();$stderr=[Text.StringBuilder]::new();$bytes=0
  $timer=[Diagnostics.Stopwatch]::StartNew()
  try {
    $info=[Diagnostics.ProcessStartInfo]::new($FilePath)
    $info.WorkingDirectory=$WorkingDirectory;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.StandardOutputEncoding=[Text.Encoding]::UTF8;$info.StandardErrorEncoding=[Text.Encoding]::UTF8
    foreach($key in @($info.Environment.Keys)){if($key -match '^GIT_' -or $key -in @('GH_HOST','GH_REPO','GH_PAGER','PAGER')){[void]$info.Environment.Remove($key)}}
    $info.Environment['GIT_TERMINAL_PROMPT']='0';$info.Environment['GH_PROMPT_DISABLED']='1'
    foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::Start($info);$process.StandardInput.Close()
    $buffers=@([char[]]::new(4096),[char[]]::new(4096))
    $readers=@($process.StandardOutput,$process.StandardError);$builders=@($stdout,$stderr)
    $tasks=@($readers[0].ReadAsync($buffers[0],0,4096),$readers[1].ReadAsync($buffers[1],0,4096))
    $closed=@($false,$false)
    while($true){
      for($i=0;$i -lt 2;$i++){
        if(-not $closed[$i] -and $tasks[$i].IsCompleted){
          $count=$tasks[$i].GetAwaiter().GetResult()
          if($count -eq 0){$closed[$i]=$true;continue}
          $chunk=[string]::new($buffers[$i],0,$count);$bytes+=[Text.Encoding]::UTF8.GetByteCount($chunk)
          if($bytes -gt $MaxOutputBytes){$outputLimit=$true;break}
          [void]$builders[$i].Append($chunk);$tasks[$i]=$readers[$i].ReadAsync($buffers[$i],0,4096)
        }
      }
      if($outputLimit){break}
      if($process.HasExited -and $closed[0] -and $closed[1]){$status=$process.ExitCode;break}
      if($timer.ElapsedMilliseconds -ge $TimeoutMs){$timedOut=$true;break}
      [Threading.Thread]::Sleep(10)
    }
  } catch {$errorText=$_.Exception.Message}
  finally {
    if($process){
      try{if(-not $process.HasExited){$process.Kill($true);if(-not $process.WaitForExit(2000)){$signal='process-tree-reap-incomplete'}};if($process.HasExited){$status=$process.ExitCode}}catch{$signal='process-tree-reap-failed'}
      $process.Dispose()
    }
  }
  return [pscustomobject]@{status=$status;signal=$signal;stdout=$stdout.ToString();stderr=$stderr.ToString();error=$errorText;timedOut=$timedOut;outputLimit=$outputLimit;elapsedMs=$timer.ElapsedMilliseconds}
}
function Test-DeploymentProcessSuccess($Result){
  return ($null -ne $Result -and $Result.status -eq 0 -and -not $Result.signal -and -not $Result.error -and -not $Result.timedOut -and -not $Result.outputLimit)
}
function Invoke-DeploymentGit {
  param([Parameter(Mandatory)][string]$Repository,[Parameter(Mandatory)][string[]]$GitArguments)
  $executable=(Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $arguments=@('-c',"safe.directory=$Repository",'-c','credential.interactive=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.ssh.allow=always','-c','protocol.file.allow=always','-c','protocol.ext.allow=never')+$GitArguments
  return Invoke-DeploymentProcess -FilePath $executable -Arguments $arguments -WorkingDirectory $Repository
}
function Get-DeploymentMainState {
  param([Parameter(Mandatory)][string]$Repository,[Parameter(Mandatory)][string]$Commit,[string[]]$AdvertisedHeads)
  $result=[ordered]@{relation='unknown';sourceCommit=$Commit;mainCommit=$null;verifiedAt=[DateTime]::UtcNow.ToString('o');reason=$null}
  try {
    if($Commit -cnotmatch '^[a-f0-9]{40,64}$' -or -not (Test-Path -LiteralPath (Join-Path $Repository '.git'))){throw 'source-repository-or-commit-unavailable'}
    if(-not $PSBoundParameters.ContainsKey('AdvertisedHeads')){
      $remote=Invoke-DeploymentGit -Repository $Repository -GitArguments @('ls-remote','--heads','origin')
      if(-not (Test-DeploymentProcessSuccess $remote)){throw 'remote-main-query-failed'}
      $AdvertisedHeads=@($remote.stdout -split '\r?\n')
    }
    $main=@($AdvertisedHeads | Where-Object {$_ -cmatch '^[a-f0-9]{40,64}\s+refs/heads/main$'})
    if($main.Count -ne 1){throw 'remote-main-missing-or-ambiguous'}
    $result.mainCommit=($main[0] -split '\s+',2)[0]
    $object=Invoke-DeploymentGit -Repository $Repository -GitArguments @('cat-file','-e',($result.mainCommit+'^{commit}'))
    if(-not (Test-DeploymentProcessSuccess $object)){throw 'remote-main-object-unavailable-fetch-required'}
    $ancestry=Invoke-DeploymentGit -Repository $Repository -GitArguments @('merge-base','--is-ancestor',$Commit,$result.mainCommit)
    if(Test-DeploymentProcessSuccess $ancestry){$result.relation='in-main'}
    elseif($ancestry.status -eq 1 -and -not $ancestry.error -and -not $ancestry.signal -and -not $ancestry.timedOut -and -not $ancestry.outputLimit){$result.relation='not-in-main'}
    else{throw 'main-ancestry-query-failed'}
  } catch {$result.reason=$_.Exception.Message}
  return [pscustomobject]$result
}
function Write-DeploymentMainWarning {
  [CmdletBinding()]
  param($State)
  if($State.relation -eq 'not-in-main'){Write-Warning ("[DEPLOYMENT_NOT_IN_MAIN] Installed commit {0} has not been merged into origin/main ({1})." -f $State.sourceCommit,$State.mainCommit)}
  elseif($State.relation -ne 'in-main'){Write-Warning ("[DEPLOYMENT_MAIN_UNKNOWN] Installed ancestry coverage unavailable: {0}" -f $State.reason)}
}
function New-DeploymentCiUnavailable([string]$Reason,[string]$Commit){
  return [pscustomobject]@{status='unavailable';reason=$Reason;sourceCommit=$Commit;verifiedAt=[DateTime]::UtcNow.ToString('o');pullRequests=@();checks=@();statuses=@();conclusion='unknown'}
}
function Convert-DeploymentCiEvidence {
  param([string]$RepositoryName,[string]$Commit,[object[]]$PullRequests,[object]$CheckRuns,[object]$CombinedStatus)
  try {
    if($RepositoryName -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $Commit -cnotmatch '^[a-f0-9]{40,64}$'){throw 'invalid-ci-identity'}
    if($CheckRuns.check_runs -isnot [array] -or $CombinedStatus.statuses -isnot [array]){throw 'invalid-ci-response'}
    if(($CheckRuns.total_count -isnot [long] -and $CheckRuns.total_count -isnot [int]) -or ($CombinedStatus.total_count -isnot [long] -and $CombinedStatus.total_count -isnot [int])){throw 'invalid-ci-response'}
    if($PullRequests.Count -ge 100 -or @($CheckRuns.check_runs).Count -ge 100 -or @($CombinedStatus.statuses).Count -ge 100 -or $CheckRuns.total_count -ne @($CheckRuns.check_runs).Count -or $CombinedStatus.total_count -ne @($CombinedStatus.statuses).Count){throw 'ci-pagination-incomplete'}
    foreach($pr in $PullRequests){if($pr.head.sha -cnotmatch '^[a-f0-9]{40,64}$' -or $pr.base.repo.full_name -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or ($pr.number -isnot [long] -and $pr.number -isnot [int]) -or $pr.number -le 0 -or $pr.state -notin @('open','closed')){throw 'invalid-pr-response'}}
    $prs=@($PullRequests | Where-Object {$_.head.sha -ceq $Commit -and $_.base.repo.full_name -ieq $RepositoryName} | ForEach-Object {
      [pscustomobject]@{number=$_.number;url="https://github.com/$RepositoryName/pull/$($_.number)";state=$_.state;head=$Commit}
    })
    $checks=@($CheckRuns.check_runs | ForEach-Object {
      if($_.head_sha -cne $Commit -or $_.status -notin @('queued','in_progress','completed','waiting','requested','pending')){throw 'invalid-check-identity'}
      [pscustomobject]@{name=([string]$_.name).Substring(0,[Math]::Min(256,([string]$_.name).Length));status=$_.status;conclusion=$_.conclusion}
    })
    $statuses=@($CombinedStatus.statuses | ForEach-Object {
      if($_.state -notin @('error','failure','pending','success')){throw 'invalid-status-response'}
      [pscustomobject]@{context=([string]$_.context).Substring(0,[Math]::Min(256,([string]$_.context).Length));state=$_.state}
    })
    if($CombinedStatus.sha -cne $Commit){throw 'invalid-status-identity'}
    $outcome=if(-not $checks.Count -and -not $statuses.Count){'none'}elseif(@($checks | Where-Object {$_.conclusion -in @('failure','cancelled','timed_out','action_required','startup_failure')}).Count -or @($statuses | Where-Object {$_.state -in @('error','failure')}).Count){'failure'}elseif(@($checks | Where-Object {$_.status -ne 'completed'}).Count -or @($statuses | Where-Object state -eq 'pending').Count){'pending'}elseif(@($checks | Where-Object {$_.conclusion -notin @('success','neutral','skipped')}).Count){'unknown'}else{'success'}
    return [pscustomobject]@{status=$(if(-not $prs.Count -and -not $checks.Count -and -not $statuses.Count){'none'}else{'observed'});reason=$null;sourceCommit=$Commit;verifiedAt=[DateTime]::UtcNow.ToString('o');pullRequests=$prs;checks=$checks;statuses=$statuses;conclusion=$outcome}
  } catch {return New-DeploymentCiUnavailable $_.Exception.Message $Commit}
}
function Get-DeploymentCiEvidence {
  param([Parameter(Mandatory)][string]$Repository,[Parameter(Mandatory)][string]$Commit)
  try {
    $origin=Invoke-DeploymentGit -Repository $Repository -GitArguments @('remote','get-url','origin')
    if(-not (Test-DeploymentProcessSuccess $origin)){throw 'origin-query-failed'}
    $url=$origin.stdout.Trim()
    if($url -cmatch '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$'){$name=$Matches[1]+'/'+$Matches[2]}else{throw 'unsupported-origin'}
    if($Commit -cnotmatch '^[a-f0-9]{40,64}$'){throw 'invalid-ci-identity'}
    $gh=(Get-Command gh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $responses=@()
    foreach($endpoint in @("repos/$name/commits/$Commit/pulls?per_page=100","repos/$name/commits/$Commit/check-runs?per_page=100","repos/$name/commits/$Commit/status?per_page=100")){
      $response=Invoke-DeploymentProcess -FilePath $gh -Arguments @('api','--hostname','github.com',$endpoint) -WorkingDirectory $Repository
      if(-not (Test-DeploymentProcessSuccess $response)){throw 'ci-query-unavailable'}
      $responses+=,($response.stdout | ConvertFrom-Json -NoEnumerate -ErrorAction Stop)
    }
    if($responses[0] -isnot [array]){throw 'invalid-pr-response'}
    return Convert-DeploymentCiEvidence -RepositoryName $name -Commit $Commit -PullRequests $responses[0] -CheckRuns $responses[1] -CombinedStatus $responses[2]
  } catch {return New-DeploymentCiUnavailable 'ci-collection-unavailable' $Commit}
}

