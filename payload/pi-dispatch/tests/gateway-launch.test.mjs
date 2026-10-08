import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const entry = fileURLToPath(new URL('../scripts/start-gateway.mjs', import.meta.url));
const ensure = fileURLToPath(new URL('../../../install/Ensure-SilentRuntime.ps1', import.meta.url));
const ps = process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA, 'Programs/PowerShell/7/pwsh.exe'),path.join(process.env.ProgramFiles,'PowerShell/7/pwsh.exe')].find(p=>fs.existsSync(p)) : null;
const shells = process.platform === 'win32' ? [...(ps?[{label:'pwsh7',exe:ps}]:[]),{label:'windowsPS51',exe:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')}].filter(s=>fs.existsSync(s.exe)) : [];
const q = s => "'" + s.replaceAll("'", "''") + "'";
async function command(exe, args, options = {}) {
  const {input='',...spawnOptions}=options;
  const started = Date.now(), p = spawn(exe, args, {windowsHide: true, stdio: ['pipe','pipe','pipe'], ...spawnOptions});
  let stdout = '', stderr = '', exitCode, exitMs;
  p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b); p.stdin.end(input);
  p.on('exit', c => {exitCode = c; exitMs = Date.now() - started;});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {p.kill(); reject(Error('launcher did not close pipes: ' + stdout + stderr));}, 35000);
    p.once('error', error => {clearTimeout(timer); reject(error);});
    p.once('close', () => {clearTimeout(timer); resolve({exitCode, exitMs, closeMs: Date.now() - started, stdout, stderr});});
  });
}
async function fixture(t, scenario = 'ready') {
  // Windows TEMP may use an 8.3 alias. Settings require a canonical absolute path.
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryRoot, 'yhwh launch ')));
  fs.mkdirSync(path.join(root, 'scripts'));
  const launcher = path.join(root, 'scripts/start-gateway.mjs');
  fs.copyFileSync(entry, launcher);
  fs.copyFileSync(new URL('../scripts/isolated-gateway-launch.ps1',import.meta.url),path.join(root,'scripts/isolated-gateway-launch.ps1'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});
  });
  const settings = path.join(root, 'settings.json'), config = path.join(root, 'config.json');
  const gateway = path.join(root, 'scripts/gateway.mjs'), pidFile = path.join(root, 'owned.pid');
  fs.writeFileSync(gateway, `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const c=JSON.parse(fs.readFileSync(process.env.PI_GATEWAY_CONFIG));
fs.writeFileSync(c.pidFile,String(process.pid));console.log('stdout fixture');console.error('stderr fixture');
process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(path.join(c.root,'stdin-eof'),'yes'));
if(c.scenario==='exit7')process.exit(7);
if(c.scenario==='wrapper-failure')setTimeout(()=>process.kill(process.ppid),50);
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer isolated-launch-token'){res.writeHead(401);res.end('{}');return;}
 res.setHeader('Content-Type','application/json');
 if(req.url==='/readyz')res.end(JSON.stringify({ok:!['timeout','wrapper-failure'].includes(c.scenario)}));
 else if(req.url==='/admin/upgrade/status')res.end(JSON.stringify({pid:c.scenario==='wrong-pid'?process.pid+1:process.pid,phase:'running'}));
 else {res.writeHead(404);res.end('{}');}
});
if(c.scenario==='record-failure'){
 const name=fs.readdirSync(c.root).find(p=>/^gateway-start-.*\\.json$/.test(p));fs.unlinkSync(path.join(c.root,name));fs.mkdirSync(path.join(c.root,name));
}
server.listen(c.port,'127.0.0.1');`);
  fs.writeFileSync(config, JSON.stringify({host:'127.0.0.1',port,scenario,pidFile,root}));
  const tokenFile = path.join(root,'token.txt'); fs.writeFileSync(tokenFile,'isolated-launch-token');
  const data = {nodePath:process.execPath,gatewayScript:gateway,gatewayConfig:config,
    gatewayUrl:'http://127.0.0.1:'+port,tokenFile,wslDistro:'fixture-not-wsl'};
  fs.writeFileSync(settings,JSON.stringify(data));
  t.after(async () => {
    if(fs.existsSync(pidFile)){
      const pid=Number(fs.readFileSync(pidFile));try{process.kill(pid);}catch(error){if(error.code!=='ESRCH')throw error;}
      const deadline=Date.now()+5000;
      for(;;){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}
        assert.ok(Date.now()<deadline,'owned fixture process cleanup must complete');await new Promise(r=>setTimeout(r,50));}
    }
    assert.equal(path.dirname(root),temporaryRoot);
    await fs.promises.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  });
  return {root,launcher,settings,config,data,pidFile,port,
    run:args=>command(process.execPath,[launcher,...(args??['--settings-file',settings,'--timeout-ms',scenario==='timeout'?'1000':'5000'])])};
}
function dead(pid){assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}
test('Windows short TEMP aliases still generate canonical gateway fixtures and launch successfully',
  {skip:process.platform!=='win32',timeout:40000},async t=>{
    const parent=fs.realpathSync.native(os.tmpdir());
    const base=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'yhwh alias base ')));
    try {
    const shell=shells.find(s=>s.label==='windowsPS51');
    if(!shell)return t.skip('Windows PowerShell unavailable');
    const source='using System.Text;using System.Runtime.InteropServices;public static class ShortFixturePath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode)]public static extern uint GetShortPathName(string path,StringBuilder output,uint length);}';
    const converted=await command(shell.exe,['-NoProfile','-NonInteractive','-Command',
      `Add-Type -TypeDefinition ${q(source)};$b=New-Object Text.StringBuilder 32768;if(-not [ShortFixturePath]::GetShortPathName(${q(base)},$b,32768)){throw 'Short path unavailable'};[Console]::Write($b.ToString())`]);
    assert.equal(converted.exitCode,0,converted.stderr);const alias=converted.stdout.trim();
    if(alias.toLowerCase()===base.toLowerCase())return t.skip('Filesystem has no short filename alias');
    const saved={TEMP:process.env.TEMP,TMP:process.env.TMP};let f;
    try{process.env.TEMP=alias;process.env.TMP=alias;f=await fixture(t);}
    finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
    assert.equal(f.root,fs.realpathSync.native(f.root));
    assert.equal(path.dirname(f.root),base);
    const actual=await f.run();assert.equal(actual.exitCode,0,actual.stdout+actual.stderr);
    assert.equal(JSON.parse(actual.stdout).status,'ready');
    } finally {
      // Register last: the nested service fixture must close and clean up first.
      t.after(()=>{assert.equal(path.dirname(base),parent);fs.rmSync(base,{recursive:true,force:true});});
    }
  });
