import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {completedContract,runAnchor} from '../extensions/stage-handoff.js';
import {compileWriteScope} from '../extensions/write-scope-guard.js';
import {roleValue} from './contract-fixtures.mjs';
import {listenHttpFixture} from './http-fixture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const token='tier-flow-synthetic-token-0123456789abcdef';
const sandbox={ok:true,backend:'wsl2-bwrap',hostMountVisible:false,windowsInterop:false,bubblewrap:true,pi:true,resourceLimits:true};
const goal='Generic T2 fixture';
const acceptance=['Observed fixture'];
const parentRunId='tier-flow-parent';
const flags={publicApiOrProtocol:true,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false};
const hash=value=>createHash('sha256').update(value).digest('hex');
const parsed=result=>JSON.parse(result.content[0].text);

test('durable T1 host verification completes source contract before one default-medium post-review and acceptance',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tier-t1-review-flow-'));
  const ledger=createRequestLedger(directory);
  const records=[];
  const goal='T1 fixture objective';
  const runAcceptance=['T1 fixture acceptance'];
  const checkName='reviewer effort regression suite';
  const patch='--- /var/lib/pi-kether/jobs/22222222-2222-4222-8222-222222222222/baseline/package.json\n+++ /var/lib/pi-kether/jobs/22222222-2222-4222-8222-222222222222/workspace/package.json\n@@ -0,0 +1 @@\n+synthetic fixture\n';
  const scopeSha256=hash(compileWriteScope(['package.json']).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n'));
  const requests=[];
  const dispatchFn=async(request,_signal,task)=>{
    requests.push({request,task});
    const value=roleValue(task.role,task.objective);
    if(task.role==='Chesed'){
      value.changedFiles=['package.json'];
      value.deliverable.checks=[{name:checkName,outcome:'unverified',evidence:'Host 检查未执行；host 负责运行此 test command。'}];
      return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation:{ok:true,requestId:request.gatewayRequestId,jobId:'22222222-2222-4222-8222-222222222222',changedFiles:['package.json'],patchSha256:hash(patch),scopeSha256}};
    }
    return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  };
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,dispatchFn,sandboxStatus:sandbox,requestLedgerDir:directory,auditLogger:{enabled:true,record:value=>records.push(value)},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5}});
  const http=await listenHttpFixture(app);
  const client=new Client({name:'tier-t1-review-flow-test',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  try{
    await client.connect(transport);
    const receipt=parsed(await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).receipt;
    const source=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId:'tier-t1-review-parent',requestId:'tier-t1-source',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',workflowReceipt:receipt,tier:'T1',tierDeclaration:{...flags,publicApiOrProtocol:false},task:{contractVersion:2,role:'Chesed',objective:goal,acceptance:runAcceptance,readScope:['package.json'],writeScope:['package.json']}}}));
    assert.equal(source.status,'awaiting-host-verification',JSON.stringify(source));
    assert.equal(source.ok,false);
    assert.deepEqual(source.hostVerification.requiredCheckNames,[checkName]);
    assert.equal(ledger.getOutcome('tier-t1-source').state,'awaiting-host-verification');
    const recorded=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'tier-t1-source',artifactSha256:source.hostVerification.artifactSha256,workflowReceipt:receipt,commands:[{checkName,command:'synthetic fixture host check (not executed)',exitCode:0,outputSummary:'Synthetic fixture evidence only; no host command was executed.'}]}}));
    assert.equal(recorded.state,'completed');
    const completed=ledger.getEffectiveResult('tier-t1-source');
    assert.equal(completed.state,'completed');
    assert.equal(completed.contract.role,'Chesed');
    assert.equal(completed.contract.tier,'T1');
    assert.equal(completed.verificationSource,'host');
    const reviewPacket={version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(key=>[key,{status:'provided',content:[`Synthetic review ${key}`]}]))};
    const reviewArgs={cwd:root,parentRunId:'tier-t1-review-parent',reviewOfRequestId:'tier-t1-source',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',workflowReceipt:receipt,tier:'T1',task:{contractVersion:2,role:'Geburah',objective:goal,acceptance:runAcceptance,reviewPacket}};
    const missing=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...reviewArgs,requestId:'tier-t1-missing'}}));
    assert.equal(missing.ok,false,JSON.stringify(missing));
    assert.equal(missing.code,'REVIEW_MATERIALS_MISSING');
    assert.equal(requests.filter(item=>item.task.role==='Geburah').length,0);
    reviewPacket.changes.content=[`--- /var/lib/pi-kether/jobs/22222222-2222-4222-8222-222222222222/baseline/package.json\n+++ /var/lib/pi-kether/jobs/22222222-2222-4222-8222-222222222222/workspace/package.json\n@@ -0,0 +1 @@\n+synthetic fixture\n`];
    const review=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...reviewArgs,requestId:'tier-t1-post-review'}}));
    assert.equal(review.ok,true,JSON.stringify(review));
    assert.equal(requests.filter(item=>item.task.role==='Geburah').length,1);
    assert.equal(requests.find(item=>item.task.role==='Geburah').request.thinking,'medium');
    assert.equal(review.reviewValidation.approved,true);
    const accepted=records.find(record=>record.operation==='task_accepted');
    assert.ok(accepted);
    assert.equal(accepted.requestId,'tier-t1-source');
    assert.equal(accepted.verification?.source,'host');
    assert.equal(accepted.verification?.artifactSha256,source.hostVerification.artifactSha256);
    assert.equal(accepted.verification?.recordSha256,recorded.recordSha256);
  }finally{
    await client.close();
    await new Promise(resolvePromise=>http.close(resolvePromise));
    await runtime.shutdown?.();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('known-scope T2 pre-review proceeds directly through host verification to one post-review',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tier-t2-direct-host-'));
  const ledger=createRequestLedger(directory);
  const records=[];
  const calls=[];
  const accepted=[];
  const checkName='synthetic host check (not executed)';
  const patch='--- /var/lib/pi-kether/jobs/33333333-3333-4333-8333-333333333333/baseline/package.json\n+++ /var/lib/pi-kether/jobs/33333333-3333-4333-8333-333333333333/workspace/package.json\n@@ -0,0 +1 @@\n+synthetic fixture\n';
  const scopeSha256=hash(compileWriteScope(['package.json']).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n'));
  const dispatchFn=async(request,_signal,task)=>{
    calls.push({request,task});
    const value=roleValue(task.role,task.objective);
    if(task.role==='Chesed'){
      value.changedFiles=['package.json'];
      value.deliverable.checks=[{name:checkName,outcome:'unverified',evidence:'Host check pending.',executionLimitation:{executor:'host',reason:'worker-execution-unavailable'}}];
      return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation:{ok:true,requestId:request.gatewayRequestId,jobId:'33333333-3333-4333-8333-333333333333',changedFiles:['package.json'],patchSha256:hash(patch),scopeSha256}};
    }
    if(task.role==='Geburah'&&task.reviewPacket?.stage==='post-change') accepted.push(request.gatewayRequestId);
    return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},modelExecutionStarted:true,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  };
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,dispatchFn,sandboxStatus:sandbox,requestLedgerDir:directory,auditLogger:{enabled:true,record:value=>records.push(value)},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5}});
  const http=await listenHttpFixture(app);
  const client=new Client({name:'tier-t2-direct-host-test',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  try{
    await client.connect(transport);
    const receipt=parsed(await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).receipt;
    const task=(role,stage,inputs,extra={})=>({contractVersion:2,role,objective:goal,acceptance,readScope:role==='Geburah'?[]:['package.json'],writeScope:role==='Chesed'?['package.json']:[],handoff:{version:2,stage,inputs,runGoal:goal,runAcceptance:acceptance,phaseIndex:1},...extra});
    const preTask=task('Geburah','pre-review',[],{context:['KNOWN_SCOPE= package.json only; primary supplied bounded plan.'],reviewPacket:{version:1,stage:'pre-change',requirements:{status:'provided',content:['Plan requirement']},changes:{status:'provided',content:['primary plan: change package.json fixture']},context:{status:'provided',content:['KNOWN_SCOPE= package.json only']},verification:{status:'provided',content:['Verify package fixture']}}});
    const pre=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId,requestId:'direct-t2-pre',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',workflowReceipt:receipt,tier:'T2',tierDeclaration:flags,task:preTask}}));
    assert.equal(pre.ok,true,JSON.stringify(pre));
    const preOutcome=ledger.getOutcome('direct-t2-pre');
    const preRef={requestId:'direct-t2-pre',role:'Geburah',stage:'pre-review',resultSha256:preOutcome.contract.resultSha256};
    const implTask=task('Chesed','implementing',[preRef]);
    const implArgs={cwd:root,parentRunId,requestId:'direct-t2-impl',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',workflowReceipt:receipt,dependsOnRequestIds:['direct-t2-pre'],tier:'T2',tierDeclaration:flags,task:implTask};
    const impl=parsed(await client.callTool({name:'dispatch_subagent',arguments:implArgs}));
    assert.equal(impl.status,'awaiting-host-verification',JSON.stringify(impl));
    const implOutcome=ledger.getOutcome('direct-t2-impl');
    const implRef={requestId:'direct-t2-impl',role:'Chesed',stage:'implementing',resultSha256:ledger.getHostArtifact('direct-t2-impl').contractTemplate.resultSha256};
    const reviewPacket={version:1,stage:'post-change',requirements:{status:'provided',content:['T2 objective']},changes:{status:'provided',content:[patch]},context:{status:'provided',content:['Synthetic direct host flow']},verification:{status:'provided',content:['Synthetic host record; command was not run']}};
    const postTask=task('Geburah','post-review',[preRef,implRef],{reviewPacket});
    const postArgs={cwd:root,parentRunId,requestId:'direct-t2-post',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',workflowReceipt:receipt,dependsOnRequestIds:['direct-t2-pre','direct-t2-impl'],task:postTask};
    const beforeHost=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...postArgs,requestId:'direct-t2-before-host'}}));
    assert.equal(beforeHost.ok,false);
    assert.equal(beforeHost.code,'PI_T2_REVIEW_REFERENCE_REQUIRED');
    assert.equal(calls.filter(item=>item.task.role==='Geburah'&&item.task.reviewPacket?.stage==='post-change').length,0);
    const aliasBeforeHost=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...postArgs,requestId:'direct-t2-alias-before-host',task:{...postTask,role:' reviewer '}}}));
    assert.equal(aliasBeforeHost.ok,false);
    assert.equal(aliasBeforeHost.code,'PI_T2_REVIEW_REFERENCE_REQUIRED');
    assert.equal(calls.filter(item=>item.task.role==='Geburah'&&item.task.reviewPacket?.stage==='post-change').length,0);
    const failedImpl=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...implArgs,requestId:'direct-t2-failed-impl'}}));
    assert.equal(failedImpl.status,'awaiting-host-verification',JSON.stringify(failedImpl));
    const failedHost=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'direct-t2-failed-impl',artifactSha256:failedImpl.hostVerification.artifactSha256,workflowReceipt:receipt,commands:[{checkName,command:'synthetic failing fixture; not executed',exitCode:1,outputSummary:'Synthetic rejection fixture; no host command was executed.'}]}}));
    assert.equal(failedHost.state,'failed');
    assert.equal(ledger.getOutcome('direct-t2-failed-impl').state,'failed');
    assert.equal(accepted.length,0);
    const wrongArtifact=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'direct-t2-impl',artifactSha256:'f'.repeat(64),workflowReceipt:receipt,commands:[{checkName,command:'synthetic fixture; not executed',exitCode:0,outputSummary:'Synthetic mismatched-artifact fixture only.'}]}}));
    assert.equal(wrongArtifact.ok,false);
    assert.equal(ledger.getOutcome('direct-t2-impl').state,'awaiting-host-verification');
    const recorded=parsed(await client.callTool({name:'record_host_verification',arguments:{requestId:'direct-t2-impl',artifactSha256:impl.hostVerification.artifactSha256,workflowReceipt:receipt,commands:[{checkName,command:'synthetic fixture; not executed',exitCode:0,outputSummary:'Synthetic fixture record only; no host command was executed.'}]}}));
    assert.equal(recorded.state,'completed');
    const completedImpl=ledger.getEffectiveResult('direct-t2-impl');
    const completedImplRef={requestId:'direct-t2-impl',role:'Chesed',stage:'implementing',resultSha256:completedImpl.contract.resultSha256};
    postTask.handoff.inputs=[preRef,completedImplRef];
    const wrongTask={...postTask,handoff:{...postTask.handoff,inputs:[preRef,{...completedImplRef,resultSha256:'f'.repeat(64)}]}};
    const wrong=parsed(await client.callTool({name:'dispatch_subagent',arguments:{...postArgs,requestId:'direct-t2-wrong-digest',task:wrongTask}}));
    assert.equal(wrong.ok,false);
    assert.equal(calls.filter(item=>item.task.role==='Geburah'&&item.task.reviewPacket?.stage==='post-change').length,0);
    const post=parsed(await client.callTool({name:'dispatch_subagent',arguments:postArgs}));
    assert.equal(post.ok,true,JSON.stringify(post));
    assert.equal(calls.filter(item=>item.task.role==='Geburah'&&item.task.reviewPacket?.stage==='post-change').length,1);
    assert.equal(accepted.length,1);
    const audit=records.find(record=>record.operation==='task_accepted');
    assert.ok(audit);
    assert.equal(audit.requestId,'direct-t2-impl');
    assert.equal(audit.verification?.source,'host');
    assert.equal(audit.verification?.artifactSha256,impl.hostVerification.artifactSha256);
    assert.equal(audit.verification?.recordSha256,recorded.recordSha256);
    const replay=parsed(await client.callTool({name:'dispatch_subagent',arguments:postArgs}));
    assert.equal(replay.idempotency.status,'replayed');
    assert.equal(accepted.length,1);
  }finally{
    await client.close();
    await new Promise(resolvePromise=>http.close(resolvePromise));
    await runtime.shutdown?.();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('completed T2 source falls back to ledger outcome through Netzach and one final review',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'tier-flow-'));
  const ledger=createRequestLedger(directory);
  const preTask={role:'Geburah',objective:'Synthetic predecessor',acceptance:['Fixture'],reviewPacket:{version:1,stage:'pre-change',requirements:{status:'provided',content:['Fixture']},changes:{status:'provided',content:['Fixture']},context:{status:'provided',content:['Fixture']},verification:{status:'provided',content:['Fixture']}},handoff:{version:2,stage:'pre-review',inputs:[{requestId:'planned',role:'Chochmah',stage:'planned',resultSha256:'a'.repeat(64)}],runGoal:goal,runAcceptance:acceptance,phaseIndex:1}};
  const pre=roleValue('Geburah');
  ledger.recordOutcome('pre-flow',{ok:true,contract:{...completedContract(preTask,{parentRunId},root,pre),tierPolicyVersion:1},structuredResult:pre});
  const preOutcome=ledger.getOutcome('pre-flow');
  const preRef={requestId:'pre-flow',role:'Geburah',stage:'pre-review',resultSha256:preOutcome.contract.resultSha256};
  const records=[];
  const patch='--- /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/baseline/package.json\n+++ /var/lib/pi-kether/jobs/11111111-1111-4111-8111-111111111111/workspace/package.json\n@@ -0,0 +1 @@\n+fixture\n';
  const scopeSha256=hash(compileWriteScope(['package.json']).map(item=>`${item.tree?'tree':'file'}:${item.path}`).sort().join('\\n'));
  const accepted=[];
  const dispatchFn=async(request,_signal,task,options)=>{
    const value=roleValue(task.role,task.objective);
    if(task.role==='Chesed'){
      value.changedFiles=['package.json'];
      return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},phaseTimings:{stream:{textDeltas:1}},text:'KETHER_RESULT_JSON='+JSON.stringify(value),patch,patchValidation:{ok:true,requestId:request.gatewayRequestId,jobId:'11111111-1111-4111-8111-111111111111',changedFiles:['package.json'],patchSha256:hash(patch),scopeSha256}};
    }
    if(task.role==='Geburah'&&task.reviewPacket?.stage==='post-change') accepted.push({requestId:request.gatewayRequestId,task,upstream:options.upstreamResults});
    if(task.role==='Geburah') options.onModelStart?.();
    return {ok:true,requestedProvider:request.provider,requestedModel:request.model,provider:request.provider,model:request.model,exitCode:0,cleanup:{ok:true},phaseTimings:{stream:{textDeltas:1}},modelExecutionStarted:true,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  };
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,dispatchFn,sandboxStatus:sandbox,requestLedgerDir:directory,auditLogger:{enabled:true,record:value=>records.push(value)},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5}});
  const http=await listenHttpFixture(app);
  const client=new Client({name:'tier-flow-test',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
  try{
    await client.connect(transport);
    const receipt=parsed(await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).receipt;
    const task=(role,stage,inputs,extra={})=>({contractVersion:2,role,objective:goal,acceptance,readScope:role==='Geburah'?[]:['package.json'],writeScope:role==='Chesed'?['package.json']:[],handoff:{version:2,stage,inputs,runGoal:goal,runAcceptance:acceptance,phaseIndex:1},...extra});
    const writeArgs={cwd:root,parentRunId,requestId:'flow-write',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',workflowReceipt:receipt,dependsOnRequestIds:['pre-flow'],tier:'T2',tierDeclaration:flags,task:task('Chesed','implementing',[preRef])};
    const write=parsed(await client.callTool({name:'dispatch_subagent',arguments:writeArgs}));
    assert.equal(write.ok,true,JSON.stringify(write));
    assert.equal(write.contract.artifactSha256,hash(patch));
    const completed=ledger.getOutcome('flow-write');
    assert.equal(completed.state,'completed');
    assert.equal(completed.contract.artifactSha256,hash(patch));
    const chesedRef={requestId:'flow-write',role:'Chesed',stage:'implementing',resultSha256:completed.contract.resultSha256};
    const sourceContractSha=completed.contract.resultSha256;
    const netTask=task('Netzach','verifying',[chesedRef]);
    const net=parsed(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,parentRunId,requestId:'flow-netzach',provider:'openai-codex',model:'gpt-6-luna',access:'read',workflowReceipt:receipt,dependsOnRequestIds:['flow-write'],task:netTask}}));
    assert.equal(net.ok,true,JSON.stringify(net));
    const netRef={requestId:'flow-netzach',role:'Netzach',stage:'verifying',resultSha256:net.contract.resultSha256};
    const reviewPacket={version:1,stage:'post-change',requirements:{status:'provided',content:['Review acceptance']},changes:{status:'provided',content:['Review changed patch']},context:{status:'provided',content:['Review context']},verification:{status:'provided',content:['Review verification']}};
    const postTask=task('Geburah','post-review',[chesedRef,netRef],{reviewPacket});
    const postArgs={cwd:root,parentRunId,requestId:'flow-post',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',thinking:'medium',workflowReceipt:receipt,dependsOnRequestIds:['flow-write','flow-netzach'],tier:'T2',task:postTask};
    const wrong={...postArgs,requestId:'flow-post-wrong',task:{...postTask,handoff:{...postTask.handoff,inputs:[{...chesedRef,resultSha256:'f'.repeat(64)},netRef]}}};
    const denied=parsed(await client.callTool({name:'dispatch_subagent',arguments:wrong}));
    assert.equal(denied.ok,false,JSON.stringify(denied));
    assert.equal(accepted.length,0);
    const post=parsed(await client.callTool({name:'dispatch_subagent',arguments:postArgs}));
    assert.equal(post.ok,true,JSON.stringify(post));
    assert.equal(accepted.length,1);
    const audit=records.find(record=>record.operation==='task_accepted');
    assert.ok(audit);
    assert.equal(audit.requestId,'flow-write');
    assert.equal(audit.verification?.source,'netzach');
    assert.equal(audit.verification?.artifactSha256,hash(patch));
    assert.equal(audit.runAnchorSha256,runAnchor(postTask.handoff));
    assert.equal(audit.verification?.recordSha256,net.contract.resultSha256);
    const replay=parsed(await client.callTool({name:'dispatch_subagent',arguments:postArgs}));
    assert.equal(replay.idempotency.status,'replayed');
    assert.equal(accepted.length,1);
    assert.equal(ledger.getOutcome('flow-write').contract.resultSha256,sourceContractSha);
  }finally{
    await client.close();
    await new Promise(resolvePromise=>http.close(resolvePromise));
    await runtime.shutdown?.();
    rmSync(directory,{recursive:true,force:true});
  }
});
