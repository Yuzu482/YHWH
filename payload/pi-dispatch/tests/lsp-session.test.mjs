import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProbeSessions} from '../scripts/lsp-sandbox-broker.mjs';
const fixture=fileURLToPath(new URL('./lsp-session-fixture.mjs',import.meta.url));
const request=(file='a.ts',tool='lsp_hover')=>({lspId:1,tool,params:{path:file,...(tool==='lsp_diagnostics'?{}:{line:1,character:1})}});
const signal=()=>new AbortController().signal;
async function setup(fn,{mode='normal',idleMs=15000,pythonDual=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-reuse-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  for(const name of ['a.ts','b.ts','a.PY','a.go','a.rs'])fs.writeFileSync(path.join(workspace,name),'const a=1;');
  const children=[];
  // Linux descriptor confinement is exercised by the real WSL fixture.
  const sessions=createProbeSessions(workspace,{idleMs,pythonDual,readSnapshot:(base,file)=>fs.readFileSync(path.join(base,file)),launch:snapshot=>{
    const file=fs.readdirSync(snapshot)[0];
    const child=spawn(process.execPath,[fixture,snapshot,file,typeof mode==='function'?mode(children.length):mode],{stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);return child;
  }});
  try{await fn({sessions,workspace,root,children});}
  finally{await sessions.close();assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));assert.deepEqual(fs.readdirSync(root),['workspace']);fs.rmSync(root,{recursive:true,force:true});}
}

test('session retains one process, runs fresh queries, then awaits graceful cleanup',async()=>setup(async({sessions,children})=>{
  const first=await sessions.run(request(),signal()),second=await sessions.run(request(),signal());
  assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(children.length,1);
  assert.equal(first.serverSession.reused,false);assert.equal(second.serverSession.reused,true);
  assert.equal(second.result.value,1,'server is queried again, not a cached answer');
  assert.equal(second.serverCleanup.ok,null);
  assert.deepEqual(await sessions.close(),{ok:true,mode:'graceful',fault:null});
  assert.equal((await sessions.run(request(),signal())).ok,false);
}));

for(const file of ['a.go','a.rs'])test(file+' rejects incomplete diagnostics and cleans its process',async()=>setup(async({sessions})=>{
  const result=await sessions.run(request(file,'lsp_diagnostics'),signal());
  assert.equal(result.ok,false);assert.equal(result.reason,'missing-diagnostic-evidence');assert.equal(result.serverCleanup.ok,true);
},{mode:'incomplete-diagnostics'}));

test('content and path changes replace prior servers while Python retains two routes',async()=>setup(async({sessions,workspace,children})=>{
  const first=await sessions.run(request(),signal());
  fs.writeFileSync(path.join(workspace,'a.ts'),'const a=2;');
  const changed=await sessions.run(request(),signal());
  assert.equal(changed.ok,true);assert.notEqual(changed.serverSession.documentSha256,first.serverSession.documentSha256);
  for(const r of [request('b.ts'),request('a.PY'),request('a.PY','lsp_diagnostics')])assert.equal((await sessions.run(r,signal())).ok,true);
  assert.equal(children.length,5);assert.ok(children.slice(0,3).every(c=>c.exitCode===0));
  assert.ok(children.slice(3).every(c=>c.exitCode===null));
}));

test('Python alternation reuses exactly two servers and edits invalidate both',async()=>setup(async({sessions,workspace,children})=>{
  const first=await sessions.run(request('a.PY','lsp_diagnostics'),signal());
  const second=await sessions.run(request('a.PY'),signal());
  for(const r of [request('a.PY','lsp_diagnostics'),request('a.PY')]){
    const result=await sessions.run(r,signal());assert.equal(result.ok,true);assert.equal(result.serverSession.reused,true);assert.equal(result.serverSession.poolCapacity,2);
  }
  assert.equal(children.length,2);assert.equal(first.serverSession.poolSlot,'pyright');assert.equal(second.serverSession.poolSlot,'jedi');
  fs.writeFileSync(path.join(workspace,'a.PY'),'changed');
  const changed=await sessions.run(request('a.PY'),signal());assert.equal(changed.ok,true);assert.equal(changed.serverSession.reused,false);
  assert.ok(children.slice(0,2).every(c=>c.exitCode===0));assert.equal(changed.serverSession.generation,3);
}));

