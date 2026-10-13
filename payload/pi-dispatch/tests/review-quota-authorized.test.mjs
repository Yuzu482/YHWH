import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import * as policy from '../scripts/tier-review-policy.mjs';
import {createGatewayRuntime, loadGatewayOptions} from '../scripts/gateway.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const identity = {workspaceSha256:'a'.repeat(64), runAnchorSha256:'b'.repeat(64), tier:'T2'};
const parent = 'synthetic-parent';
const grant = () => ({id:'synthetic-grant', authorizationReference:'synthetic-host-approval', ...identity,
  parentRunId:parent, phaseIndex:2, totalCap:6, stageCap:3});
// These public pins are exercised only to test the deliberately narrow production tuple.
const pinned = {workspaceSha256:'3149a065938db19874bfdbcce8d6de2ca9c27645fa38f353cbd5c8245691d149',
  runAnchorSha256:'b991be558d49d9847f0eb12560d2cd2f1873b1f69146678a9e13b06d1286b062', tier:'T2'};
const pinnedParent = 'infalsus-card-lab-20261012';
const approval = 'user-approval:quota14:4ae04ff18684e8ceab91d19b96296c43dc6e6bb64338ab2fc0ee7551249495d1';
const pinnedGrant = (totalCap=14, stageCap=10) => ({id:'infalsus-card-lab-phase2-20261012', authorizationReference:approval,
  ...pinned, parentRunId:pinnedParent, phaseIndex:2, totalCap, stageCap});
const approve = {reviewDecision:'approve', findings:[], missingMaterials:[]};
const failure = path => ({reviewDecision:'request-changes', findings:[{severity:'high', blocking:true,
  description:`Synthetic correction required in ${path}`, evidence:path}], missingMaterials:[]});
const input = (id, stage='post-review', phaseIndex=2, extra={}) => ({...identity, requestId:id, parentRunId:parent,
  tier:'T2', stage, phaseIndex, timeoutSeconds:120, materialDigest:sha(id+':material'),
  ...(stage==='post-review'?{artifactDigest:sha(id+':artifact'), hostRecordDigest:sha(id+':host')}:{}), ...extra});
const pinInput = (id, stage='post-review', phase=2, extra={}) => input(id,stage,phase,{...pinned,parentRunId:pinnedParent,...extra});
function finish(ledger, ticket, decision=approve, executionMs=1000) {
  ledger.markStarted(ticket); ledger.finish(ticket,{started:true,outcome:'complete',executionMs});
  if (decision) ledger.recordDecision(ticket,decision);
}
function baseFour(ledger, make=input) {
  for (const stage of ['pre-review','post-review']) for (let n=0;n<2;n++) finish(ledger,ledger.reserve(make(`${stage}-${n}`,stage,1)));
}
function withLedger(run, grants=[grant()], implementation=policy) {
  const dir=mkdtempSync(join(tmpdir(),'quota-public-'));
  try {return run(dir,implementation.createReviewAttemptLedger(dir,{reviewQuotaExceptions:grants}));}
  finally {rmSync(dir,{recursive:true,force:true});}
}
const limit = error => error.code==='PI_REVIEW_LIMIT_EXCEEDED';
const invalid = error => error.code==='PI_REVIEW_ATTEMPTS_INVALID';

test('host grants are copied, frozen, strictly scoped; defaults and stage validation remain intact',()=>{
  const supplied=grant(), grants=policy.validateReviewQuotaExceptions([supplied]); supplied.totalCap=99;
  assert.equal(grants[0].totalCap,6); assert.ok(Object.isFrozen(grants)&&Object.isFrozen(grants[0]));
  assert.throws(()=>policy.validateReviewQuotaExceptions([grant(),grant()]),/Duplicate/);
  for(const change of [{totalCap:7},{stageCap:4},{extra:true},{phaseIndex:1},{tier:'T1'}])
    assert.throws(()=>policy.validateReviewQuotaExceptions([{...grant(),...change}]),/Invalid/);
  const tuple={parentRunId:parent,phaseIndex:2,stage:'post-review'};
  assert.equal(policy.effectiveReviewQuota(grants,identity,tuple).total,6);
  for(const change of [{workspaceSha256:sha('other')},{runAnchorSha256:sha('other')}])
    assert.equal(policy.effectiveReviewQuota(grants,{...identity,...change},tuple).total,5);
  for(const change of [{parentRunId:'other'},{phaseIndex:1}])
    assert.equal(policy.effectiveReviewQuota(grants,identity,{...tuple,...change}).total,5);
  assert.equal(policy.effectiveReviewQuota(grants,{...identity,tier:'T1'},tuple).total,2);
  assert.equal(policy.REVIEW_QUOTA_POLICY.T2.time,1200000);
  assert.equal(policy.REVIEW_QUOTA_POLICY.T2.total,5);
  withLedger((_dir,ledger)=>assert.throws(()=>ledger.reserve(input('bad-stage','other')),invalid));
});

