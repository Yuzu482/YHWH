#Requires -Version 7.0
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path $repo ('.test/deployment source '+[guid]::NewGuid().ToString('N'))
$allowed=[IO.Path]::GetFullPath((Join-Path $repo '.test'))+[IO.Path]::DirectorySeparatorChar
if(-not [IO.Path]::GetFullPath($fixture).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture escaped .test.'}
$checks=0
function Check([bool]$ok,[string]$label){if(-not $ok){throw "FAIL: $label"};$script:checks++;Write-Output "PASS: $label"}
function Git([string]$cwd,[string[]]$arguments){& git.exe -c "safe.directory=$cwd" -C $cwd @arguments 2>&1 | Out-Null;if($LASTEXITCODE -ne 0){throw 'Fixture Git failed.'}}
function Reject([scriptblock]$action,[string]$fragment){$failed=$false;try{& $action | Out-Null}catch{$failed=$_.Exception.Message.Contains($fragment);if(-not $failed){throw}};Check $failed "reject $fragment"}
try {
  $source=Join-Path $fixture 'source';$remote=Join-Path $fixture 'remote.git';$target=Join-Path $fixture 'target'
  New-Item -ItemType Directory -Force -Path (Join-Path $source 'install'),(Join-Path $source 'payload/pi-dispatch/.codex-plugin') | Out-Null
  foreach($p in @('Workflow.ps1','install/Assert-DeploymentSource.ps1','install/Get-PluginBuildIdentity.ps1','install/DeploymentMainPolicy.ps1')){Copy-Item -LiteralPath (Join-Path $repo $p) -Destination (Join-Path $source $p)}
  [IO.File]::WriteAllText((Join-Path $source 'payload/pi-dispatch/.codex-plugin/plugin.json'),'{"version":"1.0.0"}')
  # Inert installer fixture: verifies front-end admission and records without touching services, policies or WSL.
  [IO.File]::WriteAllText((Join-Path $source 'install/Install-PiKether.ps1'),'param($ConfigFile,$TargetHome,[switch]$PlanOnly,[switch]$SkipWsl,[switch]$SkipTunnel,[switch]$SkipCodexRegistration) if(-not $PlanOnly){[IO.File]::WriteAllText((Join-Path $TargetHome "installed-fixture"),"installed") }')
  Git $source @('init','-q','-b','main');Git $source @('config','user.name','Deployment Fixture');Git $source @('config','user.email','fixture@example.invalid');Git $source @('config','commit.gpgsign','false')
  New-Item -ItemType Directory -Path (Join-Path $fixture 'empty-hooks') | Out-Null
  Git $source @('config','core.hooksPath',(Join-Path $fixture 'empty-hooks'))
  Git $source @('add','.');Git $source @('commit','-qm','fixture')
  Git $fixture @('init','--bare','-q',$remote);Git $source @('remote','add','origin',$remote)
  $workflow=Join-Path $source 'Workflow.ps1';$guard=Join-Path $source 'install/Assert-DeploymentSource.ps1'
  Reject {& $workflow -Action Install -TargetHome $target -SkipWsl -SkipTunnel -SkipCodexRegistration} 'HEAD is not'
  Check (-not (Test-Path -LiteralPath $target)) 'unpublished HEAD does not mutate target'
  Git $source @('push','-q','origin','HEAD:refs/heads/main')
  Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  $admission=& $guard -PackageRoot $source
  Check (-not $admission.dirty -and $admission.remoteRefs -contains 'refs/heads/fixture') 'clean pushed source admitted'
  [IO.File]::WriteAllText((Join-Path $source 'untracked'), 'dirty')
  Reject {& $workflow -Action Install -TargetHome $target} 'Dirty worktree'
  Reject {& $guard -PackageRoot $source -AllowDirty} 'DirtyReason'
  Reject {& $guard -PackageRoot $source -AllowDirty -DirtyReason "bad`nreason"} 'DirtyReason'
  Check (-not (Test-Path -LiteralPath $target)) 'dirty rejections do not mutate target'
  & $workflow -Action Install -TargetHome $target -AllowDirty -DirtyReason 'explicit synthetic acceptance fixture' -SkipWsl -SkipTunnel -SkipCodexRegistration
  $records=@(Get-ChildItem -LiteralPath (Join-Path $target '.local/state/pi-kether/installation-records') -Filter '*.json')
  $record=Get-Content -LiteralPath $records[0].FullName -Raw | ConvertFrom-Json
  Check ($records.Count -eq 1 -and $record.status -eq 'completed' -and $record.admission.dirty -and $record.admission.allowDirty -and $record.admission.dirtyReason -eq 'explicit synthetic acceptance fixture') 'explicit dirty allowance and reason persisted'
  Remove-Item -LiteralPath (Join-Path $source 'untracked')
  [IO.File]::AppendAllText((Join-Path $source 'Workflow.ps1'),"`n# tracked fixture change`n")
  Reject {& $guard -PackageRoot $source} 'Dirty worktree'
  Git $source @('add','Workflow.ps1');Git $source @('commit','-qm','unpublished change')
  Reject {& $guard -PackageRoot $source -AllowDirty -DirtyReason 'must not bypass unpublished HEAD'} 'HEAD is not'
  Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  Reject {& $guard -PackageRoot $source} 'HEAD is not in origin/main'
  Git $source @('push','-q','origin','HEAD:refs/heads/main')
  Check (-not (& $guard -PackageRoot $source).dirty) 'newly pushed clean HEAD admitted'
  $cleanTarget=Join-Path $fixture 'clean-target'
  & $workflow -Action Install -TargetHome $cleanTarget -SkipWsl -SkipTunnel -SkipCodexRegistration
  $cleanFile=Get-ChildItem -LiteralPath (Join-Path $cleanTarget '.local/state/pi-kether/installation-records') -Filter '*.json'
  $cleanRecord=Get-Content -LiteralPath $cleanFile.FullName -Raw | ConvertFrom-Json
  Check ($cleanRecord.status -eq 'completed' -and -not $cleanRecord.admission.dirty -and -not $cleanRecord.admission.allowDirty -and $null -eq $cleanRecord.admission.dirtyReason) 'clean Workflow Install records pushed source without dirty exemption'
  [IO.File]::AppendAllText((Join-Path $source 'install/Install-PiKether.ps1'),"`nthrow 'fixture installer failure'`n")
  $failedTarget=Join-Path $fixture 'failed-target'
  Reject {& $workflow -Action Install -TargetHome $failedTarget -AllowDirty -DirtyReason 'synthetic failure record' -SkipWsl -SkipTunnel -SkipCodexRegistration} 'fixture installer failure'
  $failedFile=Get-ChildItem -LiteralPath (Join-Path $failedTarget '.local/state/pi-kether/installation-records') -Filter '*.json'
  $failedRecord=Get-Content -LiteralPath $failedFile.FullName -Raw | ConvertFrom-Json
  Check ($failedRecord.status -eq 'failed' -and $failedRecord.admission.dirtyReason -eq 'synthetic failure record') 'installer failure preserved without false completion'
  Git $source @('restore','install/Install-PiKether.ps1')
  $older=& git.exe -C $source rev-parse HEAD
  [IO.File]::WriteAllText((Join-Path $source 'later'), 'later commit')
  Git $source @('add','later');Git $source @('commit','-qm','later remote tip');Git $source @('push','-q','origin','HEAD:refs/heads/fixture')
  Git $source @('push','-q','origin','HEAD:refs/heads/main')
  Git $source @('checkout','--detach','-q',$older)
  Check (-not (& $guard -PackageRoot $source).dirty) 'pushed ancestor accepted against freshly advertised descendant'
  # Real non-main branch: default refusal and explicit exception are separate from dirty allowance.
  . (Join-Path $source 'install/DeploymentMainPolicy.ps1')
  Git $source @('checkout','-q','-b','premerge-fixture')
  [IO.File]::WriteAllText((Join-Path $source 'side-change'),'side branch')
  Git $source @('add','side-change');Git $source @('commit','-qm','side branch');Git $source @('push','-q','origin','HEAD:refs/heads/premerge-fixture')
  $side=(& git.exe -C $source rev-parse HEAD).Trim()
  $refusedTarget=Join-Path $fixture 'refused-target'
  Reject {& $workflow -Action Install -TargetHome $refusedTarget -SkipWsl -SkipTunnel -SkipCodexRegistration} 'HEAD is not in origin/main'
  Check (-not (Test-Path -LiteralPath $refusedTarget)) 'non-main default refuses before target writes'
  Reject {& $guard -PackageRoot $source -PreMergeDeploy} 'requires a nonempty single-line Reason'
  Reject {& $guard -PackageRoot $source -Reason 'orphan reason'} 'Reason requires'
  foreach($badReason in @('   ',('x'*513),('bad'+[char]10+'reason'),('bad'+[char]0x85+'reason'),('bad'+[char]0x2028+'reason'),('bad'+[char]0x2029+'reason'))){Reject {& $guard -PackageRoot $source -PreMergeDeploy -Reason $badReason} 'requires a nonempty single-line Reason'}
  [IO.File]::WriteAllText((Join-Path $source 'dirty-side'),'dirty')
  Reject {& $guard -PackageRoot $source -PreMergeDeploy -Reason 'cannot bypass dirty'} 'Dirty worktree'
  Reject {& $guard -PackageRoot $source -AllowDirty -DirtyReason 'cannot bypass main'} 'HEAD is not in origin/main'
  Remove-Item -LiteralPath (Join-Path $source 'dirty-side')
  $exceptionTarget=Join-Path $fixture 'premerge-target'
  & $workflow -Action Install -TargetHome $exceptionTarget -PreMergeDeploy -Reason 'explicit synthetic premerge acceptance fixture' -SkipWsl -SkipTunnel -SkipCodexRegistration
  $exceptionFile=Get-ChildItem -LiteralPath (Join-Path $exceptionTarget '.local/state/pi-kether/installation-records') -Filter '*.json'
  $exceptionRecord=Get-Content -Raw -LiteralPath $exceptionFile.FullName | ConvertFrom-Json
  Check ($exceptionRecord.status -eq 'completed' -and $exceptionRecord.admission.sourceCommit -ceq $side -and $exceptionRecord.admission.mainPolicy.relation -eq 'not-in-main' -and $exceptionRecord.admission.mainPolicy.preMergeDeploy -and $exceptionRecord.admission.mainPolicy.reason -eq 'explicit synthetic premerge acceptance fixture' -and $exceptionRecord.admission.mainPolicy.branch -eq 'premerge-fixture' -and -not $exceptionRecord.admission.mainPolicy.detached -and $exceptionRecord.admission.mainPolicy.ci.status -eq 'unavailable') 'explicit premerge reason branch HEAD and unavailable local-origin CI persisted'
  Check ($cleanRecord.admission.mainPolicy.relation -eq 'in-main' -and -not $cleanRecord.admission.mainPolicy.preMergeDeploy -and $null -eq $cleanRecord.admission.mainPolicy.reason) 'default main admission recorded without exception'
  $state=Get-DeploymentMainState -Repository $source -Commit $side
  $warnings=@();Write-DeploymentMainWarning $state -WarningVariable warnings -WarningAction SilentlyContinue
  Check ($state.relation -eq 'not-in-main' -and $warnings.Count -eq 1 -and [string]$warnings[0] -match 'DEPLOYMENT_NOT_IN_MAIN') 'installed non-main commit produces only a warning'
  $mainProof=Get-DeploymentMainState -Repository $source -Commit $older
  Check ($mainProof.relation -eq 'in-main') 'installed SHA checked independently of current side-branch HEAD'
  $unknown=Get-DeploymentMainState -Repository $fixture -Commit $side
  $warnings=@();Write-DeploymentMainWarning $unknown -WarningVariable warnings -WarningAction SilentlyContinue
  Check ($unknown.relation -eq 'unknown' -and $warnings.Count -eq 1 -and [string]$warnings[0] -match 'DEPLOYMENT_MAIN_UNKNOWN') 'missing source repository warns unknown without claiming main'

  # An advertised main object missing locally must not be confused with the stale tracking ref.
  $donor=Join-Path $fixture 'remote-writer'
  Git $fixture @('clone','-q','--branch','main',$remote,$donor)
  Git $donor @('config','user.name','Remote Fixture');Git $donor @('config','user.email','fixture@example.invalid');Git $donor @('config','commit.gpgsign','false');Git $donor @('config','core.hooksPath',(Join-Path $fixture 'empty-hooks'))
  [IO.File]::WriteAllText((Join-Path $donor 'fresh-main'),'new remote main')
  Git $donor @('add','fresh-main');Git $donor @('commit','-qm','fresh remote main');Git $donor @('push','-q','origin','main')
  Reject {& $guard -PackageRoot $source} 'remote-main-object-unavailable'
  Reject {& $guard -PackageRoot $source -PreMergeDeploy -Reason 'unknown must not admit'} 'remote-main-object-unavailable'
  Git $source @('fetch','-q','origin','main')
  $knownSide=& $guard -PackageRoot $source -PreMergeDeploy -Reason 'known side after explicit fixture fetch'
  Check ($knownSide.mainPolicy.relation -eq 'not-in-main') 'explicit fixture fetch restores known ancestry without auto-fetch'
  Git $source @('checkout','--detach','-q',$older)
  $detached=& $guard -PackageRoot $source
  Check ($detached.mainPolicy.detached -and $detached.mainPolicy.branch -eq '(detached)' -and $detached.mainPolicy.relation -eq 'in-main') 'detached main ancestor recorded explicitly'
  Git $remote @('update-ref','-d','refs/heads/main')
  Reject {& $guard -PackageRoot $source} 'remote-main-missing-or-ambiguous'
  Reject {& $guard -PackageRoot $source -PreMergeDeploy -Reason 'cannot invent main'} 'remote-main-missing-or-ambiguous'
  Git $donor @('push','-q','origin','main')

  # CI parsing uses supplied synthetic responses; no GitHub requests or fixture authentication.
  $emptyChecks=[pscustomobject]@{total_count=0;check_runs=@()}
  $emptyStatus=[pscustomobject]@{sha=$side;total_count=0;statuses=@()}
  $ci=Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @() -CheckRuns $emptyChecks -CombinedStatus $emptyStatus
  Check ($ci.status -eq 'none' -and $ci.conclusion -eq 'none') 'genuinely absent PR and CI recorded as none'
  $syntheticPr=[pscustomobject]@{number=1;state='open';head=@{sha=$side};base=@{repo=@{full_name='fixture/repo'}}}
  $secondPr=[pscustomobject]@{number=2;state='closed';head=@{sha=$side};base=@{repo=@{full_name='fixture/repo'}}}
  $wrongPr=[pscustomobject]@{number=3;state='open';head=@{sha=('a'*40)};base=@{repo=@{full_name='fixture/repo'}}}
  $ci=Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($syntheticPr,$secondPr,$wrongPr) -CheckRuns $emptyChecks -CombinedStatus $emptyStatus
  Check ($ci.status -eq 'observed' -and $ci.pullRequests.Count -eq 2 -and $ci.pullRequests.number -notcontains 3 -and $ci.conclusion -eq 'none') 'all exact-HEAD PR matches retained and wrong HEAD excluded'
  $passedChecks=[pscustomobject]@{total_count=1;check_runs=@([pscustomobject]@{name='Windows';head_sha=$side;status='completed';conclusion='success'})}
  $ci=Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($syntheticPr) -CheckRuns $passedChecks -CombinedStatus $emptyStatus
  Check ($ci.status -eq 'observed' -and $ci.conclusion -eq 'success') 'exact-SHA complete successful checks recorded'
  $passedChecks.check_runs[0].conclusion='failure'
  $ci=Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($syntheticPr) -CheckRuns $passedChecks -CombinedStatus $emptyStatus
  Check ($ci.conclusion -eq 'failure') 'failed CI remains failed evidence'
  $passedChecks.check_runs[0].status='in_progress';$passedChecks.check_runs[0].conclusion=$null
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($syntheticPr) -CheckRuns $passedChecks -CombinedStatus $emptyStatus).conclusion -eq 'pending') 'pending CI not promoted to success'
  $truncated=[pscustomobject]@{total_count=2;check_runs=@()}
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @() -CheckRuns $truncated -CombinedStatus $emptyStatus).status -eq 'unavailable') 'CI total-count truncation is unavailable'
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests (@($syntheticPr)*100) -CheckRuns $emptyChecks -CombinedStatus $emptyStatus).status -eq 'unavailable') 'full PR page fails closed on coverage'
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @([pscustomobject]@{garbage=1}) -CheckRuns $emptyChecks -CombinedStatus $emptyStatus).status -eq 'unavailable') 'malformed unmatched PR response never absence'
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @() -CheckRuns ([pscustomobject]@{}) -CombinedStatus $emptyStatus).status -eq 'unavailable') 'malformed CI response never none'
  $badHead=[pscustomobject]@{number=1;state='open';head=@{sha='malformed'};base=@{repo=@{full_name='fixture/repo'}}}
  $badBase=[pscustomobject]@{number=1;state='open';head=@{sha=$side};base=@{repo=@{full_name='malformed'}}}
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($badHead) -CheckRuns $emptyChecks -CombinedStatus $emptyStatus).status -eq 'unavailable') 'valid PR number and state cannot hide malformed head SHA'
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @($badBase) -CheckRuns $emptyChecks -CombinedStatus $emptyStatus).status -eq 'unavailable') 'valid PR number and state cannot hide malformed base repository'
  $wrongShape=[pscustomobject]@{total_count=1;check_runs=[pscustomobject]@{name='Windows';head_sha=$side;status='completed';conclusion='success'}}
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @() -CheckRuns $wrongShape -CombinedStatus $emptyStatus).status -eq 'unavailable') 'integer total_count cannot hide scalar check_runs'
  $wrongStatusShape=[pscustomobject]@{sha=$side;total_count=1;statuses=[pscustomobject]@{context='Windows';state='success'}}
  Check ((Convert-DeploymentCiEvidence -RepositoryName 'fixture/repo' -Commit $side -PullRequests @() -CheckRuns $emptyChecks -CombinedStatus $wrongStatusShape).status -eq 'unavailable') 'integer total_count cannot hide scalar statuses'

  Check ((New-DeploymentCiUnavailable 'network-or-auth-failed' $side).status -eq 'unavailable') 'unknown transport distinct from genuine absence'

  # Real child processes verify status, stderr, timeout, output cap, missing executable and handle disposal.
  $node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e','process.stderr.write("expected failure");process.exit(7)') -WorkingDirectory $source
  Check ($child.status -eq 7 -and $child.stderr -eq 'expected failure' -and -not (Test-DeploymentProcessSuccess $child)) 'real nonzero exit and stderr preserved'
  $child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e','setInterval(()=>{},1000)') -WorkingDirectory $source -TimeoutMs 250
  Check ($child.timedOut -and -not (Test-DeploymentProcessSuccess $child) -and $child.elapsedMs -lt 3500) 'real child timeout bounded and not accepted'
  $childPidFile=Join-Path $fixture 'child.pid'
  $treeCode='const fs=require("node:fs"),cp=require("node:child_process");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit",windowsHide:true});fs.writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)'
  $treeChild=$null
  try {
    $child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e',$treeCode,$childPidFile) -WorkingDirectory $source -TimeoutMs 1000
    Check (Test-Path -LiteralPath $childPidFile) 'real child-tree fixture launched a descendant'
    $treeChild=[int][IO.File]::ReadAllText($childPidFile)
    Check ($child.timedOut -and -not $child.signal -and -not (Get-Process -Id $treeChild -ErrorAction SilentlyContinue)) 'timeout reaps live parent and real descendant'
  } finally {if($treeChild -and (Get-Process -Id $treeChild -ErrorAction SilentlyContinue)){Stop-Process -Id $treeChild -Force}}

  $child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e','process.stdout.write("x".repeat(65536));setInterval(()=>{},1000)') -WorkingDirectory $source -MaxOutputBytes 8192
  Check ($child.outputLimit -and [Text.Encoding]::UTF8.GetByteCount($child.stdout) -le 8192 -and -not (Test-DeploymentProcessSuccess $child)) 'real output cap kills producer before unbounded capture'
  $child=Invoke-DeploymentProcess -FilePath (Join-Path $fixture 'missing.exe') -WorkingDirectory $source
  Check ($child.error -and -not (Test-DeploymentProcessSuccess $child)) 'missing executable is explicit unsuccessful launch'
  $child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e','process.stdout.write(String(process.env.GIT_DIR===undefined));process.exit(0)') -WorkingDirectory $source
  Check (Test-DeploymentProcessSuccess $child) 'normal child success retains process contract'
  $envBefore=$env:GIT_DIR
  try {$env:GIT_DIR='inherited-override';$child=Invoke-DeploymentProcess -FilePath $node -Arguments @('-e','process.stdout.write(String(process.env.GIT_DIR===undefined))') -WorkingDirectory $source;Check ($child.stdout -eq 'true' -and (Test-DeploymentProcessSuccess $child)) 'inherited Git override removed from child environment'}
  finally {if($null -eq $envBefore){Remove-Item Env:GIT_DIR -ErrorAction SilentlyContinue}else{$env:GIT_DIR=$envBefore}}

  Git $source @('remote','set-url','origin',(Join-Path $fixture 'missing-remote.git'))
  Reject {& $guard -PackageRoot $source} 'Remote HEAD verification failed'
  Write-Output "PASS: $checks deployment admission checks; real Git, inert installer, no production deployment"
} finally {if(Test-Path -LiteralPath $fixture){$resolved=[IO.Path]::GetFullPath($fixture);if(-not $resolved.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup.'};Remove-Item -LiteralPath $resolved -Recurse -Force}}
