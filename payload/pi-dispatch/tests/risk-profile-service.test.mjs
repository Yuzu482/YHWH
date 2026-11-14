import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createRiskProfileService} from '../scripts/risk-profile-service.mjs';
import {createIsolatedRiskProfileResolver} from '../scripts/risk-profiles.mjs';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {createTaskMonitor} from '../extensions/task-monitor.js';
import {listenHttpFixture} from './http-fixture.mjs';

const critical=cwd=>({cwd,riskProfile:'critical'}),unresolved=e=>e.code==='PI_RISK_PROFILE_UNRESOLVED';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-async-risk-')),main=path.join(root,'main'),linked=path.join(root,'linked'),plain=path.join(root,'plain'),clone=path.join(root,'clone');
  fs.mkdirSync(main);fs.mkdirSync(plain);
  const git=(cwd,...args)=>{const r=spawnSync('git',['-c','safe.directory='+cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(main,'init');fs.writeFileSync(path.join(main,'a.txt'),'baseline');git(main,'add','a.txt');git(main,'commit','--no-gpg-sign','-m','fixture');git(main,'worktree','add','--detach',linked,'HEAD');git(root,'clone','--no-hardlinks',main,clone);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,main,linked,plain,clone,git};
}
test('async resolver preserves critical peers/downgrade floor, clone separation, alias and anti-spoof checks',async t=>{
  const f=fixture(t),service=createRiskProfileService([critical(f.main),{cwd:f.linked,riskProfile:'personal'}]);t.after(()=>service.close());
  for(const cwd of [f.main,f.linked])assert.equal(await service.resolve(cwd),'critical');
  assert.equal(await service.resolve(f.clone),'standard');assert.equal(await service.resolve(f.plain),'standard');
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.linked,alias,process.platform==='win32'?'junction':'dir');assert.equal(await service.resolve(alias),'critical');
  const spoof=path.join(f.root,'spoof');fs.mkdirSync(spoof);fs.copyFileSync(path.join(f.linked,'.git'),path.join(spoof,'.git'));await assert.rejects(service.resolve(spoof),unresolved);
  assert.equal(await service.resolve(f.clone),'standard','bad candidate does not poison subsequent unrelated writes');
});
test('broken/rebound mapping rejects related writes, uncertain Git gets critical, non-Git remains available',t=>{
  const f=fixture(t),profile=createIsolatedRiskProfileResolver([critical(f.main)]);
  fs.renameSync(path.join(f.main,'.git'),path.join(f.main,'.git.saved'));
  assert.throws(()=>profile(f.main),unresolved);assert.throws(()=>profile(f.linked),unresolved);
  assert.equal(profile(f.clone),'critical');assert.equal(profile(f.plain),'standard');
  f.git(f.main,'init');assert.throws(()=>profile(f.main),unresolved);assert.equal(profile(f.clone),'critical');
});
test('registered critical peer cannot become standard by deleting or replacing its Git marker',t=>{
  const f=fixture(t),profile=createIsolatedRiskProfileResolver([critical(f.main)]),marker=path.join(f.linked,'.git'),saved=fs.readFileSync(marker);
  assert.equal(profile(f.linked),'critical');fs.unlinkSync(marker);
  assert.throws(()=>profile(f.linked),unresolved);assert.equal(profile(f.plain),'standard');
  f.git(f.linked,'init');assert.throws(()=>profile(f.linked),unresolved);
  fs.rmSync(marker,{recursive:true,force:true});fs.writeFileSync(marker,saved);
  assert.equal(profile(f.linked),'critical');
});
test('malformed critical at startup does not crash gateway or disable unrelated non-Git inspection',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.main,'.git','HEAD'),'malformed');
  const service=createRiskProfileService([critical(f.main)]);t.after(()=>service.close());
  assert.equal(await service.resolve(f.plain),'standard');assert.equal(await service.resolve(f.clone),'critical');await assert.rejects(service.resolve(f.main),unresolved);
  const {runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[f.root],riskProfiles:[critical(f.main)],token:'fixture-token-012345678901234567890123',sandboxStatus:{ok:true}});
  assert.equal(runtime.capabilities().lifecycle.phase,'running');assert.equal((await runtime.shutdown()).disposed,true);
});
function slowGit(t,root,mode='sleep') {
  const bin=path.join(root,'bin');fs.mkdirSync(bin);const pidFile=path.join(root,'git-pid.txt');
  if(process.platform==='win32') {
    const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    if(!fs.existsSync(compiler)){t.skip('Windows C# fixture compiler unavailable');return null;}
    const source=path.join(root,'fake.cs');fs.writeFileSync(source,`using System;using System.IO;using System.Threading;class Program{static void Main(){File.WriteAllText(@"${pidFile.replaceAll('"','""')}",System.Diagnostics.Process.GetCurrentProcess().Id.ToString());${mode==='overflow'?'Console.Write(new string(\'x\',1100000));':'Thread.Sleep(10000);'}}}`);
    const r=spawnSync(compiler,['/nologo','/out:'+path.join(bin,'git.exe'),source],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stdout+r.stderr);
  } else {
    fs.writeFileSync(path.join(bin,'git'),`#!/bin/sh\necho $$ > '${pidFile}'\n${mode==='overflow'?"head -c 1100000 /dev/zero | tr '\\000' x":"exec sleep 10"}\n`,{mode:0o700});
  }
  return {bin,pidFile};
}
test('bounded slow Git leaves event loop and HTTP health responsive; queue/shutdown settle and reap work',async t=>{
  const f=fixture(t),fake=slowGit(t,f.root);if(!fake)return;
  const saved=process.env.PATH;process.env.PATH=fake.bin+path.delimiter+saved;
  let service;
  try {
    service=createRiskProfileService([critical(f.main)],{timeoutMs:250,maxPending:2});
    const first=service.resolve(f.main).catch(e=>e.code),second=service.resolve(f.linked).catch(e=>e.code);
    await assert.rejects(service.resolve(f.clone),e=>e.code==='PI_RISK_PROFILE_BUSY');
    let ticks=0;const timer=setInterval(()=>ticks++,5);
    await delay(60);clearInterval(timer);assert(ticks>=3,'event loop must run during synchronous Git in worker');
    await service.close();assert.match(await first,/PI_RISK_PROFILE_(CLOSED|TIMEOUT|UNRESOLVED)/);assert.match(await second,/PI_RISK_PROFILE_(CLOSED|TIMEOUT|UNRESOLVED)/);
    if(fs.existsSync(fake.pidFile)){const pid=Number(fs.readFileSync(fake.pidFile));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH','no inspection process survives close');}
    await assert.rejects(service.resolve(f.main),unresolved);
    const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[f.root],riskProfiles:[critical(f.main)],token:'fixture-token-012345678901234567890123',sandboxStatus:{ok:true}});
    const http=await listenHttpFixture(app),client=new Client({name:'risk-health',version:'1.0.0'});
    let pending;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer fixture-token-012345678901234567890123'}}}));
      const input={cwd:f.main,requestId:'risk-blocked',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',tier:'T0',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},task:{role:'Chesed',objective:'No model execution',acceptance:['Reject before model'],readScope:['a.txt'],writeScope:['a.txt']}};
      pending=client.callTool({name:'dispatch_subagent',arguments:input});
      await delay(100);const start=performance.now(),health=await fetch(`http://127.0.0.1:${http.address().port}/healthz`);assert.equal(health.status,200);assert(performance.now()-start<1000);
      const cap=await client.callTool({name:'list_capabilities',arguments:{}});assert.notEqual(cap.isError,true);
      const read=await client.callTool({name:'dispatch_subagent',arguments:{...input,requestId:'read-bypass',access:'none',task:{...input.task,writeScope:[]}}});
      assert.doesNotMatch(JSON.stringify(read),/PI_RISK_PROFILE/,'read admission must bypass Git even when it fails later validation');
      assert.equal((await pending).isError,true);
      assert(fs.existsSync(fake.pidFile),'real slow Git executable must have run');
      const pid=Number(fs.readFileSync(fake.pidFile));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
    } finally {await pending?.catch(()=>{});await client.close();await runtime.shutdown();await new Promise(r=>http.close(r));}
  } finally {process.env.PATH=saved;await service?.close();}
});
test('total deadlines include queued work, no automatic repinning, and output overflow fails closed',async t=>{
  const f=fixture(t),fake=slowGit(t,f.root,'overflow');if(!fake)return;const saved=process.env.PATH;process.env.PATH=fake.bin+path.delimiter+saved;
  let service;try {
    service=createRiskProfileService([critical(f.main)]);await assert.rejects(service.resolve(f.main),unresolved);assert.equal(await service.resolve(f.plain),'standard');
  } finally {process.env.PATH=saved;await service?.close();}
  const timed=createRiskProfileService([critical(f.main)],{timeoutMs:1});
  try{const results=await Promise.all([timed.resolve(f.main).catch(e=>e.code),timed.resolve(f.linked).catch(e=>e.code)]);for(const code of results)assert.match(code,/PI_RISK_PROFILE_(TIMEOUT|UNRESOLVED)/);await assert.rejects(timed.resolve(f.clone),unresolved);}finally{await timed.close();}
});

