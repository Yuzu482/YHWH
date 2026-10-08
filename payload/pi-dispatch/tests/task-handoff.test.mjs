import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectTaskHandoff} from '../extensions/task-handoff.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture({tier='T0',accepted=false}={}){
  const artifactSha256='a'.repeat(64),proof='b'.repeat(64),requestId='candidate-1',anchor='c'.repeat(64),workspace='/synthetic/workspace';
  const template={role:'Chesed',stage:'implementing',tier,mode:'linked',parentRunId:'parent-1',workspaceSha256:sha(workspace),runAnchorSha256:anchor,tierPolicyVersion:1,phaseIndex:1};
  const pending={requestId,artifactSha256,workspace,parentRunId:'parent-1',requiredCheckNames:['host-focused']};
  const input={parentRunId:pending.parentRunId,workspaceSha256:sha(workspace),anchor,artifactSha256,recordSha256:proof,tier};
  const acceptanceId=`acceptance-${sha(`${requestId}\n${anchor}\ntask_accepted`)}`;
  const ledger={getHostArtifact:id=>id===requestId?{pending,contractTemplate:template}:null,getEffectiveResult:()=>({state:'completed',verificationSource:'host',verifiedArtifactSha256:artifactSha256,verificationRecordSha256:proof}),getOutcome:()=>({state:'completed'}),getExecutionRecord:(id,operation,actual)=>accepted&&id===acceptanceId&&operation==='task_accepted'&&JSON.stringify(actual)===JSON.stringify(input)?{state:'completed',result:{ok:true,acceptedAt:'2026-01-01T00:00:00.000Z'}}:{state:'missing'}};
  return {ledger,requestId,artifactSha256};
}

test('T0 is accepted only with candidate-bound durable acceptance receipt; missing receipt is explicit',()=>{
  const missing=fixture();const a=projectTaskHandoff(missing);assert.equal(a.state,'acceptance-missing');assert.equal(a.finalAccepted,false);assert.deepEqual(a.requiredCheckNames,['host-focused']);
  const valid=projectTaskHandoff(fixture({accepted:true}));assert.equal(valid.state,'accepted');assert.equal(valid.finalAccepted,true);assert.equal(valid.acceptedAt,'2026-01-01T00:00:00.000Z');
});

test('source manifest, installer and gateway consistently allowlist read-only handoff tools',()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const manifest=JSON.parse(readFileSync(join(root,'.mcp.json'),'utf8'));const enabled=manifest.mcpServers['pi-kether-gateway'].enabled_tools;
  const installer=readFileSync(resolve(root,'../../install/Install-PiKether.ps1'),'utf8');const gateway=readFileSync(join(root,'scripts/gateway.mjs'),'utf8');
  for(const name of ['wait_subagent','get_task_handoff','wait_task_handoff']){assert.ok(enabled.includes(name),name);assert.ok(installer.includes(`'${name}'`),name);assert.ok(gateway.includes(`server.registerTool('${name}'`),name);}
});

test('mismatched candidate, unsupported evidence and damaged receipt are never accepted',()=>{
  const f=fixture({accepted:true});assert.equal(projectTaskHandoff({...f,artifactSha256:'d'.repeat(64)}).state,'unknown');
  const damaged={...f,ledger:{...f.ledger,getExecutionRecord:()=>({state:'damaged'})}};const result=projectTaskHandoff(damaged);assert.equal(result.finalAccepted,false);assert.equal(result.state,'unknown');assert.equal(result.acceptanceState,'damaged');
  assert.equal(projectTaskHandoff({ledger:{getHostArtifact:()=>null},requestId:'missing'}).state,'unknown');
});

test('post-review tiers remain unaccepted until an exact durable receipt exists',()=>{
  for(const tier of ['T1','T2']){
    const f=fixture({tier});
    const pending=projectTaskHandoff(f);assert.equal(pending.state,'post-review-required');assert.equal(pending.finalAccepted,false);
    const accepted=projectTaskHandoff(fixture({tier,accepted:true}));assert.equal(accepted.state,'accepted');assert.equal(accepted.finalAccepted,true);
  }
});