for(const scenario of ['ready','exit7','timeout','wrong-pid','record-failure']){
  test('real detached gateway: '+scenario,{timeout:40000},async t=>{
    const f=await fixture(t,scenario),actual=await f.run(),r=JSON.parse(actual.stdout);
    assert.equal(actual.exitCode,scenario==='ready'?0:1,actual.stdout+actual.stderr);
    assert.ok(actual.closeMs<r.timeoutMs+20000,JSON.stringify(actual));
    if(scenario==='timeout')assert.ok(r.elapsedMs<r.timeoutMs+5000+1000,'inner timeout/reap must stay bounded');
    const pid=Number(fs.readFileSync(f.pidFile));
    if(scenario==='ready'){
      assert.equal(r.status,'ready');assert.equal(r.pid,pid);process.kill(pid,0);
      assert.equal(r.childExitCode,null);assert.ok(fs.existsSync(path.join(f.root,'stdin-eof')));
      assert.equal(JSON.parse(fs.readFileSync(r.completionFile)).status,'ready');
    }else{
      assert.equal(r.cleanupConfirmed,true);dead(pid);
      assert.equal(r.failure,{'exit7':'gateway_exited',timeout:'readiness_timeout','wrong-pid':'gateway_identity_mismatch','record-failure':'gateway_launch_failed'}[scenario]);
      if(scenario==='exit7')assert.equal(r.childExitCode,7);
      if(scenario==='timeout')assert.equal(r.timedOut,true);
      if(scenario==='record-failure')assert.equal(r.completionWriteFailed,true);
    }
    assert.match(fs.readFileSync(r.stdoutLog,'utf8'),/stdout fixture/);
    assert.match(fs.readFileSync(r.stderrLog,'utf8'),/stderr fixture/);
    assert.doesNotMatch(actual.stdout+actual.stderr,/isolated-launch-token/);
    assert.ok(!fs.readdirSync(f.root).some(p=>p.endsWith('.tmp')));
    if(scenario!=='ready'){
      for(const p of [r.stdoutLog,r.stderrLog]){fs.renameSync(p,p+'.moved');fs.unlinkSync(p+'.moved');}
    }
  });
}

