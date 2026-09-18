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
function Invoke-Hidden([string]$Exe, [string[]]$Arguments, [hashtable]$Environment = @{}, [switch]$Background) {
    $info = [Diagnostics.ProcessStartInfo]::new($Exe)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) }
    foreach ($key in $Environment.Keys) { $info.Environment[$key] = $Environment[$key] }
    if (-not $Background) { $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true }
    $p = [Diagnostics.Process]::Start($info)
    if ($Background) { return $p }
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(60000)) { $p.Kill($true); throw 'Runtime command timeout' }
    if ($p.ExitCode) { throw "Runtime command failed with exit code $($p.ExitCode)" }
    $result = $out.GetAwaiter().GetResult()
    $p.Dispose()
    return $result
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
        $envs = @{PI_GATEWAY_CONFIG=$s.gatewayConfig; PI_DISPATCH_SANDBOX='wsl2-bwrap'; PI_SANDBOX_DISTRO=$s.wslDistro}
        $gatewayProcess = Invoke-Hidden $s.nodePath @($s.gatewayScript) $envs -Background
        for ($i=0; $i -lt 80; $i++) {
            if ($gatewayProcess.HasExited) {
                Write-RuntimeEvent 'gateway-exited' @{exitCode=$gatewayProcess.ExitCode}
                throw 'Gateway exited before readiness; see runtime-startup.jsonl'
            }
            Start-Sleep -Milliseconds 500
            try { $r = Invoke-RestMethod ($s.gatewayUrl + '/readyz') -Headers $headers -TimeoutSec 2; if ($r.ok) {$ready=$true; break} } catch {}
        }
        if (-not $ready) { throw 'Gateway failed readiness check' }
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
    Write-RuntimeEvent 'startup-failed' @{errorType=$_.Exception.GetType().Name}
    throw
} finally {
    if ($gatewayProcess) { $gatewayProcess.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