test('six slots retain durable history, measured time, restart and fail-closed grant removal',()=>withLedger((dir,ledger)=>{
  baseFour(ledger); const before=ledger.snapshot(input('before'));
  for(const stage of ['pre-review','post-review']) finish(ledger,ledger.reserve(input('extra-'+stage,stage)));
  const restarted=policy.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[grant()]});
  const after=restarted.snapshot(input('after'));
  assert.deepEqual(after.attempts.slice(0,4),before.attempts);
  for(const [id,value] of Object.entries(before.decisions)) assert.deepEqual(after.decisions[id],value);
  assert.equal(after.attempts.length,6); assert.equal(after.timeUsedMs,before.timeUsedMs+2000);
  assert.throws(()=>restarted.reserve(input('seventh')),limit);
  assert.throws(()=>policy.createReviewAttemptLedger(dir).snapshot(input('removed')),invalid);
}));

test('released reservations refund time and slots without permitting request-ID relaunch',()=>withLedger((dir,ledger)=>{
  baseFour(ledger);const before=ledger.snapshot(input('before'));
  const ticket=ledger.reserve(input('released','pre-review'));
  ledger.finish(ticket,{started:false,outcome:'not-launched'});
  const restarted=policy.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[grant()]});
  assert.equal(restarted.snapshot(input('after')).timeUsedMs,before.timeUsedMs);
  assert.equal(restarted.snapshot(input('after')).extensionUsed,false);
  const replay=restarted.reserve(input('released','pre-review'));assert.equal(replay.replayed,true);
  assert.throws(()=>restarted.markStarted(replay),invalid);
  finish(restarted,restarted.reserve(input('replacement','pre-review')));
}));

test('caller grants and other parent/phase cannot borrow looser whole-goal aggregates',()=>{
  withLedger((_dir,ledger)=>{
    baseFour(ledger);
    assert.throws(()=>ledger.reserve(input('spoof','pre-review',2,{reviewQuotaExceptions:[grant()]})),invalid);
    for(const extra of [{parentRunId:'other-parent'},{phaseIndex:1}])
      assert.throws(()=>ledger.reserve(input('mismatch-'+Object.keys(extra)[0],'pre-review',2,extra)),limit);
  });
  withLedger((_dir,ledger)=>{
    baseFour(ledger,pinInput);
    for(const extra of [{parentRunId:'other-parent'},{phaseIndex:1}])
      assert.throws(()=>ledger.reserve(pinInput('pinned-mismatch-'+Object.keys(extra)[0],'pre-review',2,extra)),limit);
  },[pinnedGrant()]);
});

test('6/8/11/13/14 configuration preserves exact caps and rejects widened pins',()=>{
  for(const [cap,post,pre] of [[6,3,3],[8,5,3],[11,8,3],[13,9,4],[14,10,4]]) {
    const grants=policy.validateReviewQuotaExceptions([pinnedGrant(cap,post)]);
    for(const [stage,expected] of [['pre-review',pre],['post-review',post]]){
      const limits=policy.effectiveReviewQuota(grants,pinned,{parentRunId:pinnedParent,phaseIndex:2,stage});
      assert.equal(limits.total,cap);assert.equal(limits.stage,expected);assert.equal(limits.time,1200000);
    }
    if(cap>6)assert.throws(()=>policy.effectiveReviewQuota(grants,pinned,{parentRunId:pinnedParent,phaseIndex:2,stage:'other'}),/stage/);
  }
  for(const change of [{id:'other'},{workspaceSha256:sha('other')},{runAnchorSha256:sha('other')},
    {parentRunId:'other'},{authorizationReference:'other'},{phaseIndex:1},{tier:'T1'},{totalCap:15},{stageCap:11}])
    assert.throws(()=>policy.validateReviewQuotaExceptions([{...pinnedGrant(),...change}]),/Invalid/);
});

