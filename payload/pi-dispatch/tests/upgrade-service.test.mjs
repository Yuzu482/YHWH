import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordInstallation } from '../scripts/plugin-upgrade.mjs';

const entry = fileURLToPath(new URL('../scripts/upgrade-service.mjs', import.meta.url));
const gatewayModule = new URL('../scripts/gateway.mjs', import.meta.url).href;
const httpModule = new URL('./http-fixture.mjs', import.meta.url).href;
const token = 'isolated-upgrade-fixture-token-0123456789';
for (const scenario of ['success', 'broken-start', 'already-maintained']) test(`real HTTP/process upgrade: ${scenario}`, { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yhwh-upgrade-service-'));
  const source = path.join(root, 'new'), target = path.join(root, 'installed');
  fs.mkdirSync(path.join(source, 'scripts'), {recursive:true}); fs.mkdirSync(path.join(target, 'scripts'), {recursive:true});
  const settings = path.join(root, 'settings.json'), config = path.join(root, 'runtime.json'), tokenFile = path.join(root, 'token.txt');
  fs.writeFileSync(tokenFile, token); fs.writeFileSync(config, '{}');
  const script = `import fs from 'node:fs';import {createGatewayApp,gracefulShutdownHttp} from ${JSON.stringify(gatewayModule)};import {listenHttpFixture} from ${JSON.stringify(httpModule)};
const version=1,config=JSON.parse(fs.readFileSync(process.env.PI_GATEWAY_CONFIG));
const {app,runtime}=createGatewayApp({host:'127.0.0.1',roots:[${JSON.stringify(root)}],token:${JSON.stringify(token)},sandboxStatus:{ok:true,backend:'fixture'},onMaintenanceStop:()=>stop()});
app.get('/fixture-version',(_req,res)=>res.json({version}));
const server=await listenHttpFixture(app,config.port?{choosePort:()=>config.port}:{});fs.writeFileSync(process.env.PI_GATEWAY_CONFIG,JSON.stringify({port:server.address().port,pid:process.pid}));
async function stop(){try{await gracefulShutdownHttp(server,runtime);process.exit(0)}catch{process.exit(1)}}
console.log(JSON.stringify({port:server.address().port}));`;
  for (const dir of [source,target]) fs.writeFileSync(path.join(dir,'scripts/gateway.mjs'),script);
  recordInstallation(source,target); fs.writeFileSync(path.join(target,'.mcp.json'),'preserved native configuration');
  const original=spawn(process.execPath,[path.join(target,'scripts/gateway.mjs')],{windowsHide:true,env:{...process.env,PI_GATEWAY_CONFIG:config},stdio:['ignore','pipe','pipe']});
  let url, pid, worker;
  const request=async action=>{const r=await fetch(url+'/admin/upgrade/'+action,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});return {status:r.status,...await r.json()};};
  t.after(async()=>{
    try{pid=JSON.parse(fs.readFileSync(config)).pid}catch{}
    if(url) { try { await request('pause'); await request('stop'); } catch {} }
    for(const p of [worker,original]) if(p?.exitCode===null) {try{p.kill()}catch{}}
    if(pid){try{process.kill(pid)}catch{}}
    await new Promise(r=>setTimeout(r,300));
    assert.equal(path.dirname(root),path.resolve(os.tmpdir())); fs.rmSync(root,{recursive:true,force:true});
  });
  const port=await new Promise((resolve,reject)=>{
    let out='';const timer=setTimeout(()=>reject(Error('fixture_start_timeout')),10000);
    original.stdout.on('data',b=>{out+=b;try{const r=JSON.parse(out);clearTimeout(timer);resolve(r.port)}catch{}});
    original.once('error',reject);original.once('exit',code=>{clearTimeout(timer);reject(Error('fixture_exit_'+code))});
  });
  url='http://127.0.0.1:'+port;
  fs.writeFileSync(settings,JSON.stringify({nodePath:process.execPath,gatewayScript:path.join(target,'scripts/gateway.mjs'),gatewayUrl:url,gatewayConfig:config,tokenFile,wslDistro:'unused-fixture'}));
  fs.writeFileSync(path.join(source,'scripts/gateway.mjs'),scenario==='broken-start'?'process.exit(7);':script.replace('const version=1','const version=2'));
  if(scenario==='already-maintained') assert.equal((await request('pause')).status,200);
  worker=spawn(process.execPath,[entry,source,target,settings,'-','--apply'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const result=await new Promise((resolve,reject)=>{let out='';worker.stdout.on('data',b=>out+=b);worker.once('error',reject);worker.once('close',()=>{try{resolve(JSON.parse(out))}catch{reject(Error('invalid_upgrade_result'))}})});
  assert.equal(result.status,{success:'completed','broken-start':'rolled-back','already-maintained':'blocked'}[scenario],JSON.stringify(result));
  let identity;try{identity=await request('status')}catch{throw Error('service_missing_after_upgrader_exit: '+JSON.stringify(result))}pid=identity.pid;
  assert.equal(identity.phase,scenario==='already-maintained'?'maintenance':'running');
  assert.equal((await (await fetch(url+'/fixture-version')).json()).version,scenario==='success'?2:1);
  assert.equal(fs.readFileSync(path.join(target,'.mcp.json'),'utf8'),'preserved native configuration');
  if(scenario==='already-maintained') assert.equal(identity.pid,original.pid); else assert.notEqual(identity.pid,original.pid);
});