test('acceptance receipt lookup binds operation, candidate proof, parent, anchor and acceptedAt',()=>{
  const f=fixture({accepted:true});
  assert.equal(projectTaskHandoff(f).finalAccepted,true);
  const missing={...f,ledger:{...f.ledger,getExecutionRecord:()=>({state:'missing'})}};
  assert.equal(projectTaskHandoff(missing).state,'acceptance-missing');
  const inDoubt={...f,ledger:{...f.ledger,getExecutionRecord:()=>({state:'in-doubt'})}};
  assert.equal(projectTaskHandoff(inDoubt).state,'acceptance-in-doubt');
  for(const acceptedAt of ['not-a-date','2026-01-01T00:00:00Z']){
    const invalid={...f,ledger:{...f.ledger,getExecutionRecord:(id,operation,input)=>({state:'completed',result:{ok:true,acceptedAt}})}};
    assert.equal(projectTaskHandoff(invalid).finalAccepted,false);
    assert.equal(projectTaskHandoff(invalid).state,'unknown');
  }
  for(const field of ['parentRunId','anchor','recordSha256']){
    const changed={...f,ledger:{...f.ledger,getHostArtifact:id=>{
      const artifact=f.ledger.getHostArtifact(id);
      if(field==='parentRunId') artifact.pending.parentRunId='other-parent';
      if(field==='anchor') artifact.contractTemplate.runAnchorSha256='e'.repeat(64);
      if(field==='recordSha256') artifact.pending.artifactSha256='f'.repeat(64);
      return artifact;
    }}};
    assert.notEqual(projectTaskHandoff(changed).finalAccepted,true,`${field} mutation cannot retain acceptance`);
  }
});

test('projection revision is stable across restart and excludes acceptedAt',()=>{
  const first=projectTaskHandoff(fixture({accepted:true}));
  const restarted=projectTaskHandoff(fixture({accepted:true}));
  assert.equal(first.revision,restarted.revision);
  assert.equal(first.acceptedAt,'2026-01-01T00:00:00.000Z');
});

function waitFixture({onArtifactRead}={}){
  let phase='running',outcome={state:'pending'},observer;
  const ledger={enabled:true,getHostArtifact:id=>{onArtifactRead?.();return null;},getOutcome:()=>outcome,subscribe:callback=>{observer=callback;return()=>{observer=null;};}};
  const taskMonitor={get:()=>({requestId:'wait-candidate',role:'Chesed',state:phase}),list:()=>[],size:0};
  const app=createGatewayApp({host:'127.0.0.1',token:'t'.repeat(32),roots:[],requestLedger:ledger,taskMonitor,dispatchFn:async()=>{throw new Error('dispatch must not run');}});
  const server=app.runtime.makeServer();
  const handler=server._registeredTools.wait_task_handoff.handler;
  return {handler,server,app,ledger,setCompleted(){phase='completed';outcome={state:'failed'};},getState:()=>phase,notify(){observer?.('wait-candidate');},isSubscribed:()=>observer!==null};
}
const waitValue=result=>JSON.parse(result.content[0].text);
const waitArgs={requestId:'wait-candidate',timeoutMs:1000};
const closeWaitFixture=async f=>{await f.app.runtime.shutdown({graceMs:0,abortWaitMs:0});await f.server.close();};

test('wait-timeout',async()=>{
  const f=waitFixture();const keepAlive=setTimeout(()=>{},1000);
  try{const value=waitValue(await f.handler({...waitArgs,timeoutMs:25},{}));assert.equal(value.waitTimedOut,true);assert.equal(value.state,'wait-worker');assert.equal(f.getState(),'running');}
  finally{clearTimeout(keepAlive);await closeWaitFixture(f);}
});