function closure(implementation,decision,previousReviewRequestId,path){return {version:1,previousReviewRequestId,
  closures:[{key:implementation.reviewBlockers(decision)[0].key,paths:[path],evidence:'Synthetic correction verified'}]};}
// Build history through public ledger methods; no production ledger or reviewer body is copied.
function tenPrefix(ledger,implementation=policy,last={}) {
  baseFour(ledger,pinInput);
  finish(ledger,ledger.reserve(pinInput('synthetic-pre-third','pre-review',2,{materialSections:{requirements:sha('old')}})));
  const broken=failure('src/synthetic.mjs');
  finish(ledger,ledger.reserve(pinInput('synthetic-repair-source')),broken);
  finish(ledger,ledger.reserve(pinInput('synthetic-pre-fourth','pre-review',2,{materialSections:{requirements:sha('new')}})));
  finish(ledger,ledger.reserve(pinInput('synthetic-post-fourth','post-review',2,{changedPaths:['src/synthetic.mjs'],
    progress:closure(implementation,broken,'synthetic-repair-source','src/synthetic.mjs')})));
  finish(ledger,ledger.reserve(pinInput('synthetic-post-fifth')));
  const request=pinInput('synthetic-post-sixth','post-review',2,{...last.input});
  finish(ledger,ledger.reserve(request),last.decision||approve);
}

test('synthetic 8/11 histories reach their caps and preserve prefixes after restart',()=>{
  for(const [cap,postCap] of [[8,5],[11,8]])withLedger((dir,ledger)=>{
    baseFour(ledger,pinInput);finish(ledger,ledger.reserve(pinInput('synthetic-pre-third','pre-review')));
    const prefix=ledger.snapshot(pinInput('before'));
    for(let n=5;n<cap;n++)finish(ledger,ledger.reserve(pinInput('post-'+n)));
    const after=policy.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[pinnedGrant(cap,postCap)]}).snapshot(pinInput('after'));
    assert.equal(after.attempts.length,cap);assert.deepEqual(after.attempts.slice(0,5),prefix.attempts);
    assert.throws(()=>ledger.reserve(pinInput('overflow')),limit);
  },[pinnedGrant(cap,postCap)]);
});

test('13/14 histories enforce pre4/post9 or10, whole-goal caps and restart',()=>{
  for(const [cap,postCap] of [[13,9],[14,10]])withLedger((dir,ledger)=>{
    tenPrefix(ledger);const prefix=ledger.snapshot(pinInput('before'));
    for(let n=10;n<cap;n++)finish(ledger,ledger.reserve(pinInput('after-repair-'+n)));
    const after=policy.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[pinnedGrant(cap,postCap)]}).snapshot(pinInput('after'));
    assert.equal(after.attempts.length,cap);assert.equal(after.attempts.filter(a=>a.stage==='pre-review').length,4);
    assert.equal(after.attempts.filter(a=>a.stage==='post-review').length,postCap);
    assert.deepEqual(after.attempts.slice(0,10),prefix.attempts);
    assert.throws(()=>ledger.reserve(pinInput('post-overflow')),limit);
    assert.throws(()=>ledger.reserve(pinInput('pre-overflow','pre-review')),limit);
  },[pinnedGrant(cap,postCap)]);
});

const retry = extra => pinInput('card-lab-final-range-3-evidence-reconsideration-20261013','post-review',2,{
  materialDigest:'5b746af029241d283f06e0f867bdfbdc3f935de17bcd27f6ab48d55c1bc64ac1',
  artifactDigest:'cdd8518a02743d344645709600c8c6bce7564e2258d9a596b7b1f69c450e2184',
  hostRecordDigest:'873748be9c0e59041e1cba540cadb464bc43591b8ca1dbf510f9284eac00d706',
  materialSections:{requirements:sha('new-requirements'),changes:sha('new-changes')},...extra});
