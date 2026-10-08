#!/usr/bin/env node
import { readFile, open, unlink, link } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const usage = 'Usage: node scripts/tier-metrics.mjs --audit PATH [--audit PATH...] --from ISO --to ISO [--output PATH]';
function args(argv) {
  const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    audit: { type: 'string', multiple: true }, from: { type: 'string' }, to: { type: 'string' }, output: { type: 'string' },
  }}).values;
  if (!parsed.audit?.length || !parsed.from || !parsed.to) throw Error('required: --audit, --from, --to');
  for (const key of ['from', 'to']) {
    const value = parsed[key];
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0,10) !== value.slice(0,10)) throw Error(`invalid UTC ${key} datetime`);
  }
  if (Date.parse(parsed.from) >= Date.parse(parsed.to)) throw Error('window must satisfy from < to');
  return parsed;
}
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const parentOf = r => r.parentRunId ?? r.contract?.parentRunId ?? null;
const workspaceOf = r => r.workspaceSha256 ?? r.contract?.workspaceSha256 ?? r.workspace ?? r.contract?.workspace ?? '';
const anchorOf = r => r.runAnchorSha256 ?? r.contract?.runAnchorSha256 ?? r.runAnchorSHA ?? r.contract?.runAnchorSHA ?? '';
const taskKey = r => {
  const p = parentOf(r); if (!p) return null;
  const w = workspaceOf(r), a = anchorOf(r);
  return `${w}\0${a}\0${p}`;
};
const tierOf = r => r.tier ?? r.effectiveTier ?? r.contract?.tier ?? r.contract?.effectiveTier;
const median = values => { if (!values.length) return null; values.sort((a,b)=>a-b); const n=values.length; return n%2 ? values[(n-1)/2] : (values[n/2-1]+values[n/2])/2; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
function classifyStage(r) {
  const stage = r.reviewStage ?? r.envelope?.handoff?.stage ?? r.contract?.stage;
  return stage === 'pre-review' || stage === 'pre' ? 'pre' : stage === 'post-review' || stage === 'post' ? 'post' : 'unknown';
}
function strictTaskKey(r) {
  const values = [workspaceOf(r), anchorOf(r), parentOf(r)];
  if (values.some(v => typeof v !== 'string' || !v.trim())) return null;
  return values.join('\0');
}
const effortOf = r => r.thinking ?? r.route?.thinking;
const emptyEffort = () => ({medium:0,high:0,xhigh:0,max:0,unknown:0});
function additiveMetrics(records, rows, from, to) {
  const inWindow = records.filter(r => Number.isFinite(Date.parse(r.timestamp)) && Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) < to);
  const launches = rows.filter(r => r.operation === 'dispatch_subagent');
  const launchCoverage = {real:0,confirmedZero:0,unknown:0};
  for (const r of launches) {
    if (r.modelExecution === true) launchCoverage.real++;
    else if (r.modelExecution === false) launchCoverage.confirmedZero++;
    else launchCoverage.unknown++;
  }
  let earliestTime = Infinity, latestTime = -Infinity, validTimeCount = 0;
  for (const r of records) {
    const time = Date.parse(r.timestamp);
    if (!Number.isFinite(time)) continue;
    validTimeCount++;
    if (time < earliestTime) earliestTime = time;
    if (time > latestTime) latestTime = time;
  }
  const timeCoverage = {
    earliest: validTimeCount ? new Date(earliestTime).toISOString() : null,
    latest: validTimeCount ? new Date(latestTime).toISOString() : null,
    malformed: records.length - validTimeCount,
  };
  const reviewerEffort = emptyEffort();
  for (const r of launches.filter(r => r.modelExecution === true && ['Geburah','reviewer'].includes(r.envelope?.role))) {
    const effort = effortOf(r);
    reviewerEffort[['medium','high','xhigh','max'].includes(effort) ? effort : 'unknown']++;
  }
  const cohortCalls = launches.filter(r => r.modelExecution === true);
  const implementations = new Map();
  for (const r of cohortCalls) {
    const key = strictTaskKey(r);
    if (!key || r.envelope?.role !== 'Chesed' || r.access !== 'workspace-write') continue;
    const item = implementations.get(key) ?? {efforts:emptyEffort(),starts:[],terminals:[]};
    const effort = effortOf(r);
    item.efforts[['medium','high','xhigh','max'].includes(effort) ? effort : 'unknown']++;
    const terminal = Date.parse(r.completedAt ?? r.timestamp);
    if (Number.isFinite(terminal)) item.terminals.push(terminal);
    implementations.set(key,item);
  }
  const cohortItems = new Map();
  for (const r of cohortCalls) {
    const key = strictTaskKey(r);
    if (!key || !implementations.has(key)) continue;
    const item = cohortItems.get(key) ?? {tiers:[],starts:[]};
    const tier = tierOf(r);
    if (['T0','T1','T2'].includes(tier)) item.tiers.push(tier);
    let start = Date.parse(r.submittedAt);
    if (!Number.isFinite(start)) start = Date.parse(r.startedAt);
    if (Number.isFinite(start)) item.starts.push(start);
    cohortItems.set(key,item);
  }
  for (const [key,item] of implementations) item.starts = cohortItems.get(key)?.starts ?? [];
  const rank = {T0:0,T1:1,T2:2};
  const effortTotals = emptyEffort();
  const tierCounts = {T0:0,T1:0,T2:0,unknown:0};
  let mixedEffortTasks = 0;
  for (const [key,item] of implementations) {
    for (const k of Object.keys(effortTotals)) effortTotals[k] += item.efforts[k];
    if (Object.values(item.efforts).filter(n=>n>0).length > 1) mixedEffortTasks++;
    const tiers = cohortItems.get(key)?.tiers ?? [];
    if (!tiers.length) tierCounts.unknown++;
    else tierCounts[tiers.reduce((a,b)=>rank[a] > rank[b] ? a : b)]++;
  }
  const anchorGroups = new Map();
  for (const r of cohortCalls) {
    const anchor = anchorOf(r), parent = parentOf(r), workspace = workspaceOf(r);
    if (typeof anchor !== 'string' || !anchor.trim() || typeof parent !== 'string' || !parent.trim() || typeof workspace !== 'string' || !workspace.trim()) continue;
    const key = `${workspace}\0${parent}`, anchors = anchorGroups.get(key) ?? new Set();
    anchors.add(anchor); anchorGroups.set(key,anchors);
  }
  const divergentParentWorkspaceAnchorGroups = [...anchorGroups.values()].filter(s=>s.size>1).length;
  const unkeyedImplementationCalls = cohortCalls.filter(r=>r.envelope?.role==='Chesed' && r.access==='workspace-write' && !strictTaskKey(r)).length;
  const unkeyedRealCalls = cohortCalls.filter(r=>!strictTaskKey(r)).length;
  const unrelatedRealCalls = cohortCalls.filter(r=>strictTaskKey(r) && !implementations.has(strictTaskKey(r))).length;
  const accepted = new Map();
  let invalidProofRecords = 0, unkeyedAcceptanceRecords = 0;
  for (const r of rows.filter(r=>r.operation==='task_accepted')) {
    const key = strictTaskKey(r);
    if (!key || !implementations.has(key)) { unkeyedAcceptanceRecords++; continue; }
    const t = Date.parse(r.acceptedAt);
    const host = r.hostVerification, proof = r.verification;
    const hostValid = (r.taskOutcome==='completed' || r.outcome==='completed' || r.status==='completed') && host && (host.outcome==='completed' || host.state==='completed') && host.source !== 'netzach' && /^[a-f0-9]{64}$/i.test(host.artifactSha256 ?? '');
    const proofValid = (r.taskOutcome==='completed' || r.outcome==='completed' || r.status==='completed') && proof?.state==='completed' && ['host','netzach'].includes(proof.source) && /^[a-f0-9]{64}$/i.test(proof.artifactSha256 ?? '') && /^[a-f0-9]{64}$/i.test(proof.recordSha256 ?? '');
    if (!Number.isFinite(t) || t < from || t >= to || (!hostValid && !proofValid)) { invalidProofRecords++; continue; }
    const old=accepted.get(key); if (old===undefined || t>old) accepted.set(key,t);
  }
  const durations=[]; let incomplete=0,superseded=0,missingStart=0;
  for (const [key,item] of implementations) {
    if (!item.starts.length) { missingStart++; incomplete++; continue; }
    let start=Infinity, latestTerminal=-Infinity;
    for (const value of item.starts) if (value<start) start=value;
    for (const value of item.terminals) if (value>latestTerminal) latestTerminal=value;
    const end=accepted.get(key);
    if (end===undefined) { incomplete++; continue; }
    if (latestTerminal>end) { superseded++; continue; }
    if (end<start) { incomplete++; continue; }
    durations.push(end-start);
  }
  const sorted=[...durations].sort((a,b)=>a-b);
  return {
    launchCoverage, inputTimestampCoverage:timeCoverage,
    implementationCohort:{tasks:implementations.size,dispatches:[...implementations.values()].reduce((n,item)=>n+Object.values(item.efforts).reduce((a,b)=>a+b,0),0),goalCount:implementations.size,callCount:cohortCalls.filter(r=>strictTaskKey(r)&&implementations.has(strictTaskKey(r))).length,averageCallsPerGoal:implementations.size?cohortCalls.filter(r=>strictTaskKey(r)&&implementations.has(strictTaskKey(r))).length/implementations.size:null,tierCounts,effortBreakdown:effortTotals,mixedEffortTasks,unkeyedImplementationCalls,unkeyedRealCalls,unrelatedRealCalls,divergentParentWorkspaceAnchorGroups},
    finalNecessaryAcceptance:{medianMs:median([...durations]),p90Ms:sorted.length?sorted[Math.ceil(.9*sorted.length)-1]:null,completed:durations.length,incomplete,superseded,unkeyed:unkeyedAcceptanceRecords,invalidProofRecords,missingStart},
    reviewerEffortBreakdown:reviewerEffort,
  };
}
function calculate(records, from, to) {
  const badTimestamps = records.filter(r => !Number.isFinite(Date.parse(r.timestamp))).length;
  const inWindow = records.filter(r => Number.isFinite(Date.parse(r.timestamp)) && Date.parse(r.timestamp) >= from && Date.parse(r.timestamp) < to);
  const grouped = new Map();
  for (const r of inWindow) {
    const key = `${r.operation ?? ''}\0${r.requestId ?? ''}`;
    if (!r.requestId) { grouped.set(`${key}\0${grouped.size}`, {row:r}); continue; }
    const old = grouped.get(key);
    if (!old) grouped.set(key, {row:r});
    else { const {timestamp: _oldTime, ...oldContent}=old.row; const {timestamp: _newTime, ...newContent}=r; if (JSON.stringify(canonical(oldContent)) !== JSON.stringify(canonical(newContent))) old.conflict = true; }
  }
  const conflicts = [...grouped.values()].filter(x=>x.conflict).length;
  const rows = [...grouped.values()].filter(x=>!x.conflict).map(x=>x.row);
  const dispatches = rows.filter(r => r.operation === 'dispatch_subagent');
  const real = dispatches.filter(r => r.modelExecution === true);
  const realByParent = new Map(); let unparented = 0;
  for (const r of real) { const key=taskKey(r); if (!key) unparented++; else realByParent.set(key,(realByParent.get(key)||0)+1); }

  // Count only actual Chesed implementation records. Failed/queued zero-execution rows never enter this denominator.
  const implementations = new Map();
  for (const r of real) {
    if (r.envelope?.role !== 'Chesed' || r.access !== 'workspace-write') continue;
    const key=taskKey(r); if (!key) continue;
    const tier=tierOf(r), item=implementations.get(key) ?? {tiers:[], branches:new Set()};
    if (['T0','T1','T2'].includes(tier)) item.tiers.push(tier); else item.tiers.push(null);
    item.branches.add(r.requestId); implementations.set(key,item);
  }
  const acceptanceRows = rows.filter(r=>r.operation==='task_accepted');
  for (const r of acceptanceRows) {
    const key=taskKey(r); if (!key || r.envelope?.role!=='Chesed' || r.access!=='workspace-write') continue;
    if (!implementations.has(key)) implementations.set(key,{tiers:[tierOf(r)],branches:new Set([r.requestId])});
  }
  let known=0, unknown=0, t0=0;
  const legacyTaggedTiers={known:0,unknown:0,knownTaggedT0:0};
  for(const r of dispatches.filter(r=>r.modelExecution===undefined && finite(r.timings?.executionMs) && r.timings.executionMs>0 && r.envelope?.role==='Chesed' && r.access==='workspace-write' && taskKey(r))){const tier=tierOf(r);if(['T0','T1','T2'].includes(tier)){legacyTaggedTiers.known++;if(tier==='T0')legacyTaggedTiers.knownTaggedT0++;}else legacyTaggedTiers.unknown++;}
  legacyTaggedTiers.observedTaggedT0Share=legacyTaggedTiers.known?legacyTaggedTiers.knownTaggedT0/legacyTaggedTiers.known:null;
  for (const item of implementations.values()) {
    const tiers=item.tiers.filter(t=>['T0','T1','T2'].includes(t));
    if (!tiers.length) unknown++; else {known++; const rank={T0:0,T1:1,T2:2}; if (tiers.reduce((a,b)=>rank[a]>rank[b]?a:b)==='T0') t0++;}
  }

  const reviews=rows.filter(r=>r.operation==='dispatch_subagent' && r.modelExecution===true && (r.envelope?.role==='Geburah' || r.envelope?.role==='reviewer'));
  const byStage={pre:0,post:0,unknown:0}, byThinking={high:0,max:0,unknown:0}; let reviewMs=0, timedReviews=0;
  for (const r of reviews) {
    byStage[classifyStage(r)]++;
    const thinking=r.thinking ?? r.route?.thinking;
    byThinking[thinking==='high'?'high':thinking==='max'?'max':'unknown']++;
    if (finite(r.timings?.executionMs)) {reviewMs+=r.timings.executionMs;timedReviews++;}
  }
  const submissions=new Map(), acceptances=new Map(); let unmatchedAccepted=0, invalidAcceptance=0;
  for (const r of rows) {
    const key=taskKey(r);
    if (r.operation==='dispatch_subagent' && r.modelExecution===true && key) {
      const raw=r.submittedAt ?? r.startedAt;
      const t=Date.parse(raw);
      if (Number.isFinite(t) && (!submissions.has(key)||t<submissions.get(key))) submissions.set(key,t);
    }
    if (r.operation==='task_accepted') {
      if (!key) {unmatchedAccepted++;continue;}
      const raw=r.acceptedAt, t=Date.parse(raw);
      const host=r.hostVerification;
      const complete=(r.taskOutcome==='completed'||r.outcome==='completed'||r.status==='completed') && host && (host.outcome==='completed'||host.state==='completed') && /^[a-f0-9]{64}$/i.test(host.artifactSha256??'');
      const proof=r.verification;
      const verified=proof && proof.state==='completed' && ['host','netzach'].includes(proof.source) && /^[a-f0-9]{64}$/i.test(proof.artifactSha256??'') && /^[a-f0-9]{64}$/i.test(proof.recordSha256??'');
      const validComplete=(complete && host.source!== 'netzach') || verified;
      if (!Number.isFinite(t) || !validComplete || !submissions.has(key)) {invalidAcceptance++;unmatchedAccepted++;continue;}
      if (t<to && (!acceptances.has(key)||t<acceptances.get(key))) acceptances.set(key,t);
    }
  }
  const durations=[]; let incomplete=0, mismatched=0;
  for (const [key,start] of submissions) {
    const end=acceptances.get(key);
    if (end===undefined) incomplete++;
    else if(end<start) mismatched++;
    else durations.push(end-start);
  }
  const legacy=dispatches.filter(r=>r.modelExecution===undefined && finite(r.timings?.executionMs) && r.timings.executionMs>0);
  const legacyGeburah=dispatches.filter(r=>(r.envelope?.role==='Geburah'||r.envelope?.role==='reviewer') && r.modelExecution===undefined && finite(r.timings?.executionMs) && r.timings.executionMs>0);
  // Legacy chain proxy uses complete parent chains, never individual stage timings as end-to-end duration.
  const legacyChains=new Map();
  for(const r of dispatches.filter(r=>r.modelExecution===undefined)){
    const key=taskKey(r); if(!key) continue;
    const stamp=Date.parse(r.timestamp), explicitStart=Date.parse(r.submittedAt);
    const duration=finite(r.timings?.executionMs)?r.timings.executionMs:finite(r.durationMs)?r.durationMs:null;
    const start=Number.isFinite(explicitStart)?explicitStart:Number.isFinite(stamp)&&duration!==null?stamp-duration:NaN;
    const end=Date.parse(r.completedAt??r.timestamp);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)continue;
    const chain=legacyChains.get(key)??{start,end}; chain.start=Math.min(chain.start,start);chain.end=Math.max(chain.end,end);legacyChains.set(key,chain);
  }
  const chainDurations=[...legacyChains.values()].map(x=>x.end-x.start);
  const calls=[...realByParent.values()].reduce((a,b)=>a+b,0);
  const additive=additiveMetrics(records,rows,from,to);
  const ratio={numerator:t0,denominator:known,value:known?t0/known:null,unknownTierTasks:unknown,totalImplementationTasks:implementations.size,tasksWithKnownTier:known,coverage:{knownTierTasks:known,unknownTierTasks:unknown,totalImplementationTasks:implementations.size}};
  return {schemaVersion:1,window:{from:new Date(from).toISOString(),to:new Date(to).toISOString()},coverage:{recordsInWindow:inWindow.length,recordsAfterDeduplication:rows.length,conflictingDuplicateIdentities:conflicts,malformedTimestampRecords:badTimestamps,dispatchRecords:dispatches.length,knownTierTasks:known,unknownTierTasks:unknown,acceptanceSubmittedTasks:submissions.size,incompleteAcceptanceTasks:incomplete,invalidAcceptanceRecords:invalidAcceptance,unmatchedAcceptanceRecords:unmatchedAccepted,mismatchedAcceptanceTasks:mismatched},realExecutionMetrics:{avgCallsPerTask:{numerator:calls,denominator:realByParent.size,value:realByParent.size?calls/realByParent.size:null,coverage:{parentedTasks:realByParent.size,allRealDispatches:real.length,unparentedRealDispatches:unparented}},t0Share:ratio,geburah:{executionCount:reviews.length,executionMs:timedReviews?reviewMs:null,timedExecutionCount:timedReviews,byStage,byThinking,effortBreakdown:additive.reviewerEffortBreakdown,byThinkingCompatibility:'legacy-thinking-values'},dispatchToFinalAcceptance:{medianMs:median(durations),completedTasks:durations.length,incompleteTasks:incomplete,coverage:submissions.size?durations.length/submissions.size:0}},additiveMetrics:additive,legacyProxyMetrics:{positiveExecutionRecords:legacy.length,executionMsSum:legacy.length?legacy.reduce((s,r)=>s+r.timings.executionMs,0):null,executionMsCoverage:{known:legacy.length,dispatchRecords:dispatches.length},legacyTaggedTiers,geburah:{executionCountProxy:legacyGeburah.length,executionMsProxy:legacyGeburah.length?legacyGeburah.reduce((s,r)=>s+r.timings.executionMs,0):null},legacyChainEndProxyMedianMs:median(chainDurations),legacyChainEndProxyCount:chainDurations.length}};
}
async function main() {
  let a;
  try { a=args(process.argv.slice(2)); } catch(e) { console.error(`${usage}\n${e.message}`);process.exitCode=2;return; }
  const records=[];
  try { for(const path of a.audit) { const text=await readFile(path,'utf8'); for(const [i,line] of text.split(/\r?\n/).entries()) { if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{throw Error(`corrupt JSONL in ${basename(path)} line ${i+1}`);}if(!r||typeof r!=='object'||Array.isArray(r))throw Error(`invalid record in ${basename(path)} line ${i+1}`);records.push(r); } } }
  catch(e) {console.error(e.message);process.exitCode=1;return;}
  const result=JSON.stringify(calculate(records,Date.parse(a.from),Date.parse(a.to)),null,2)+'\n';
  if(!a.output){process.stdout.write(result);return;}
  const target=resolve(a.output), temp=`${target}.${randomUUID()}.tmp`;let handle;
  try {
    handle=await open(temp,'wx',0o600);await handle.writeFile(result,'utf8');await handle.close();handle=null;
    // link is an atomic exclusive publish: EEXIST never overwrites a concurrent winner.
    await link(temp,target);
  } catch(e) {console.error(e.message);process.exitCode=1;}
  finally {if(handle)await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});}
}
await main();
