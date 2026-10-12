// Internal host orchestration, not a new gateway tool or an execution authority.
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {sanitizeResult} from '../extensions/result-export.js';
import {buildReviewPacket} from './review-materials.mjs';
import {measureReviewPacket} from '../extensions/review-contract.js';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = message => { throw new Error(message); };
function identity(requestId, artifactSha256) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId) || !hash(artifactSha256)) fail('Invalid candidate identity');
}
function assertCandidate(candidate) {
  identity(candidate?.requestId, candidate?.artifactSha256);
  if (candidate.handoff?.ok !== true || candidate.handoff.requestId !== candidate.requestId || candidate.handoff.artifactSha256 !== candidate.artifactSha256 ||
      candidate.result?.requestId !== candidate.requestId || candidate.result.patchSha256 !== candidate.artifactSha256 ||
      typeof candidate.result.patch !== 'string' || sha256(candidate.result.patch) !== candidate.artifactSha256 ||
      !hash(candidate.resultSha256) || sha256(JSON.stringify(candidate.result)) !== candidate.resultSha256) fail('Candidate identity/hash mismatch');
  const names = candidate.handoff.requiredCheckNames;
  if (!Array.isArray(names) || !names.length || names.length>32 || names.some(n => typeof n !== 'string' || !n.trim() || n.length>128 || n.includes('\0')) || new Set(names).size !== names.length) fail('Invalid required host checks');
}
function unwrap(response) {
  if (response?.isError) fail('Gateway read returned an error');
  const value = response?.structuredContent ?? JSON.parse(response?.content?.find(c => c.type === 'text')?.text ?? 'null');
  if (!value || value.ok !== true) fail('Gateway read was not successful');
  return value;
}

// One exact handoff plus bounded result pages; never scan historical pending tasks.
export async function fetchHostCandidate(callTool, {requestId, artifactSha256}) {
  identity(requestId, artifactSha256);
  const started = performance.now();
  const handoff = unwrap(await callTool('get_task_handoff', {requestId, artifactSha256}));
  if (handoff.requestId !== requestId || handoff.artifactSha256 !== artifactSha256 || !['host-verification-required', 'post-review-required', 'accepted'].includes(handoff.state)) fail('Candidate handoff is not ready or has changed');
  let json = '', offset = 0, digest, totalLength, pages = 0;
  do {
    if (++pages > 128) fail('Result page budget exceeded');
    const page = unwrap(await callTool('get_subagent_result', {requestId, offset, limit:65536}));
    if (page.ready !== true || page.requestId !== requestId || page.encoding !== 'json-utf16-offsets' || page.offset !== offset || !hash(page.sha256) ||
        !Number.isSafeInteger(page.totalLength) || page.totalLength < 1 || page.totalLength > 4 * 1024 * 1024 ||
        (digest && (page.sha256 !== digest || page.totalLength !== totalLength))) fail('Invalid or changing result page');
    digest = page.sha256; totalLength = page.totalLength;
    const chunk = page.result !== undefined ? JSON.stringify(page.result) : page.resultJsonChunk;
    if (typeof chunk !== 'string' || !chunk.length || chunk.length > 65536 || json.length + chunk.length > totalLength) fail('Invalid result chunk');
    json += chunk;
    if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== json.length || page.nextOffset <= offset)) fail('Invalid result offset');
    offset = page.nextOffset;
  } while (offset !== null);
  if (json.length !== totalLength || sha256(json) !== digest) fail('Result digest/length mismatch');
  const candidate = {requestId, artifactSha256, handoff, result:JSON.parse(json), resultSha256:digest};
  assertCandidate(candidate);
  return {...candidate, timings:{readMs:performance.now() - started, pages}};
}

export function summarizeCandidate(candidate) {
  assertCandidate(candidate);
  return {requestId:candidate.requestId, artifactSha256:candidate.artifactSha256, state:candidate.handoff.state,
    requiredCheckNames:candidate.handoff.requiredCheckNames, finalAccepted:candidate.handoff.finalAccepted === true,
    resultSha256:candidate.resultSha256, ...candidate.timings};
}
function outputSummary(r) {
  const summary={cwd:r.cwd.slice(0,512),cwdSha256:sha256(r.cwd),elapsedMs:r.elapsedMs,outputSha256:r.outputSha256,stdout:r.stdout.slice(0,1200),stderr:r.stderr.slice(0,1200)};
  let text;
  do {
    summary.summaryTruncated=summary.cwd.length<r.cwd.length||summary.stdout.length<r.stdout.length||summary.stderr.length<r.stderr.length;
    text=JSON.stringify(summary);
    if(text.length<=4096)return text;
    const key=summary.stdout.length>=summary.stderr.length?'stdout':'stderr';
    if(!summary[key].length)fail('Host summary metadata exceeds gateway limit');
    summary[key]=summary[key].slice(0,Math.floor(summary[key].length/2));
  } while(true);
}
const evidenceCommands = outcomes => outcomes.map(r => ({checkName:r.checkName,command:r.command,exitCode:r.exitCode,outputSummary:outputSummary(r)}));