const pinnedFailure=failure('tests/native-planner.test.mjs');
// The actual blocker description is private. Rebind ONLY its immutable digest in a local
// module copy so CI can exercise this mechanism with a synthetic decision. All other pins,
// admission code and ledger methods are unchanged; actual-pin replay is a separate host check.
const source=readFileSync(new URL('../scripts/tier-review-policy.mjs',import.meta.url),'utf8');
const actualKey='72e17cb44d20fc848f4ab8e5d07ad9b29bc432feab9ab06a113e51c00e8d9fd4';
const syntheticKey=policy.reviewBlockers(pinnedFailure)[0].key;
assert.equal(source.split(actualKey).length,2);
const pinModuleDir=mkdtempSync(join(tmpdir(),'quota-synthetic-pin-'));
after(()=>rmSync(pinModuleDir,{recursive:true,force:true}));
const pinModule=join(pinModuleDir,'policy.mjs');writeFileSync(pinModule,source.replace(actualKey,syntheticKey));
const syntheticPolicy=await import(pathToFileURL(pinModule).href);
function reconsideration(implementation=syntheticPolicy){return retry({progress:{version:1,
  previousReviewRequestId:'card-lab-final-range-3-20261013',closures:[{key:implementation===policy?actualKey:syntheticKey,
    paths:['tests/native-planner.test.mjs'],evidence:'Synthetic report 31c4f85c6f4af9a83f4c3a464009511fa867eb83b78cef581f6179d08eef18ac'}]}});}
function reconsiderPrefix(ledger,implementation){tenPrefix(ledger,implementation,{input:{
  requestId:'card-lab-final-range-3-20261013',materialDigest:'5c420fd5b0707e63808164e0ca404554fc8ebe79ee2bfcab414b179df5f9f34f',
  artifactDigest:retry().artifactDigest,hostRecordDigest:retry().hostRecordDigest,
  materialSections:{requirements:sha('old-requirements'),changes:sha('old-changes')}},decision:pinnedFailure});}

test('synthetic-pin reconsideration is single-use, evidence-bound, and reaches exactly fourteen',()=>withLedger((dir,ledger)=>{
  reconsiderPrefix(ledger,syntheticPolicy);const before=ledger.snapshot(pinInput('before'));
  finish(ledger,ledger.reserve(reconsideration()));
  assert.equal(ledger.snapshot(pinInput('after-retry')).attempts.at(-1).progressVerified,true);
  const replay=ledger.reserve(reconsideration());assert.equal(replay.replayed,true);assert.throws(()=>ledger.markStarted(replay),invalid);
  assert.throws(()=>ledger.reserve({...reconsideration(),requestId:'second-reconsideration'}),limit);
  for(let n=0;n<3;n++)finish(ledger,ledger.reserve(pinInput('after-evidence-'+n)));
  const after=syntheticPolicy.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[pinnedGrant()]}).snapshot(pinInput('after'));
  assert.deepEqual(after.attempts.slice(0,10),before.attempts);assert.equal(after.attempts.length,14);
  assert.throws(()=>ledger.reserve(pinInput('fifteenth')),limit);
},[pinnedGrant()],syntheticPolicy));

test('every wrong reconsideration pin or closure fails without consuming a slot',()=>{
  const mutations=[r=>({...r,requestId:'wrong'}),r=>({...r,materialDigest:sha('wrong')}),r=>({...r,artifactDigest:sha('wrong')}),
    r=>({...r,hostRecordDigest:sha('wrong')}),r=>({...r,parentRunId:'wrong'}),r=>({...r,phaseIndex:1}),
    r=>({...r,progress:{...r.progress,previousReviewRequestId:'wrong'}}),
    r=>({...r,progress:{...r.progress,closures:[]}}),
    ...[{key:sha('wrong')},{paths:['tests/other.mjs']},{evidence:'missing report'},
      {paths:['tests/native-planner.test.mjs','tests/other.mjs']},{evidence:' '}].map(change=>r=>({...r,progress:{...r.progress,closures:[{...r.progress.closures[0],...change}]}})),
    r=>({...r,materialSections:{requirements:sha('new')}})];
  for(const mutate of mutations)withLedger((_dir,ledger)=>{
    reconsiderPrefix(ledger,syntheticPolicy);const before=ledger.snapshot(pinInput('before'));
    assert.throws(()=>ledger.reserve(mutate(reconsideration())),e=>limit(e)||invalid(e));
    assert.deepEqual(ledger.snapshot(pinInput('after')).attempts,before.attempts);
  },[pinnedGrant()],syntheticPolicy);
  withLedger((_dir,ledger)=>{reconsiderPrefix(ledger,policy);assert.throws(()=>ledger.reserve(reconsideration(policy)),limit);},[pinnedGrant()]);
});