test('busy port is rejected without touching the existing owner',async t=>{
  const f=await fixture(t),server=net.createServer();t.after(()=>server.close());
  await new Promise(r=>server.listen(f.port,'127.0.0.1',r));
  const actual=await f.run();assert.equal(actual.exitCode,1);
  assert.equal(JSON.parse(actual.stdout).failure,'port_unavailable');
  assert.equal(server.listening,true);assert.equal(fs.existsSync(f.pidFile),false);
});
test('missing Windows bridge fails closed with no service or temporary transport files',
  {skip:process.platform!=='win32'},async t=>{
    const f=await fixture(t);fs.unlinkSync(path.join(f.root,'scripts/isolated-gateway-launch.ps1'));
    const actual=await f.run();assert.equal(actual.exitCode,1);
    const r=JSON.parse(actual.stdout);assert.equal(r.failure,'native_launcher_failed');
    assert.equal(r.recoveryRequired,true);assert.equal(fs.existsSync(f.pidFile),false);
    assert.ok(!fs.readdirSync(f.root).some(p=>p.endsWith('.tmp')));
  });
test('unexpected wrapper death keeps recovery paths and does not pretend its live service was reaped',
  {skip:process.platform!=='win32',timeout:40000},async t=>{
    const f=await fixture(t,'wrapper-failure'),actual=await f.run(),r=JSON.parse(actual.stdout);
    assert.equal(actual.exitCode,1);assert.equal(r.failure,'native_launcher_failed');
    assert.equal(r.cleanupConfirmed,false);assert.equal(r.recoveryRequired,true);
    const pid=Number(fs.readFileSync(f.pidFile));process.kill(pid,0);assert.equal(r.pid,pid);
    assert.equal(r.childExitCode,null);assert.equal(r.completionRecordExists,true);
    assert.equal(JSON.parse(fs.readFileSync(r.completionFile)).status,'starting');
    assert.equal(JSON.parse(fs.readFileSync(r.recoveryFile)).cleanupConfirmed,false);
    assert.match(fs.readFileSync(r.stdoutLog,'utf8'),/stdout fixture/);
    assert.match(fs.readFileSync(r.stderrLog,'utf8'),/stderr fixture/);
    assert.ok(!fs.readdirSync(f.root).some(p=>p.endsWith('.tmp')));
  });
test('hardlinked settings are rejected before launch',async t=>{
  const f=await fixture(t);fs.linkSync(f.settings,path.join(f.root,'linked-settings.json'));
  const actual=await f.run();assert.equal(actual.exitCode,1);assert.equal(JSON.parse(actual.stdout).failure,'invalid_settings');
  assert.equal(fs.existsSync(f.pidFile),false);
});
for(const invalid of ['url','script','node','config-port','empty-token','corrupt-json','missing-config','bad-timeout']){
  test('launch preflight rejects '+invalid,async t=>{
    const f=await fixture(t);
    if(invalid==='url')f.data.gatewayUrl='http://example.com:17331';
    if(invalid==='script')f.data.gatewayScript=entry;
    if(invalid==='node')f.data.nodePath=path.join(f.root,'missing.exe');
    if(invalid==='config-port')fs.writeFileSync(f.config,JSON.stringify({host:'127.0.0.1',port:f.port+1}));
    if(invalid==='empty-token')fs.writeFileSync(f.data.tokenFile,'');
    if(invalid==='missing-config')fs.unlinkSync(f.config);
    fs.writeFileSync(f.settings,invalid==='corrupt-json'?'not JSON':JSON.stringify(f.data));
    const actual=await f.run(invalid==='bad-timeout'?['--settings-file',f.settings,'--timeout-ms','30001']:undefined);
    assert.equal(actual.exitCode,1);assert.equal(JSON.parse(actual.stdout).status,'failed');
    assert.equal(fs.existsSync(f.pidFile),false);assert.equal(fs.readdirSync(f.root).filter(p=>p.startsWith('gateway-start-')).length,0);
  });
}
for(const args of [[],['--unknown'],['--settings-file'],['--settings-file','x','--timeout-ms','bad']]){
  test('strict CLI rejects '+JSON.stringify(args),async()=>{
    const r=await command(process.execPath,[entry,...args]);assert.equal(r.exitCode,2);assert.match(r.stderr,/Usage:/);
  });
}
for(const input of ['', 'not JSON', '{}']) test('native bridge rejects incomplete/corrupt input '+JSON.stringify(input),
  {skip:!ps||!fs.existsSync(ps)},async()=>{
    const bridge=fileURLToPath(new URL('../scripts/isolated-gateway-launch.ps1',import.meta.url));
    const actual=await command(ps,['-NoProfile','-NonInteractive','-File',bridge],{input});
    assert.equal(actual.exitCode,1);assert.match(actual.stderr,/Isolated gateway launcher failed/);
  });