test('wait-abort',async()=>{
  const f=waitFixture(),controller=new AbortController();
  try{const pending=f.handler(waitArgs,{signal:controller.signal});controller.abort();const value=waitValue(await pending);assert.equal(value.ok,false);assert.equal(value.code,'ABORTED');assert.equal(f.isSubscribed(),true);}
  finally{await closeWaitFixture(f);}
});

test('wait-already-aborted',async()=>{
  const f=waitFixture(),controller=new AbortController();controller.abort();
  try{const value=waitValue(await f.handler(waitArgs,{signal:controller.signal}));assert.equal(value.ok,false);assert.equal(value.code,'ABORTED');}
  finally{await closeWaitFixture(f);}
});

test('wait-close',async()=>{
  const f=waitFixture();
  try{const pending=f.handler(waitArgs,{});await Promise.resolve();const closing=closeWaitFixture(f);const value=waitValue(await pending);assert.equal(value.ok,false);assert.equal(value.code,'GATEWAY_CLOSED');await closing;assert.equal(f.isSubscribed(),false);}
  finally{await closeWaitFixture(f);}
});

test('wait-capacity-reuse',async()=>{
  const f=waitFixture(),pending=[],controller=new AbortController();
  try{for(let i=0;i<128;i++)pending.push(f.handler({...waitArgs,requestId:`wait-${i}`},i===0?{signal:controller.signal}:{}));
    const rejected=waitValue(await f.handler({...waitArgs,requestId:'wait-overflow'},{}));assert.equal(rejected.code,'HANDOFF_WAITER_LIMIT');
    controller.abort();assert.equal(waitValue(await pending.shift()).code,'ABORTED');
    const replacement=f.handler({...waitArgs,requestId:'wait-reuse'},{});pending.push(replacement);
    await f.app.runtime.shutdown({graceMs:0,abortWaitMs:0});
    const settled=await Promise.all(pending);assert.equal(settled.length,128);assert.ok(settled.every(item=>waitValue(item).code==='GATEWAY_CLOSED'));
  }finally{await closeWaitFixture(f);}
});

test('wait-race-recheck',async()=>{
  let reads=0;const f=waitFixture({onArtifactRead(){if(++reads===2)f.setCompleted();}});
  try{const value=waitValue(await f.handler(waitArgs,{}));assert.equal(value.state,'repair-required');assert.equal(value.finalAccepted,false);assert.equal(reads,2);}
  finally{await closeWaitFixture(f);}
});

test('wait-event-wakeup',async()=>{
  const f=waitFixture();
  try{const pending=f.handler(waitArgs,{});await Promise.resolve();f.setCompleted();f.notify();const value=waitValue(await pending);assert.equal(value.state,'repair-required');assert.equal(value.finalAccepted,false);}
  finally{await closeWaitFixture(f);}
});

test('ledger-observer-capacity',async()=>{
  const root=mkdtempSync(join(tmpdir(),'task-handoff-ledger-'));
  try{const ledger=createRequestLedger(root),calls=Array.from({length:129},()=>0),unsubscribers=calls.map((_,i)=>ledger.subscribe(()=>{calls[i]++;if(i===0)throw new Error('observer failure');}));
    const execute= id=>ledger.execute({requestId:id,operation:'synthetic',input:{}},()=>({ok:true}));
    await execute('observer-operation-1');assert.equal(calls.filter(Boolean).length,128);assert.equal(calls[128],0);
    unsubscribers[0]();unsubscribers[0]();const fresh=ledger.subscribe(()=>{calls[128]++;});
    await execute('observer-operation-2');assert.equal(calls[128],1);assert.equal(calls[1],2);
    ledger.close();await execute('observer-operation-3');assert.equal(calls[1],2);assert.equal(calls[128],1);fresh();
  }finally{rmSync(root,{recursive:true,force:true});}
});