test('extended grants retain the twenty-minute total, including measured overruns',()=>withLedger((_dir,ledger)=>{
  const ticket=ledger.reserve(pinInput('slow','pre-review',1));finish(ledger,ticket,approve,1200000);
  const before=ledger.snapshot(pinInput('before'));assert.equal(before.timeUsedMs,1200000);
  assert.throws(()=>ledger.reserve(pinInput('too-late','pre-review',1)),limit);
},[pinnedGrant()]));

test('real MCP rejects forged post-review evidence and caller grants before model dispatch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'quota-mcp-public-'));let runtime,client,server,dispatchCalls=0;
  try{
    const tokenFile=join(dir,'token');writeFileSync(tokenFile,'synthetic-test-token');
    const configFile=join(dir,'gateway.json');const config={tokenFile,roots:[dir],requestLedgerDir:join(dir,'ledger'),
      auditFile:join(dir,'audit.jsonl'),providerCircuitFile:join(dir,'circuit.json'),reviewQuotaExceptions:[grant()]};
    writeFileSync(configFile,JSON.stringify({...config,reviewQuotaExceptions:[{...grant(),totalCap:99}]}));
    assert.throws(()=>loadGatewayOptions({PI_GATEWAY_CONFIG:configFile}),TypeError);
    writeFileSync(configFile,JSON.stringify(config));const loaded=loadGatewayOptions({PI_GATEWAY_CONFIG:configFile});
    runtime=createGatewayRuntime({...loaded,sandboxStatus:{ok:false,backend:'unavailable',resourceLimits:false},
      dispatchFn:async()=>{dispatchCalls++;throw new Error('unexpected model dispatch');}});
    const caps=runtime.capabilities().governance.workflowTiers;
    assert.equal(caps.reviewQuota.T2.totalCap,5);assert.equal(caps.reviewQuotaExceptionSummary[0].totalCap,6);
    assert.ok(!JSON.stringify(caps).includes('authorizationReference'));
    config.reviewQuotaExceptions[0].totalCap=99;assert.equal(runtime.capabilities().governance.workflowTiers.reviewQuotaExceptionSummary[0].totalCap,6);
    server=runtime.makeServer();client=new Client({name:'quota-public-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
    const workflow=JSON.parse((await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}})).content[0].text);
    const args={cwd:dir,parentRunId:'synthetic-mcp-parent',requestId:'forged-host-review',reviewOfRequestId:'missing-implementation',
      provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',tier:'T2',workflowReceipt:workflow.receipt,
      task:{contractVersion:2,role:'Geburah',objective:'Reject forged evidence',acceptance:['Reject before dispatch'],context:[],readScope:[],writeScope:[],
        handoff:{version:2,stage:'post-review',inputs:[{requestId:'missing-implementation',role:'Chesed',stage:'implementing',resultSha256:sha('forged')}],runGoal:'Synthetic goal',runAcceptance:['Preserve proof gate'],phaseIndex:2},
        reviewPacket:{version:1,stage:'post-change',requirements:{status:'provided',content:['Synthetic requirement']},changes:{status:'provided',content:['Forged implementation']},context:{status:'provided',content:['Synthetic fixture']},verification:{status:'provided',content:['No trusted host proof']}}}};
    const result=JSON.parse((await client.callTool({name:'dispatch_subagent',arguments:args})).content[0].text);
    assert.equal(result.ok,false);assert.equal(result.code,'PI_T2_REVIEW_REFERENCE_REQUIRED');assert.equal(dispatchCalls,0);
    const forged=await client.callTool({name:'dispatch_subagent',arguments:{...args,requestId:'caller-grant',reviewQuotaExceptions:[grant()]}});
    assert.ok(forged.isError||JSON.parse(forged.content[0].text).ok===false);assert.equal(dispatchCalls,0);
    const reviewDir=join(config.requestLedgerDir,'review-attempts');
    assert.equal(readdirSync(reviewDir).filter(f=>f.endsWith('.json')).length,0);
  }finally{
    await client?.close().catch(()=>{});await server?.close().catch(()=>{});
    await runtime?.shutdown({graceMs:0,abortWaitMs:0}).catch(()=>{});rmSync(dir,{recursive:true,force:true});
  }
});
