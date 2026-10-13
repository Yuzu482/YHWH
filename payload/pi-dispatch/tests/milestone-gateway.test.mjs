import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {createMilestoneLedger} from '../extensions/milestone-ledger.js';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {completedContract} from '../extensions/stage-handoff.js';
import {validateSandboxPatch} from '../scripts/wsl-sandbox.mjs';
import {roleValue} from './contract-fixtures.mjs';
import {listenHttpFixture} from './http-fixture.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const parse=result=>JSON.parse(result.content.find(item=>item.type==='text').text);
const sandboxStatus={ok:true,backend:'wsl2-bwrap',hostMountVisible:false,windowsInterop:false,bubblewrap:true,pi:true,resourceLimits:true};
const semanticRisks={publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false};
const verify={commands:[{id:'test',argv:['node','--check','a.js'],cwd:'.'}]};
function packet(cwd,id,extra={}){return {cwd,requestId:id,parentRunId:'goal',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',tier:'T0',tierDeclaration:semanticRisks,task:{role:'Chesed',objective:'Change one isolated fixture behavior',acceptance:['Host syntax check passes'],readScope:['a.js'],writeScope:['a.js'],verify,milestone:{id:'change',objective:'Change fixture behavior',acceptanceCommandIds:['test']},...extra}};}
async function fixture(t,{dispatchFn,resultStatus='completed',checkUnavailable=false}={}){
  const cwd=mkdtempSync(join(tmpdir(),'milestone-gateway-')),state=join(cwd,'ledger'),records=[];
  writeFileSync(join(cwd,'a.js'),'const value = 1;\n');let calls=0;
  const dispatch=async(request,signal,task,options)=>{
    calls++;
    if(dispatchFn)return dispatchFn(request,signal,task,options);
    if(checkUnavailable)options.onProgress({hostCheckAvailability:{available:false,reason:'project-command-not-registered',commandIds:['test']}});
    const job='11111111-1111-4111-8111-111111111111';
    const patch=`--- /var/lib/pi-kether/jobs/${job}/baseline/a.js\n+++ /var/lib/pi-kether/jobs/${job}/workspace/a.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n`;
    const value=roleValue('Chesed');value.status=resultStatus;value.changedFiles=['a.js'];value.deliverable.checks=[{name:'test',outcome:'unverified',evidence:'Synthetic worker; host fixture supplies checks'}];
    const trusted=validateSandboxPatch(patch,{job,requestId:request.gatewayRequestId,access:'workspace-write',writeScope:['a.js'],fileStates:[{path:'a.js',before:true,after:true}]});
    return {ok:true,exitCode:0,modelExecutionStarted:true,cleanup:{ok:true},provider:request.provider,model:request.model,requestedProvider:request.provider,requestedModel:request.model,text:'KETHER_RESULT_JSON='+JSON.stringify(value),...trusted,patchSha256:trusted.patchValidation.patchSha256,patchBytes:Buffer.byteLength(trusted.patch),secretLikeContent:false};
  };
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[cwd],token:'fixture-token-long-enough-1234567890',sandboxStatus,requestLedgerDir:state,dispatchFn:dispatch,auditLogger:{enabled:true,record:record=>records.push(record)},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5}});
  const http=await listenHttpFixture(app),client=new Client({name:'milestone-fixture',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer fixture-token-long-enough-1234567890'}}});
  await client.connect(transport);
  t.after(async()=>{await client.close();const shutdown=await runtime.shutdown();await new Promise(resolve=>http.close(resolve));assert.equal(shutdown.disposed,true);rmSync(cwd,{recursive:true,force:true});});
  const call=async(name,args)=>parse(await client.callTool({name,arguments:args}));
  const receipt=(await call('get_workflow',{topic:'task-tiers'})).receipt;
  return {cwd,state,client,call,receipt,records,calls:()=>calls,ledger:createMilestoneLedger(join(state,'milestones'))};
}
const prior=a=>({requestId:a.requestId,checkName:a.evidence.at(-1).checkName,outputSha256:a.evidence.at(-1).outputSha256,excerpt:a.evidence.at(-1).excerpt});
const failedRef=a=>({requestId:a.requestId,ordinal:a.ordinal,checkName:a.evidence.at(-1).checkName,outputSha256:a.evidence.at(-1).outputSha256});

test('new write without milestone is rejected before model execution',async t=>{
  const f=await fixture(t),args=packet(f.cwd,'missing');delete args.task.milestone;
  const result=await f.call('dispatch_subagent',args);
  assert.equal(result.code,'PI_MILESTONE_INVALID');assert.equal(result.modelExecutionStarted,false);assert.equal(f.calls(),0);
});

test('optional check warning preserves an unverified patch for host checks and records no fake sandbox evidence',async t=>{
  const f=await fixture(t,{resultStatus:'unverified',checkUnavailable:true});
  const delivered=await f.call('dispatch_subagent',packet(f.cwd,'unavailable-check'));
  assert.equal(delivered.status,'awaiting-host-verification',JSON.stringify(delivered));
  assert.ok(delivered.warnings.some(w=>w.code==='PI_HOST_CHECK_NOT_RUNNABLE'));
  const warning=f.records.find(r=>r.code==='PI_HOST_CHECK_NOT_RUNNABLE');
  assert.equal(warning.modelExecution,false);
  assert.equal(warning.milestone,'change');
  assert.equal(f.ledger.get('unavailable-check').status,'awaiting-artifact');
  assert.equal(createRequestLedger(f.state).getAcceptanceRecord('unavailable-check').state,'not-verified');
});

test('two actual host failures block a new ID; exact diagnosis permits one continued attempt',async t=>{
  const f=await fixture(t);const failures=[];
  for(const id of ['first','second']){
    const extra=failures.length?{previousFailure:prior(failures.at(-1))}:{};
    const delivered=await f.call('dispatch_subagent',packet(f.cwd,id,extra));
    assert.equal(delivered.status,'awaiting-host-verification',JSON.stringify(delivered));
    const verified=await f.call('record_host_verification',{requestId:id,artifactSha256:delivered.hostVerification.artifactSha256,commands:[{checkName:'test',command:'node --check a.js',exitCode:1,outputSummary:`Synthetic failure ${id}`} ]});
    assert.equal(verified.state,'failed');failures.push(f.ledger.get(id));
  }
  const third=packet(f.cwd,'third',{previousFailure:prior(failures[1])});
  const rejected=await f.call('dispatch_subagent',third);
  assert.equal(rejected.code,'PI_REPEATED_FAILURE_DIAGNOSIS_REQUIRED');assert.equal(rejected.modelExecutionStarted,false);assert.equal(f.calls(),2);
  const diagnosis=await f.call('diagnose_milestone_failure',{workspace:f.cwd,parentRunId:'goal',milestoneId:'change',failures:failures.map(failedRef),rootCause:'Two synthetic syntax failures require a smaller correction',action:'reduce-scope',workflowReceipt:f.receipt});
  assert.equal(diagnosis.ok,true);
  // The rejected ID is immutable. Continue with a new, diagnosed request identity.
  const resumed=await f.call('dispatch_subagent',{...third,requestId:'diagnosed'});
  assert.equal(resumed.status,'awaiting-host-verification',JSON.stringify(resumed));assert.equal(f.calls(),3);
  const items=await f.call('get_workflow',{topic:'task-tiers',includeOpenItems:true});
  assert.ok(items.openItems.items.some(item=>item.requestId==='diagnosed'));
});

test('zero-start and uncertain outcomes remain distinct; replay never launches twice',async t=>{
  const f=await fixture(t,{dispatchFn:async()=>({ok:false,modelExecutionStarted:false,failure:'fixture-not-started',exitCode:null})});
  const args=packet(f.cwd,'zero');await f.call('dispatch_subagent',args);await f.call('dispatch_subagent',args);
  assert.equal(f.calls(),1);assert.equal(f.ledger.get('zero').strike,false);
  assert.equal(f.ledger.get('zero').status,'failed');
});

test('T2 writes cannot reuse a pre-review that did not bind the milestone',async t=>{
  const f=await fixture(t),args=packet(f.cwd,'unbound');args.workflowReceipt=f.receipt;args.tier='T2';args.tierDeclaration={...semanticRisks,publicApiOrProtocol:true};
  const handoff={version:2,stage:'pre-review',inputs:[],runGoal:'Fixture change',runAcceptance:['Syntax passes'],phaseIndex:1};
  const section={status:'provided',content:['Synthetic design plan only']};
  const preTask={role:'Geburah',objective:'Synthetic prior review',context:['KNOWN_SCOPE= a.js'],acceptance:['Review design'],reviewPacket:{version:1,stage:'pre-change',requirements:section,changes:section,context:section,verification:section},handoff};
  const preValue=roleValue('Geburah'),contract={...completedContract(preTask,{parentRunId:'goal'},f.cwd,preValue),tierPolicyVersion:1};
  const ledger=createRequestLedger(f.state);ledger.recordOutcome('pre',{ok:true,structuredResult:preValue,contract});
  args.dependsOnRequestIds=['pre'];args.task.handoff={...handoff,stage:'implementing',inputs:[{requestId:'pre',role:'Geburah',stage:'pre-review',resultSha256:contract.resultSha256}]};
  const result=await f.call('dispatch_subagent',args);
  assert.equal(result.modelExecutionStarted,false);assert.equal(f.calls(),0);
  assert.equal(result.code,'PI_MILESTONE_PRE_REVIEW_REQUIRED',JSON.stringify(result));
});

test('real Git apply and real host syntax check produce one isolated T0 acceptance',async t=>{
  const f=await fixture(t);execFileSync('git',['init','--quiet',f.cwd],{windowsHide:true});
  const delivery=await f.call('dispatch_subagent',packet(f.cwd,'complete'));
  assert.equal(delivery.status,'awaiting-host-verification',JSON.stringify(delivery));
  assert.equal(f.ledger.get('complete').status,'awaiting-artifact');
  const applied=await f.call('apply_artifact',{requestId:'complete'});
  assert.equal(applied.ok,true,JSON.stringify(applied));assert.deepEqual(applied.changedFiles,['a.js']);
  assert.equal(readFileSync(join(f.cwd,'a.js'),'utf8'),'const value = 2;\n');
  const output=execFileSync(process.execPath,['--check','a.js'],{cwd:f.cwd,encoding:'utf8',windowsHide:true});
  const evidence={requestId:'complete',artifactSha256:delivery.hostVerification.artifactSha256,commands:[{checkName:'test',command:`${process.execPath} --check a.js`,exitCode:0,outputSummary:output||'Node syntax check exited 0; stdout empty'}]};
  const verified=await f.call('record_host_verification',evidence);
  assert.equal(verified.state,'completed',JSON.stringify(verified));assert.equal(f.ledger.get('complete').status,'accepted');
  assert.equal(createRequestLedger(f.state).getAcceptanceRecord('complete').state,'accepted');
  assert.equal((await f.call('record_host_verification',evidence)).recordSha256,verified.recordSha256);
  assert.equal(f.records.filter(record=>record.operation==='task_accepted').length,1);
  const open=await f.call('get_workflow',{topic:'task-tiers',includeOpenItems:true});
  assert.equal(open.openItems.items.length,0);assert.equal(open.openItems.legacyItems.length,0);
});

test('abandonment closes only the exact artifact; immutable result replay remains readable',async t=>{
  const f=await fixture(t),args=packet(f.cwd,'abandon');
  const delivery=await f.call('dispatch_subagent',args),artifactSha256=delivery.hostVerification.artifactSha256;
  const closed=await f.call('abandon_artifact',{requestId:'abandon',artifactSha256,reason:'Retired synthetic fixture',workflowReceipt:f.receipt});
  assert.equal(closed.status,'abandoned');
  assert.equal((await f.call('abandon_artifact',{requestId:'abandon',artifactSha256,reason:'Retired synthetic fixture',workflowReceipt:f.receipt})).status,'abandoned');
  assert.equal((await f.call('apply_artifact',{requestId:'abandon'})).code,'PI_MILESTONE_CLOSED');
  const replay=await f.call('dispatch_subagent',args);assert.equal(replay.idempotency.status,'replayed');assert.equal(f.calls(),1);
  const open=await f.call('get_workflow',{topic:'task-tiers',includeOpenItems:true});assert.equal(open.openItems.items.length,0);
});

test('unknown execution blocks continuation and preserves the original identity across replay',async t=>{
  const f=await fixture(t,{dispatchFn:async()=>({ok:false,failure:'fixture-unknown',exitCode:null})});
  const args=packet(f.cwd,'uncertain');await f.call('dispatch_subagent',args);
  assert.equal(f.ledger.get('uncertain').status,'in_doubt');assert.equal(f.ledger.get('uncertain').strike,false);
  const blocked=await f.call('dispatch_subagent',packet(f.cwd,'replacement'));
  assert.equal(blocked.code,'PI_MILESTONE_RECONCILIATION_NEEDED');assert.equal(f.calls(),1);
  await f.call('dispatch_subagent',args);assert.equal(f.calls(),1);
});
