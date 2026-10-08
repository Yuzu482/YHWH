param([Parameter(Mandatory)][string]$SettingsFile)
$ErrorActionPreference = 'Stop'
$s = Get-Content -LiteralPath $SettingsFile -Raw | ConvertFrom-Json
$runtimeLog = Join-Path (Split-Path -Parent $SettingsFile) 'runtime-startup.jsonl'
$stage = 'configuration'
$gatewayProcess = $null
function Write-RuntimeEvent([string]$Event, [hashtable]$Details = @{}) {
    if ((Test-Path -LiteralPath $runtimeLog) -and (Get-Item -LiteralPath $runtimeLog).Length -gt 1MB) {
        Move-Item -LiteralPath $runtimeLog -Destination ($runtimeLog + '.1') -Force
    }
    $record = @{timestamp=[DateTimeOffset]::UtcNow.ToString('o');event=$Event;stage=$stage}
    foreach ($key in $Details.Keys) { $record[$key] = $Details[$key] }
    $record | ConvertTo-Json -Compress | Add-Content -LiteralPath $runtimeLog -Encoding utf8
}
function Invoke-Hidden([string]$Exe, [string[]]$Arguments, [hashtable]$Environment = @{},
    [ValidateRange(100,60000)][int]$TimeoutMs = 60000, [ValidateRange(100,5000)][int]$DrainMs = 5000) {
    $info = [Diagnostics.ProcessStartInfo]::new($Exe)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    foreach ($key in $Environment.Keys) { $info.Environment[$key] = $Environment[$key] }
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $p = $null; $started = $false; $out = $null; $err = $null
    $details = @{status=$null;signal='';stdout='';stderr='';error='';timedOut=$false}
    try {
        $p = [Diagnostics.Process]::Start($info); $started = $true
        $p.StandardInput.Close()
        $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutMs)) { $details.timedOut=$true; $p.Kill($true); [void]$p.WaitForExit(5000) }
        if ($p.HasExited) {$details.status=$p.ExitCode} else {$details.signal='child cleanup unconfirmed'}
        if ($out.Wait($DrainMs)) {$details.stdout=$out.Result} else {$details.signal='stdout drain timeout'}
        if ($err.Wait($DrainMs)) {$details.stderr=$err.Result} else {$details.signal='stderr drain timeout'}
    } catch {
        $details.error=$_.Exception.GetType().Name
    } finally {
        if ($p) {
            try { if ($started -and -not $p.HasExited) { $p.Kill($true); [void]$p.WaitForExit(5000) } } catch {$details.signal='child cleanup unconfirmed'}
            $p.Dispose()
        }
    }
    if ($details.status -ne 0 -or $details.error -or $details.signal -or $details.timedOut) {
        $failure=[Exception]::new("Runtime command failed with exit code $($details.status); timeout=$($details.timedOut); signal=$($details.signal); error=$($details.error); stdout: $($details.stdout); stderr: $($details.stderr)")
        $failure.Data['processResult']=$details
        throw $failure
    }
    return $details.stdout
}
$mutex = [Threading.Mutex]::new($false, 'Local\PiKetherSilentRuntime')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit 0 }
try {
    $gatewayConfig = Get-Content -LiteralPath $s.gatewayConfig -Raw | ConvertFrom-Json
    $gatewayUri = [uri]$s.gatewayUrl
    if ($gatewayUri.Scheme -ne 'http' -or $gatewayUri.Host -ne '127.0.0.1' -or $gatewayConfig.host -ne '127.0.0.1' -or $gatewayUri.Port -ne $gatewayConfig.port) {
        throw 'Gateway URL and loopback configuration must match'
    }
    $headers = @{Authorization = 'Bearer ' + ([IO.File]::ReadAllText($s.tokenFile).Trim())}
    $ready = $false
    try { $r = Invoke-RestMethod ($s.gatewayUrl + '/readyz') -Headers $headers -TimeoutSec 3; $ready = $r.ok -eq $true } catch {}
    if (-not $ready) {
        $stage = 'port-preflight'
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $gatewayUri.Port)
        try { $listener.Start() } catch {
            $socketError = $_.Exception
            while ($socketError.InnerException) { $socketError = $socketError.InnerException }
            Write-RuntimeEvent 'port-unavailable' @{port=$gatewayUri.Port;code=[string]$socketError.SocketErrorCode}
            throw 'Gateway port cannot be bound; see runtime-startup.jsonl'
        } finally { $listener.Stop() }
        $stage = 'gateway-start'
        $launcher = Join-Path (Split-Path -Parent $s.gatewayScript) 'start-gateway.mjs'
        $launch = (Invoke-Hidden $s.nodePath @($launcher, '--settings-file', [IO.Path]::GetFullPath($SettingsFile))) | ConvertFrom-Json
        if ($launch.status -ne 'ready' -or $launch.exitCode -ne 0) { throw 'Gateway launch was not confirmed' }
        $gatewayProcess = Get-Process -Id $launch.pid -ErrorAction Stop
        Write-RuntimeEvent 'gateway-ready' @{pid=$launch.pid;completionFile=$launch.completionFile}
        $ready = $true
    }
    $stage = 'tunnel-connect'
    # Use HTTP so the Tunnel daemon never launches a cmd.exe MCP transport.
    # Keep optional Codex CLI discovery out of this runtime's PATH.
    $tunnelEnv = @{MCP_EXTRA_HEADERS=('Authorization: file:' + $s.headerFile); MCP_DISCOVERY_EXTRA_HEADERS=('Authorization: file:' + $s.headerFile); PATH=($env:SystemRoot + '\System32;' + $env:SystemRoot)}
    $status = $null
    try { $raw = Invoke-Hidden $s.tunnelClient @('runtimes','status','pi-kether','--json') $tunnelEnv; $status = $raw | ConvertFrom-Json } catch {}
    if ($status.process_running -and $status.process.target_value -ne ($s.gatewayUrl+'/mcp')) {
        throw 'A Tunnel with a different target is running; reconcile it before reconnecting.'
    }
    if (-not ($status.process_running -and $status.healthy -and $status.ready)) {
        Invoke-Hidden $s.tunnelClient @('runtimes','connect','--alias','pi-kether','--profile','pi-kether','--profile-dir',$s.profileDir,'--tunnel-id',$s.tunnelId,'--mcp-server-url',($s.gatewayUrl+'/mcp'),'--runtime-api-key',('file:'+$s.runtimeKeyFile),'--json') $tunnelEnv | Out-Null
    }
    $raw = Invoke-Hidden $s.tunnelClient @('runtimes','status','pi-kether','--json') $tunnelEnv
    $status = $raw | ConvertFrom-Json
    if (-not ($status.process_running -and $status.healthy -and $status.ready)) { throw 'Tunnel failed readiness check' }
    Write-RuntimeEvent 'ready' @{port=$gatewayUri.Port}
    Write-Output 'Pi Gateway and Tunnel ready (HTTP transport).'
} catch {
    # Record only stage/type, never raw provider output, arguments or credentials.
    $failureDetails=@{errorType=$_.Exception.GetType().Name}
    if ($_.Exception.Data['processResult']) {
        $r=$_.Exception.Data['processResult']; $failureDetails.exitCode=$r.status
        $failureDetails.timedOut=$r.timedOut; $failureDetails.signal=$r.signal
    }
    Write-RuntimeEvent 'startup-failed' $failureDetails
    throw
} finally {
    if ($gatewayProcess) { $gatewayProcess.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
