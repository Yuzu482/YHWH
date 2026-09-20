#Requires -Version 7.0
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$plugin=Join-Path $root 'payload/pi-dispatch'
$runner=Join-Path $PSScriptRoot 'Invoke-Headless.ps1'
$scratch=Join-Path $root ('.test/headless-package-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  # Reproduce just this feature's packaged files in an isolated installation.
  foreach($relative in @('scripts/headless-host.mjs','scripts/headless-adapters.mjs','scripts/headless-job.ps1','scripts/headless-acceptance.mjs','workflow/headless.example.json','workflow/catalog.json')) {
    $destination=Join-Path $scratch $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $plugin $relative) -Destination $destination
  }
  $report=& $runner -Action Doctor -PluginRoot $scratch -ConfigFile (Join-Path $scratch 'workflow/headless.example.json') | ConvertFrom-Json
  if($report.modelCalls -ne 0 -or @($report.clients.psobject.Properties.Value | Where-Object status -ne 'disabled').Count){throw 'Default doctor must be inert.'}
  $parity=& $runner -Action Compare -ComparePluginRoot $scratch | ConvertFrom-Json
  if($parity.status -ne 'matched'){throw 'Packaged feature must match source.'}
  $node=(Get-Command node -CommandType Application | Select-Object -First 1).Source
  $fixture=Join-Path $scratch 'fixture.mjs'
  Set-Content -LiteralPath $fixture -Value @'
const args=process.argv.slice(2);
if(args.includes('--version')) console.log('fixture 1');
else if(args.includes('--help')) console.log('--json --ephemeral --sandbox --model --config --color');
else { for await(const chunk of process.stdin){} console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}));console.log(JSON.stringify({type:'turn.completed'})); }
'@
  $configFile=Join-Path $scratch 'fixture.local.json'
  @{schemaVersion=1;workspaceRoots=@($scratch);timeoutSeconds=10;maxOutputBytes=65536;clients=@{codex=@{enabled=$true;executable=$node;nodeScript=$fixture;expectedVersion='fixture 1';model='fixture-model';policy='read-only'}}} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile
  $requestsFile=Join-Path $scratch 'batch.local.json'
  @(@{client='codex';cwd=$scratch;prompt='Return ok.'},@{client='codex';cwd=$scratch;prompt='Return ok.'}) | ConvertTo-Json | Set-Content -LiteralPath $requestsFile
  $events=@(& $runner -Action BatchEvents -PluginRoot $scratch -ConfigFile $configFile -RequestFile $requestsFile | ForEach-Object { $_ | ConvertFrom-Json })
  if($events[0].type -ne 'batch-start' -or $events[-1].result.status -ne 'completed' -or $events[-1].result.summary.helpCacheHits -ne 1){throw 'Packaged batch stream failed.'}
  $workflowEvents=@(& (Join-Path $root 'Workflow.ps1') -Action HeadlessBatchEvents -HeadlessConfigFile $configFile -HeadlessRequestFile $requestsFile | ForEach-Object { $_ | ConvertFrom-Json })
  if($workflowEvents[-1].result.status -ne 'completed' -or @($workflowEvents | Where-Object type -eq 'request-result').Count -ne 2){throw 'Workflow batch entry failed.'}
  Add-Content -LiteralPath (Join-Path $scratch 'scripts/headless-adapters.mjs') -Value '// drift fixture'
  $rejected=$false
  try { & $runner -Action Compare -ComparePluginRoot $scratch | Out-Null } catch { $rejected=$true }
  if(-not $rejected){throw 'Installed drift was not rejected.'}
  Write-Host '[PASS] Headless wrappers, model-free batch streams, inert defaults, isolated packaged runtime and installed drift detection.'
} finally {
  $resolved=[IO.Path]::GetFullPath($scratch)
  $expected=[IO.Path]::GetFullPath((Join-Path $root '.test'))+[IO.Path]::DirectorySeparatorChar
  if(-not $resolved.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe fixture cleanup path.'}
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
$global:LASTEXITCODE=0
