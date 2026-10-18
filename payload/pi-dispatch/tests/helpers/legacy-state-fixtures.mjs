// Repository-only synthetic evidence. Never import this helper from runtime code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createMilestoneLedger, describeMilestone} from '../../extensions/milestone-ledger.js';
import {createReviewAttemptLedger, reviewBlockers} from '../../scripts/tier-review-policy.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const pins = JSON.parse(fs.readFileSync(join(packageRoot, 'tests/fixtures/legacy-state-pins.json')));
export const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const canonicalHash = value => sha(JSON.stringify(canonical(value)));
export const approve = {reviewDecision:'approve', findings:[], missingMaterials:[]};
export function temp() { return fs.mkdtempSync(join(tmpdir(), 'yhwh synthetic legacy ')); }
export function clean(root) {
  assert.ok(dirname(root) === fs.realpathSync(tmpdir()) || dirname(root) === tmpdir());
  assert.ok(!fs.lstatSync(root).isSymbolicLink());
  // All fixture paths are made here; never recurse across a junction/symlink.
  function check(p) { for (const e of fs.readdirSync(p, {withFileTypes:true})) {
    const f = join(p,e.name); assert.equal(fs.lstatSync(f).isSymbolicLink(), false);
    if (e.isDirectory()) check(f);
  } }
  check(root); fs.rmSync(root, {recursive:true,force:true});
}
export function checkSources() {
  for (const [p,digest] of Object.entries(pins.sourceFiles)) {
    assert.equal(fs.lstatSync(join(packageRoot,p)).isSymbolicLink(), false);
    assert.equal(sha(fs.readFileSync(join(packageRoot,p))), digest, `Audited source changed: ${p}`);
  }
}
function literal(value) { return "'" + value.replaceAll('\\','\\\\').replaceAll("'","\\'") + "'"; }
export function transform(p, replacements) {
  checkSources(); const original = fs.readFileSync(join(packageRoot,p),'utf8');
  const allow = pins.replacements[p]; assert.ok(allow);
  const changes = [];
  for (const [from,to] of replacements) {
    if (from === to) continue;
    assert.equal(typeof to, 'string');
    const row = allow.find(row => row.value === from); assert.ok(row, 'Unlisted pin replacement');
    assert.ok(row.count > 0); assert.equal(original.split(row.literal).length - 1, row.count);
    changes.push({...row, replacement:literal(to)});
  }
  assert.equal(new Set(changes.map(c=>c.replacement)).size, changes.length, 'Ambiguous reverse mapping');
  // Replace by token, not sequential replacement: a target cannot accidentally replace another source.
  const tokens = new Map(changes.map((c,i)=>[c.literal, `__YHWH_PIN_${i}__`]));
  let output = original;
  for (const [source,token] of tokens) { assert.ok(!original.includes(token)); output = output.split(source).join(token); }
  for (const c of changes) output = output.split(tokens.get(c.literal)).join(c.replacement);
  let reversed = output;
  for (const c of changes) {
    assert.equal(reversed.split(c.replacement).length - 1, c.count);
    reversed = reversed.split(c.replacement).join(tokens.get(c.literal));
  }
  for (const c of changes) reversed = reversed.split(tokens.get(c.literal)).join(c.literal);
  assert.deepEqual(Buffer.from(reversed), Buffer.from(original), 'Non-pin byte drift');
  return output;
}
export function mirror(root, policyMap=[], recoveryMap=[]) {
  checkSources();
  for (const p of Object.keys(pins.sourceFiles)) {
    const target = join(root,p); fs.mkdirSync(dirname(target), {recursive:true});
    let bytes = fs.readFileSync(join(packageRoot,p));
    if (p === 'scripts/tier-review-policy.mjs' && policyMap.length) bytes = Buffer.from(transform(p,policyMap));
    if (p === 'extensions/milestone-ledger.js' && recoveryMap.length) bytes = Buffer.from(transform(p,recoveryMap));
    fs.writeFileSync(target,bytes);
    if (!(p === 'scripts/tier-review-policy.mjs' && policyMap.length) && !(p === 'extensions/milestone-ledger.js' && recoveryMap.length)) {
      assert.equal(sha(fs.readFileSync(target)), pins.sourceFiles[p]);
    }
  }
  return root;
}
export const load = (root,p) => import(pathToFileURL(join(root,p)).href);
export function bind(map, from, to) {
  if (from === to) return;
  const old = map.find(([key])=>key===from);
  if (old) assert.equal(old[1],to,'Inconsistent derived pin'); else map.push([from,to]);
}
export function finish(ledger,ticket,decision=approve,elapsed=1000) {
  ledger.markStarted(ticket);
  ledger.finish(ticket,{started:true,outcome:'execution-finished',executionMs:elapsed});
  if (decision) ledger.recordDecision(ticket,decision);
}
const C = pins.constants;
export function grant(cap=14) {
  return {id:'infalsus-card-lab-phase2-20261012', authorizationReference:cap>=15 ? C['QUOTA'+cap].authorizationReference : C.EVIDENCE_RECONSIDERATION.authorizationSha256,
    workspaceSha256:C.QUOTA15.workspaceSha256,runAnchorSha256:C.QUOTA15.runAnchorSha256,
    parentRunId:C.QUOTA15.parentRunId,tier:'T2',phaseIndex:2,totalCap:cap,stageCap:({6:3,8:5,11:8,13:9,14:10,15:11,16:12,17:13})[cap]};
}
export function reviewInput(requestId,overrides={}) {
  const g = grant(); return {workspaceSha256:g.workspaceSha256,runAnchorSha256:g.runAnchorSha256,parentRunId:g.parentRunId,
    tier:'T2',stage:'post-review',phaseIndex:2,requestId,timeoutSeconds:120,materialDigest:sha(requestId+' material'),
    artifactDigest:sha(requestId+' artifact'),hostRecordDigest:sha(requestId+' host'),
    materialSections:{requirements:sha(requestId+' requirements'),changes:sha(requestId+' changes')},...overrides};
}
function actionable(name,path='tests/synthetic.mjs') {
  return {reviewDecision:'request-changes',findings:[{severity:'high',blocking:true,description:'Synthetic '+name,evidence:path}],missingMaterials:[]};
}
function progress(previous,decision,path='tests/synthetic.mjs') {
  return {version:1,previousReviewRequestId:previous,closures:reviewBlockers(decision).map(b=>({key:b.key,paths:[path],evidence:'Synthetic changed test evidence'}))};
}
// Generate a 4-pre prefix using the unchanged real module, not invented ledger rows.
function seed(root, postCount, lastInput, lastDecision) {
  const ledger = createReviewAttemptLedger(root,{reviewQuotaExceptions:[grant()]});
  for (let i=0;i<3;i++) finish(ledger,ledger.reserve(reviewInput('synthetic-pre-'+i,{stage:'pre-review'})),actionable('pre '+i));
  finish(ledger,ledger.reserve(reviewInput('synthetic-post-initial')));
  const first = actionable('post correction');
  finish(ledger,ledger.reserve(reviewInput('synthetic-post-first')),first);
  finish(ledger,ledger.reserve(reviewInput('synthetic-pre-fourth',{stage:'pre-review'})),actionable('fourth pre'));
  finish(ledger,ledger.reserve(reviewInput('synthetic-post-corrected',{
    progress:progress('synthetic-post-first',first),changedPaths:['tests/synthetic.mjs'],materialSections:{'tests/synthetic.mjs':sha('corrected')}
  })));
  for(let i=3;i<postCount-1;i++) finish(ledger,ledger.reserve(reviewInput('synthetic-post-'+i)));
  finish(ledger,ledger.reserve(lastInput),lastDecision);
  return ledger.snapshot(reviewInput('inspect'));
}
function missingFor(paths,index,group) {
  // Distinct first hex digit ranges preserve the production sorted blocker/path order.
  const digit = ['1','3','5','7','9','b','d'][index];
  for(let n=0;n<20000;n++) {
    const text = `Synthetic ${group} missing evidence ${n} ${paths.join(' ')}`;
    if (reviewBlockers({missingMaterials:[text]})[0].key.startsWith(digit)) return text;
  }
  throw Error('Could not construct sorted synthetic blockers');
}
const paths5 = [['cancel/continue.'],[],[],[],['dist/index.html','import/commit'],[],['5/6','dist/app.mjs','progress/import/commit','source/test/tool/doc']];
const paths6 = [[],[],['import/commit','tools/compile-rules.mjs'],[],[]];
export async function quotaFixture() {
  const root=temp(), map=[];
  try {
    const q5=C.QUOTA15.range5,q6=C.QUOTA15.range6,q17=C.QUOTA17;
    const missing5={reviewDecision:'insufficient-materials',findings:[],missingMaterials:paths5.map((p,i)=>missingFor(p,i,'five'))};
    const missing6={reviewDecision:'insufficient-materials',findings:[],missingMaterials:paths6.map((p,i)=>missingFor(p,i,'six'))};
    const blockers5=reviewBlockers(missing5),blockers6=reviewBlockers(missing6);
    assert.deepEqual(blockers5.map(b=>b.paths), paths5); assert.deepEqual(blockers6.map(b=>b.paths),paths6);
    const prior=reviewInput(q5.previous);
    const initial=seed(join(root,'seed'),9,prior,missing5);
    const five=reviewInput(q5.requestId,{artifactDigest:prior.artifactDigest,hostRecordDigest:prior.hostRecordDigest,
      progress:{version:1,previousReviewRequestId:q5.previous,closures:blockers5.map((b,i)=>({key:b.key,paths:b.paths.length?b.paths:['materials/range5'],evidence:sha('synthetic range5 evidence')}))}});
    const six=reviewInput(q6.requestId);
    const last=reviewInput(q17.requestId,{artifactDigest:six.artifactDigest,hostRecordDigest:six.hostRecordDigest,timeoutSeconds:300,
      progress:{version:1,previousReviewRequestId:q17.previous,closures:blockers6.map(b=>({key:b.key,paths:b.paths.length?b.paths:['materials/range6'],evidence:sha('synthetic range6 evidence')}))}});
    const evidenceDecision=actionable('evidence reconsideration',C.EVIDENCE_RECONSIDERATION.path);
    const evidencePrevious=reviewInput(C.EVIDENCE_RECONSIDERATION.previousReviewRequestId);
    const ten=seed(join(root,'seed-ten'),6,evidencePrevious,evidenceDecision);
    const retry=reviewInput(C.EVIDENCE_RECONSIDERATION.requestId,{artifactDigest:evidencePrevious.artifactDigest,hostRecordDigest:evidencePrevious.hostRecordDigest,
      progress:{version:1,previousReviewRequestId:evidencePrevious.requestId,closures:[{key:reviewBlockers(evidenceDecision)[0].key,paths:[C.EVIDENCE_RECONSIDERATION.path],evidence:sha('synthetic evidence report')}]}});
    for(const [name,to]of Object.entries({materialDigest:retry.materialDigest,previousMaterialDigest:evidencePrevious.materialDigest,artifactDigest:retry.artifactDigest,
      hostRecordDigest:retry.hostRecordDigest,blockerKey:retry.progress.closures[0].key,reportSha256:retry.progress.closures[0].evidence})) bind(map,C.EVIDENCE_RECONSIDERATION[name],to);
    function rangePins(original,input,previous) {
      for(const k of ['materialDigest','artifactDigest','hostRecordDigest'])bind(map,original[k],input[k]);
      if(previous)bind(map,original.previousMaterialDigest,previous.materialDigest);
      for(const k of ['requirements','changes'])bind(map,original.sections[k],input.materialSections[k]);
    }
    rangePins(q5,five,prior);rangePins(C.QUOTA16.range5,{...five,requestId:C.QUOTA16.range5.requestId});
    rangePins(q6,six);rangePins(C.QUOTA16.range6,six);rangePins(q17,last);
    bind(map,q17.previousMaterialDigest,six.materialDigest);
    bind(map,C.QUOTA15.reportSha256,five.progress.closures[0].evidence);bind(map,q17.reportSha256,last.progress.closures[0].evidence);
    C.QUOTA15.blockers.forEach((key,i)=>bind(map,key,blockers5[i].key));q17.blockers.forEach((key,i)=>bind(map,key,blockers6[i].key));
    function prefix(cap,state) {
      const c=C['QUOTA'+cap],n=cap===15?13:cap===16?14:16;
      bind(map,c['first'+n+'AttemptsSha256'],sha(JSON.stringify(state.attempts.slice(0,n))));
      bind(map,c['first'+n+'DecisionsSha256'],sha(JSON.stringify(state.attempts.slice(0,n).map(a=>[a.requestId,state.decisions[a.requestId]]))));
    }
    prefix(15,initial);
    const runtime=join(root,'runtime');mirror(runtime,map);
    const mod15=await load(runtime,'scripts/tier-review-policy.mjs');
    const ledger15=openState(join(root,'build14'),initial,mod15,15);
    const timeout=ledger15.reserve({...five,timeoutSeconds:140});finish(ledger15,timeout,null,136302);
    const fourteen=ledger15.snapshot(reviewInput('inspect14'));prefix(16,fourteen);
    const runtime16=join(root,'runtime16');mirror(runtime16,map);const mod16=await load(runtime16,'scripts/tier-review-policy.mjs');
    const ledger16=openState(join(root,'build16'),fourteen,mod16,16);
    finish(ledger16,ledger16.reserve({...five,requestId:C.QUOTA16.range5.requestId}));
    finish(ledger16,ledger16.reserve(six),missing6);
    const sixteen=ledger16.snapshot(reviewInput('inspect16'));prefix(17,sixteen);
    const runtimeFinal=join(root,'runtime-final');mirror(runtimeFinal,map);const module=await load(runtimeFinal,'scripts/tier-review-policy.mjs');
    return {root,map,module,initial,fourteen,sixteen,ten,five,six,last,retry,evidencePrevious,missing5,missing6,runtime:runtimeFinal,cleanup:()=>{checkSources();clean(root);}};
  } catch(e) { clean(root);throw e; }
}
export function openState(dir,state,module,cap=17) {
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(join(dir,state.key+'.json'),JSON.stringify(state));
  return module.createReviewAttemptLedger(dir,{reviewQuotaExceptions:[grant(cap)]});
}
export async function recoveryFixture() {
  const root=temp();
  try {
    const workspace=join(root,'workspace with spaces');fs.mkdirSync(workspace,{recursive:true});
    const requestRoot=join(root,'requests'),milestones=join(requestRoot,'milestones');
    const c=C.RECOVERY;
    const input={workspace,parentRunId:c.parentRunId,requestId:'synthetic-before-1',milestone:{id:'synthetic-recovery',objective:'Synthetic isolated recovery',acceptanceCommandIds:['check']},
      verify:{commands:[{id:'check',argv:['node','--version'],cwd:'.'}]},writeScope:['example.mjs']};
    const ledger=createMilestoneLedger(milestones,{instanceId:c.originalInstanceId});
    for(let i=1;i<=2;i++) {
      const id='synthetic-before-'+i;ledger.reserve({...input,requestId:id});ledger.fail(id,{checkName:'fixture',output:'Synthetic zero-start '+i,modelStarted:false});
    }
    // Known zero-start records remain history, without consuming implementation strikes.
    ledger.reserve({...input,requestId:c.originalRequestId});ledger.markStarted(c.originalRequestId);
    const file=join(milestones,'milestones.json'),state=JSON.parse(fs.readFileSync(file));
    const description=describeMilestone(input),m=state.milestones[0];assert.equal(description.key,m.key);
    const requestDir=join(requestRoot,sha(c.originalRequestId));fs.mkdirSync(requestDir,{recursive:true});
    const startedBytes=Buffer.from(JSON.stringify({requestId:c.originalRequestId,instance:c.originalInstanceId,synthetic:true}));fs.writeFileSync(join(requestDir,'started.json'),startedBytes);
    const snapshot={milestone:m,attempts:state.attempts};
    const proof={workspace:description.identity.workspace,authorizationFile:join(root,'authorization.txt'),snapshotFile:join(root,'snapshot.json'),operatorEvidenceFile:join(root,'operator.json')};
    const authorization=Buffer.from('Synthetic isolated test authorization, never a production grant.');fs.writeFileSync(proof.authorizationFile,authorization);fs.writeFileSync(proof.snapshotFile,JSON.stringify(snapshot));
    fs.writeFileSync(proof.operatorEvidenceFile,JSON.stringify({requestId:c.originalRequestId,authorizationSha256:sha(authorization),executionUnknown:true,oldProcessInactive:true,assertion:'Isolated synthetic evidence; prior process inactive and execution remains unknown.'}));
    const policy=Buffer.from('// synthetic policy proof\n'),test=Buffer.from('// synthetic tests proof\n');
    for(const [p,b]of [['scripts/tier-review-policy.mjs',policy],['tests/review-quota-adjudication.test.mjs',test]]){fs.mkdirSync(dirname(join(workspace,'payload/pi-dispatch',p)),{recursive:true});fs.writeFileSync(join(workspace,'payload/pi-dispatch',p),b);}
    const values={requestDigest:sha(c.originalRequestId),definitionSha256:description.definitionSha256,milestoneKey:description.key,authorizationSha256:sha(authorization),
      policySha256:sha(policy),testsSha256:sha(test),snapshotSha256:sha(fs.readFileSync(proof.snapshotFile)),startedFileSha256:sha(startedBytes),
      prefixCanonicalSha256:canonicalHash({key:m.key,identity:m.identity,definitionSha256:m.definitionSha256,ordinal:m.ordinal,attempts:state.attempts.slice(0,3)})};
    const map=[];for(const[k,v]of Object.entries(values))bind(map,c[k],v);bind(map,C.RECOVERY_WORKSPACE,description.identity.workspace);
    const runtime=join(root,'runtime');mirror(runtime,[],map);const module=await load(runtime,'extensions/milestone-ledger.js');
    return {root,workspace,requestRoot,milestones,file,state,snapshot,input:{...input,requestId:c.successorRequestId},proof,runtime,module,map,values,
      open:(instanceId='synthetic-new-instance')=>module.createMilestoneLedger(milestones,{instanceId}),cleanup:()=>{checkSources();clean(root);}};
  } catch(e) { clean(root);throw e; }
}