test('a failed Python backend cleans the other retained backend too',async()=>setup(async({sessions,root,children})=>{
  assert.equal((await sessions.run(request('a.PY','lsp_diagnostics'),signal())).ok,true);
  const result=await sessions.run(request('a.PY'),signal());assert.equal(result.ok,false);assert.equal(result.serverCleanup.ok,true);
  assert.ok(children.every(c=>c.exitCode!==null||c.signalCode!==null));assert.deepEqual(fs.readdirSync(root),['workspace']);
},{mode:index=>index===0?'normal':'malformed'}));

test('Python cancellation cleans active and idle slots and repeated close awaits cleanup',async()=>setup(async({sessions,root})=>{
  assert.equal((await sessions.run(request('a.PY','lsp_diagnostics'),signal())).ok,true);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120);
  try{const result=await sessions.run(request('a.PY'),controller.signal);assert.equal(result.reason,'cancelled');assert.equal(result.serverCleanup.ok,true);}finally{clearTimeout(timer);}
  assert.deepEqual(fs.readdirSync(root),['workspace']);
  const [a,b]=await Promise.all([sessions.close(),sessions.close()]);assert.equal(a.ok,true);assert.deepEqual(a,b);
},{mode:index=>index===0?'normal':'hang'}));

test('single-slot comparison mode retains the previous Python switching behavior',async()=>setup(async({sessions,children})=>{
  for(const r of [request('a.PY','lsp_diagnostics'),request('a.PY'),request('a.PY','lsp_diagnostics')]){
    const result=await sessions.run(r,signal());assert.equal(result.ok,true);assert.equal(result.serverSession.reused,false);
  }
  assert.equal(children.length,3);assert.ok(children.slice(0,2).every(c=>c.exitCode===0));
},{pythonDual:false}));

test('wrong result hash is rejected and the isolated process is terminated',async()=>setup(async({sessions})=>{
  const result=await sessions.run(request(),signal());
  assert.equal(result.ok,false);assert.equal(result.reason,'invalid-session-evidence');assert.equal(result.serverCleanup.ok,true);
},{mode:'wrong-hash'}));

test('malformed server framing terminates the session without accepting a result',async()=>setup(async({sessions})=>{
  const result=await sessions.run(request(),signal());
  assert.equal(result.ok,false);assert.equal(result.reason,'invalid-session-response');assert.equal(result.serverCleanup.ok,true);
},{mode:'malformed'}));

test('final cleanup failure is reported to the parent task',async()=>setup(async({sessions})=>{
  assert.equal((await sessions.run(request(),signal())).ok,true);
  assert.equal((await sessions.close()).ok,false);
},{mode:'bad-cleanup'}));

test('file changed during a query fails instead of returning stale analysis',async()=>setup(async({sessions,workspace})=>{
  const running=sessions.run(request(),signal());
  const timer=setTimeout(()=>fs.writeFileSync(path.join(workspace,'a.ts'),'changed'),80);
  try {const result=await running;assert.equal(result.ok,false);assert.equal(result.reason,'file-changed-during-probe');}finally{clearTimeout(timer);}
},{mode:'delay'}));

test('cancellation terminates a pending server and removes its snapshot',async()=>setup(async({sessions})=>{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120);
  const result=await sessions.run(request(),controller.signal);clearTimeout(timer);
  assert.equal(result.reason,'cancelled');assert.equal(result.serverCleanup.ok,true);
},{mode:'hang'}));

test('idle expiry awaits shutdown and a later request starts a new generation',async()=>setup(async({sessions,children,root})=>{
  assert.equal((await sessions.run(request(),signal())).ok,true);
  const deadline=Date.now()+5000;
  while(fs.readdirSync(root).length!==1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
  assert.deepEqual(fs.readdirSync(root),['workspace']);assert.equal(children[0].exitCode,0);
  const result=await sessions.run(request(),signal());assert.equal(result.ok,true);assert.equal(result.serverSession.generation,2);assert.equal(result.serverSession.reused,false);
},{idleMs:80}));