test('real worker exit settles every queued request and never silently recreates identity pins',async()=>{
  let created=0;
  class CrashingWorker extends Worker {constructor(){super('process.exit(17)',{eval:true});created++;}}
  const service=createRiskProfileService([critical(os.tmpdir())],{WorkerImpl:CrashingWorker});
  try {
    const results=await Promise.all([service.resolve(os.tmpdir()).catch(e=>e.code),service.resolve(os.tmpdir()).catch(e=>e.code)]);
    assert.deepEqual(results,['PI_RISK_PROFILE_UNRESOLVED','PI_RISK_PROFILE_UNRESOLVED']);
    await assert.rejects(service.resolve(os.tmpdir()),unresolved);assert.equal(created,1);
  } finally {await service.close();}
});
test('upgrade pause rejects real pending persistence without closing intake; pause/resume stays ready',async t=>{
  const f=fixture(t);let release;
  const monitor=createTaskMonitor({gatewayInstanceId:'pause-fixture',persistResult:()=>new Promise(r=>release=r),maintenanceIntervalMs:0});
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[f.root],token:'fixture-token-012345678901234567890123',sandboxStatus:{ok:true},moduleFactories:{taskMonitor:()=>monitor}}),http=await listenHttpFixture(app);
  try {
    const post=action=>fetch(`http://127.0.0.1:${http.address().port}/admin/upgrade/${action}`,{method:'POST',headers:{Authorization:'Bearer fixture-token-012345678901234567890123'}});
    monitor.retainResult({requestId:'pending-persistence',task:{role:'Chesed'}},{ok:true,status:'completed'});
    assert.equal(monitor.resultCache.pendingWrites,1);assert.equal((await post('pause')).status,409);
    assert.equal(runtime.capabilities().lifecycle.phase,'running');assert.equal(monitor.resultCache.accepting,true);
    release(true);await delay(0);assert.equal(monitor.resultCache.pendingWrites,0);
    assert.equal((await post('pause')).status,200);assert.equal((await post('resume')).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${http.address().port}/readyz`)).status,200);assert.equal(monitor.resultCache.accepting,true);
  } finally {release?.(true);await delay(0);await runtime.shutdown();await new Promise(r=>http.close(r));}
});