// Callbacks are explicitly selected by the host, never constructed from task text.
// This function does not apply patches, submit evidence, run a shell or accept tasks.
export async function captureHostChecks(candidate, checks) {
  assertCandidate(candidate);
  const names = candidate.handoff.requiredCheckNames;
  if (!Array.isArray(checks) || checks.length !== names.length || new Set(checks.map(c => c.checkName)).size !== names.length ||
      checks.some(c => !names.includes(c.checkName) || typeof c.command !== 'string' || !c.command.trim() || c.command.length>2048 || c.command.includes('\0') || typeof c.cwd !== 'string' || !c.cwd.trim() || c.cwd.includes('\0') || typeof c.run !== 'function')) fail('Host checks must exactly match required names');
  const started = performance.now(), outcomes = [];
  for (const check of checks) {
    const start = performance.now(), startedAt = new Date().toISOString();
    let result;
    try { result = await check.run(); }
    catch { result = {failure:'host_callback_threw', exitCode:null, stdout:'', stderr:''}; }
    if (!result || (result.exitCode !== null && !Number.isInteger(result.exitCode)) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') fail('Malformed host process result');
    const failure = result.failure ?? null;
    const output = sanitizeResult({stdout:result.stdout, stderr:result.stderr});
    outcomes.push({checkName:check.checkName, command:check.command, cwd:check.cwd, startedAt, elapsedMs:performance.now()-start,
      exitCode:result.exitCode, failure, passed:result.exitCode === 0 && failure === null,
      outputSha256:sha256(JSON.stringify({stdout:result.stdout, stderr:result.stderr})), ...output});
  }
  const passed = outcomes.every(r => r.passed);
  const evidence = passed ? {requestId:candidate.requestId, artifactSha256:candidate.artifactSha256,
    commands:evidenceCommands(outcomes)} : null;
  return {kind:'hostEvidence', requestId:candidate.requestId, artifactSha256:candidate.artifactSha256,
    passed, outcomes, evidence, elapsedMs:performance.now()-started};
}

// Explicit, already-read source excerpts only. No filesystem access or execution.
export function prepareHostReview({request, candidate, hostCapture, sources}) {
  const started = performance.now();
  assertCandidate(candidate);
  if (request?.requestId !== candidate.requestId || request.tier !== candidate.handoff.tier || !['T1','T2'].includes(request.tier)) fail('Review task/candidate mismatch');
  const task = request.task;
  if (!task || typeof task.objective !== 'string' || !Array.isArray(task.acceptance) || !task.acceptance.length ||
      !Array.isArray(task.context) || !task.context.some(t => /接口约定|interface contract/i.test(t))) fail('Task lacks objective, acceptance or interface contract');
  if (hostCapture?.kind !== 'hostEvidence' || hostCapture.passed !== true || hostCapture.requestId !== candidate.requestId || hostCapture.artifactSha256 !== candidate.artifactSha256 ||
      !hostCapture.evidence || hostCapture.evidence.requestId !== candidate.requestId || hostCapture.evidence.artifactSha256 !== candidate.artifactSha256 ||
      !Array.isArray(hostCapture.outcomes) || hostCapture.outcomes.length !== candidate.handoff.requiredCheckNames.length ||
      new Set(hostCapture.outcomes.map(o => o.checkName)).size !== hostCapture.outcomes.length ||
      hostCapture.outcomes.some(o => !candidate.handoff.requiredCheckNames.includes(o.checkName) || o.passed !== true || o.exitCode !== 0 || o.failure !== null ||
        typeof o.command !== 'string' || typeof o.cwd !== 'string' || typeof o.stdout !== 'string' || typeof o.stderr !== 'string' || !hash(o.outputSha256) || !Number.isFinite(o.elapsedMs) || o.elapsedMs<0) ||
      JSON.stringify(hostCapture.evidence.commands)!==JSON.stringify(evidenceCommands(hostCapture.outcomes))) fail('Current-artifact host evidence required');
  if (!Array.isArray(sources) || !sources.length || sources.length > 16) fail('Explicit source context required');
  const context = sources.map(s => {
    if (typeof s.path !== 'string' || !s.path.trim() || !hash(s.sha256) || typeof s.text !== 'string' || !s.text.trim() || sha256(s.text) !== s.sha256) fail('Source excerpt hash mismatch');
    return JSON.stringify({path:s.path,excerptSha256:s.sha256,text:s.text});
  });
  const packet = buildReviewPacket({stage:'post-change',tier:request.tier,changedFiles:candidate.result.patchValidation?.changedFiles,
    requirements:[JSON.stringify({objective:task.objective,acceptance:task.acceptance,forbidden:task.forbidden ?? [],owner:'Host verifies; primary accepts after required independent review'})],
    changes:[candidate.result.patch],context:[...task.context,...context],
    verification:[JSON.stringify({kind:'hostEvidence',requestId:candidate.requestId,artifactSha256:candidate.artifactSha256,commands:hostCapture.evidence.commands}),
      'sandboxEvidence is preliminary and separate; host evidence is mandatory. No gateway acceptance or reviewer authorship is inferred.']});
  if (packet.changes.content.join('') !== candidate.result.patch) fail('Review sanitization changed trusted patch; manual secure handling required');
  const budget = measureReviewPacket(packet,{trustedPatch:candidate.result.patch});
  if (!budget.validatedDiff) fail('Complete trusted unified diff required');
  const taskTemplate = {role:'Geburah',objective:task.objective,acceptance:[...task.acceptance],
    context:[...task.context,'Interface contract: reviewer consumes the embedded complete reviewPacket, no tools or filesystem access. Host owns actual checks; primary inspects materials and final acceptance. Nonblocking findings are conditional approval.']};
  return {packet,taskTemplate,reviewOfRequestId:candidate.requestId,parentRunId:request.parentRunId,
    packetSha256:sha256(JSON.stringify(packet)),budget,elapsedMs:performance.now()-started,requiresPrimaryInspection:true};
}