for (const shell of shells) for (const invocation of ['native','controlled']) test('nested PowerShell deployment wrapper returns while its service stays alive: '+shell.label+'/'+invocation,
  {timeout:40000},async t=>{
    const f=await fixture(t),inner=path.join(f.root,'inner.ps1'),outer=path.join(f.root,'outer.ps1');
    fs.writeFileSync(inner,`$ErrorActionPreference='Stop'\n$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(ensure)},[ref]$tokens,[ref]$errors)\nif($errors.Count){throw 'parse failure'}\n$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Hidden'},$true)\nInvoke-Expression $f.Extent.Text\nInvoke-Hidden ${q(process.execPath)} @(${q(f.launcher)},'--settings-file',${q(f.settings)},'--timeout-ms','3000')\n`);
    if (invocation === 'native') fs.writeFileSync(inner,`& ${q(process.execPath)} ${q(f.launcher)} --settings-file ${q(f.settings)} --timeout-ms 3000\nexit $LASTEXITCODE\n`);
    fs.writeFileSync(outer,`& ${q(shell.exe)} -NoProfile -NonInteractive -File ${q(inner)} *> ${q(path.join(f.root,'operation.log'))}\n$rc=$LASTEXITCODE\n[IO.File]::WriteAllText(${q(path.join(f.root,'operation-result.json'))},('{"exitCode":'+$rc+'}'))\nGet-Content -LiteralPath ${q(path.join(f.root,'operation.log'))}\nexit $rc\n`);
    // ProcessStartInfo.ArgumentList is the supported pwsh 7 entry, not legacy PowerShell 5.1.
    if(shell.label==='windowsPS51'&&invocation==='controlled') return t.skip('foreground helper requires pwsh7; native nesting still tested on WindowsPS51');
    const actual=await command(shell.exe,['-NoProfile','-NonInteractive','-File',outer]);
    assert.equal(actual.exitCode,0,actual.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'operation-result.json'))).exitCode,0);
    const r=JSON.parse(actual.stdout);assert.equal(r.status,'ready');assert.ok(actual.closeMs<r.timeoutMs+20000);process.kill(r.pid,0);
  });

test('PowerShell foreground helper closes stdin, preserves nonzero output and disposes handles',
  {skip:!ps||!fs.existsSync(ps),timeout:20000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-foreground-'));
    t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const source=fs.readFileSync(ensure,'utf8');
    // Extract the actual function through the parser, avoiding runtime/Tunnel side effects.
    const script=path.join(root,'check.ps1'),fixtureFile=path.join(root,'child.mjs');
    fs.writeFileSync(fixtureFile,"process.stdin.resume();process.stdin.on('end',()=>{console.log('out fixture');console.error('err fixture');process.exit(7)});");
    fs.writeFileSync(script,`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(ensure)},[ref]$tokens,[ref]$errors)\nif($errors.Count){throw 'parse failure'}\n$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Hidden'},$true)\nInvoke-Expression $f.Extent.Text\ntry{Invoke-Hidden ${q(process.execPath)} @(${q(fixtureFile)});exit 9}catch{Write-Output $_.Exception.Message;exit 0}\n`);
    const r=await command(ps,['-NoProfile','-NonInteractive','-File',script]);assert.equal(r.exitCode,0);
    assert.match(r.stdout,/exit code 7/);assert.match(r.stdout,/out fixture/);assert.match(r.stdout,/err fixture/);
    assert.ok(!source.includes('[switch]$Background'));
  });

test('PowerShell foreground timeout has real exit metadata and reaps its owned process',
  {skip:!ps||!fs.existsSync(ps),timeout:20000},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-foreground-timeout-'));
    t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
    const fixtureFile=path.join(root,'child.mjs'),pidFile=path.join(root,'child.pid'),script=path.join(root,'check.ps1');
    fs.writeFileSync(fixtureFile,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('before timeout');setInterval(()=>{},1000);`);
    fs.writeFileSync(script,`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(ensure)},[ref]$tokens,[ref]$errors)\n$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-Hidden'},$true)\nInvoke-Expression $f.Extent.Text\ntry{Invoke-Hidden ${q(process.execPath)} @(${q(fixtureFile)}) -TimeoutMs 1000 -DrainMs 500;exit 9}catch{if(-not $_.Exception.Data['processResult']){throw};$_.Exception.Data['processResult'] | ConvertTo-Json -Compress;exit 0}\n`);
    const actual=await command(ps,['-NoProfile','-NonInteractive','-File',script]);assert.equal(actual.exitCode,0);
    const r=JSON.parse(actual.stdout);assert.equal(r.timedOut,true);assert.notEqual(r.status,null);
    assert.notEqual(r.status,0);assert.match(r.stderr,/before timeout/);dead(Number(fs.readFileSync(pidFile)));
  });
