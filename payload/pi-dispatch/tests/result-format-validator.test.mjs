import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { RESULT_PREFIX, evaluateHostVerificationCandidate, publicFormatValidation, recoverPrefacedKetherResult, validateKetherResult } from '../extensions/result-format-validator.js';

const fields = ['status', 'result', 'evidence', 'errors'];

test('accepts one exact prefixed JSON object with requested fields', () => {
  const value = { status: 'completed', result: 'done', evidence: ['observed'], errors: [] };
  const validation = validateKetherResult(`${RESULT_PREFIX}${JSON.stringify(value)}`, fields);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.value, value);
  assert.deepEqual(publicFormatValidation(validation), { ok: true, code: 'valid', message: undefined, expectedFields: fields });
});

test('recovers a valid envelope after a CRLF preface without changing strict validation', () => {
  const value = { status: 'completed', result: 'done', evidence: ['observed'], errors: [] };
  const envelope = `${RESULT_PREFIX}${JSON.stringify(value)}`;
  const recovered = recoverPrefacedKetherResult(`Notice\r\n${envelope}`, fields);
  assert.ok(recovered);
  assert.equal(recovered.canonicalText, envelope);
  assert.deepEqual(recovered.validation.value, value);
  assert.equal(validateKetherResult(`Notice\r\n${envelope}`, fields).code, 'missing_prefix');
});

test('rejects invalid prefaces and envelopes at boundaries', () => {
  const envelope = `${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: 'done', evidence: [], errors: [] })}`;
  assert.equal(recoverPrefacedKetherResult(`\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\t\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`${'x'.repeat(257)}\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\nsecond line\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice ${RESULT_PREFIX}\n${envelope}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${envelope}\ntrailing prose`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}{bad`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}${JSON.stringify({ status: 'completed' })}`, fields), null);
  assert.equal(recoverPrefacedKetherResult(`Notice\n${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: 'x'.repeat(512 * 1024), evidence: [], errors: [] })}`, fields), null);
});

test('rejects prose, malformed JSON, missing/extra fields, and invalid status', () => {
  assert.equal(validateKetherResult('Here is the result', fields).code, 'missing_prefix');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}{bad`, fields).code, 'invalid_json');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed' })}`, fields).code, 'field_mismatch');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: '', evidence: [], errors: [], extra: true })}`, fields).code, 'field_mismatch');
  assert.equal(validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'maybe', result: '', evidence: [], errors: [] })}`, fields).code, 'invalid_status');
});

test('rejects excessive depth without model evaluation', () => {
  let nested = 'leaf';
  for (let index = 0; index < 14; index++) nested = [nested];
  const validation = validateKetherResult(`${RESULT_PREFIX}${JSON.stringify({ status: 'completed', result: nested, evidence: [], errors: [] })}`, fields);
  assert.equal(validation.code, 'complexity_limit');
});

function hostCandidateFixture() {
  const requestId = 'host-check-1';
  const jobId = '123e4567-e89b-42d3-a456-426614174000';
  const patch = 'diff --git a/src/a.js b/src/a.js\n';
  const patchSha256 = createHash('sha256').update(patch, 'utf8').digest('hex');
  const changedFiles = ['src/a.js'];
  const scopeSha256 = 'b'.repeat(64);
  const patchValidation = {ok: true, requestId, jobId, patchSha256, scopeSha256, changedFiles};
  return {
    task: {role: 'Chesed', requestId, provider: 'openai-codex', model: 'gpt-6-luna'},
    access: 'workspace-write',
    raw: {
      requestId, ok: true, exitCode: 0, provider: 'openai-codex', requestedProvider: 'openai-codex',
      model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', osSandbox: 'wsl2-bwrap',
      cleanup: {ok: true, exitCode: 0}, patch, patchValidation,
    },
    patchProof: {trusted: true, requestId, jobId, patchSha256, scopeSha256, changedFiles},
    value: {
      status: 'completed', result: 'Patch is ready for host checks.', evidence: ['Validated in-scope patch artifact.'],
      changedFiles, assumptions: [], uncertainty: [], errors: [], nextAction: '',
      deliverable: {summary: 'Implemented the change.', changes: ['Updated src/a.js'], checks: [
        {name: 'npm test', outcome: 'unverified', evidence: 'Not run in this tool environment; host is assigned to execute them.'},
        {name: 'static inspection', outcome: 'passed', evidence: 'Worker inspection completed.'},
      ]},
    },
  };
}

test('qualifies only explicit host-unrun checks bound to the exact trusted patch and request', () => {
  for (const status of ['completed', 'unverified', 'blocked']) {
    const input = hostCandidateFixture();
    input.value.status = status;
    assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: true, requiredCheckNames: ['npm test']});
  }
  const blocked=hostCandidateFixture();blocked.value.status='blocked';
  assert.deepEqual(evaluateHostVerificationCandidate({...blocked,forceHost:true}),{eligible:false,requiredCheckNames:[]});
});

test('typed Chesed execution limitation qualifies independently of prose but never bypasses qualification gates', () => {
  const input=hostCandidateFixture();
  input.value.deliverable.checks=[{name:'host tests',outcome:'unverified',evidence:'Host check pending.',executionLimitation:{executor:'host',reason:'worker-execution-unavailable'}}];
  for(const forceHost of [false,true]){
    assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost}),{eligible:true,requiredCheckNames:['host tests']});
  }
  const malformed=[null,{}, {executor:'host'}, {executor:'worker',reason:'worker-execution-unavailable'}, {executor:'host',reason:'other'}, {executor:'host',reason:'worker-execution-unavailable',extra:true}, 'worker-execution-unavailable'];
  for(const limitation of malformed)for(const forceHost of [false,true]){
    const changed=structuredClone(input);changed.value.deliverable.checks[0].executionLimitation=limitation;
    const expected=forceHost?{eligible:true,requiredCheckNames:['host tests']}:{eligible:false,requiredCheckNames:[]};
    assert.deepEqual(evaluateHostVerificationCandidate({...changed,forceHost}),expected);
  }
  const tooLarge=structuredClone(input);tooLarge.value.deliverable.checks[0].executionLimitation={detail:'x'.repeat(4097)};
  assert.deepEqual(evaluateHostVerificationCandidate({...tooLarge,forceHost:true}),{eligible:false,requiredCheckNames:[]});
  for(const mutate of [
    value=>{value.status='unverified';},
    value=>{value.status='blocked';},
    value=>{value.status='failed';},
    value=>{value.errors=['test failed'];},
    value=>{value.deliverable.checks[0].outcome='passed';},
    value=>{value.deliverable.checks[0].outcome='failed';},
  ])for(const forceHost of [false,true]){
    const changed=structuredClone(input);mutate(changed.value);
    const allowed=forceHost&&['completed','unverified'].includes(changed.value.status)&&changed.value.errors.length===0&&['passed','unverified'].includes(changed.value.deliverable.checks[0].outcome);
    assert.deepEqual(evaluateHostVerificationCandidate({...changed,forceHost}),allowed?{eligible:true,requiredCheckNames:['host tests']}:{eligible:false,requiredCheckNames:[]});
  }
});

test('recognizes concrete English and Chinese execution limitations without broadening other host handoffs', () => {
  const positives = [
    'Host-assigned; test command was not available in this environment.',
    'Host-assigned check; worker cannot execute host test runner.',
    'Host-assigned Node --test; not executable with available tools.',
    '未执行：当前环境提供文件读写工具但无测试/命令执行工具；由 host 负责运行 node --test。',
    'Host 测试执行不可用；Host 负责运行 node --test。',
    'Host 检查未执行；Host 负责运行 node build.mjs 和 git diff --check。',
    'Host test execution unavailable; host is assigned to run this check.',
  ];
  for (const evidence of positives) for (const status of ['completed', 'unverified', 'blocked']) for (const forceHost of [false, true]) {
    const input = hostCandidateFixture();
    input.value.status = status;
    input.value.deliverable.checks[0].evidence = evidence;
    const expected = forceHost ? ['npm test', 'static inspection'] : ['npm test'];
    const allowed=!forceHost||status!=='blocked';
    assert.deepEqual(evaluateHostVerificationCandidate({...input, forceHost}), {eligible: allowed, requiredCheckNames: allowed?expected:[]}, `${status}/${forceHost}: ${evidence}`);
  }

  for (const evidence of [
    '未执行：源码编辑工作', 'Host 未执行：源码编辑工作', 'Host 无法执行源码编辑工作',
    '无法执行源码编辑', '未执行 implementation', 'Host will verify', 'check pending',
  ]) {
    const input = hostCandidateFixture();
    input.value.deliverable.checks[0].evidence = evidence;
    assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: false, requiredCheckNames: []}, evidence);
  }

  for (const mutate of [
    x => { x.value.status = 'failed'; },
    x => { x.value.errors = ['执行检查失败']; },
    x => { x.value.deliverable.checks[0].outcome = 'failed'; },
    x => { x.patchProof.trusted = false; },
    x => { x.value.changedFiles = ['other.js']; },
    x => { x.raw.patchValidation.patchSha256 = 'c'.repeat(64); },
    x => { x.raw.routeMismatch = true; },
    x => { x.raw.cleanupError = true; },
    x => { x.raw.timeout = true; },
  ]) {
    const input = hostCandidateFixture();
    input.value.deliverable.checks[0].evidence = positives[3];
    mutate(input);
    assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: false, requiredCheckNames: []});
  }
});

test('forced T0/T1 host-pending is artifact-driven while malformed limitation metadata is informational only for T2',()=>{
  for(const status of ['completed','unverified']){
    const input=hostCandidateFixture();input.value.status=status;
    input.value.deliverable.checks=[{name:'worker check',outcome:'unverified',evidence:'No explanation wording required.'}];
    assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost:true}),{eligible:true,requiredCheckNames:['worker check']});
  }
  for(const metadata of [null,'not-canonical']){
    const input=hostCandidateFixture();input.value.deliverable.checks=[{name:'worker check',outcome:'unverified',evidence:'not explicit host language',executionLimitation:metadata}];
    assert.deepEqual(evaluateHostVerificationCandidate(input),{eligible:false,requiredCheckNames:[]});
    assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost:true}),{eligible:true,requiredCheckNames:['worker check']});
  }
  const recovered=hostCandidateFixture();recovered.raw.toolErrors=1;recovered.raw.unrecoveredErrors=0;
  assert.deepEqual(evaluateHostVerificationCandidate({...recovered,forceHost:true}),{eligible:true,requiredCheckNames:['npm test','static inspection']});
  for(const raw of [{toolErrors:1},{toolErrors:1,unrecoveredErrors:1}]){
    const failed=hostCandidateFixture();Object.assign(failed.raw,raw);
    assert.deepEqual(evaluateHostVerificationCandidate({...failed,forceHost:true}),{eligible:false,requiredCheckNames:[]});
  }
});

test('forceHost qualifies fully passed worker checks only with the trusted patch proof', () => {
  const input=hostCandidateFixture();
  input.value.deliverable.checks[0]={name:'npm test',outcome:'passed',evidence:'Worker reports tests passed.'};
  assert.deepEqual(evaluateHostVerificationCandidate(input),{eligible:false,requiredCheckNames:[]});
  assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost:true}),{eligible:true,requiredCheckNames:['npm test','static inspection']});
  const completedPassed={...input,forceHost:true,value:{...input.value,status:'completed'}};
  assert.deepEqual(evaluateHostVerificationCandidate(completedPassed),{eligible:true,requiredCheckNames:['npm test','static inspection']});
  const blockedPassed={...completedPassed,value:{...completedPassed.value,status:'blocked'}};
  assert.deepEqual(evaluateHostVerificationCandidate(blockedPassed),{eligible:false,requiredCheckNames:[]});
  const single={...input,forceHost:true,value:{...input.value,deliverable:{...input.value.deliverable,checks:[{name:'npm test',outcome:'passed',evidence:'claimed passed'}]}}};
  assert.deepEqual(evaluateHostVerificationCandidate(single),{eligible:true,requiredCheckNames:['npm test']});
  const missing={...input,forceHost:true,value:{...input.value,deliverable:{...input.value.deliverable,checks:[]}}};
  assert.deepEqual(evaluateHostVerificationCandidate(missing),{eligible:false,requiredCheckNames:[]});
  const failed={...input,forceHost:true,value:{...input.value,deliverable:{...input.value.deliverable,checks:[{name:'npm test',outcome:'failed',evidence:'failed'}]}}};
  assert.deepEqual(evaluateHostVerificationCandidate(failed),{eligible:false,requiredCheckNames:[]});
  assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost:true,patchProof:{...input.patchProof,patchSha256:'c'.repeat(64)}}),{eligible:false,requiredCheckNames:[]});
});

test('rejects mismatched request, patch, scope, changed files, route, and WSL cleanup', () => {
  const mutations = [
    x => { x.task.requestId = 'foreign'; },
    x => { x.raw.requestId = 'foreign'; },
    x => { x.raw.patchValidation.requestId = 'foreign'; },
    x => { x.raw.patchValidation.ok = false; },
    x => { x.patchProof.requestId = 'foreign'; },
    x => { x.patchProof.jobId = '223e4567-e89b-42d3-a456-426614174000'; },
    x => { x.raw.patchValidation.scopeSha256 = 'c'.repeat(64); },
    x => { x.patchProof.scopeSha256 = 'c'.repeat(64); },
    x => { x.value.changedFiles = ['src/other.js']; },
    x => { x.raw.patchValidation.changedFiles = ['src/other.js']; },
    x => { x.patchProof.changedFiles = ['src/other.js']; },
    x => { x.raw.patch = ''; },
    x => { x.raw.patch += 'tampered'; },
    x => { x.raw.provider = 'other'; },
    x => { x.raw.requestedModel = 'other-model'; },
    x => { x.raw.cleanup = {ok: false}; },
    x => { x.raw.cleanup = undefined; },
  ];
  for (const mutate of mutations) {
    const input = hostCandidateFixture();
    mutate(input);
    assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: false, requiredCheckNames: []});
  }
});

test('rejects unrelated failure, bad checks, malformed evidence, and unbound host verification', () => {
  const mutations = [
    x => { x.access = 'read'; },
    x => { x.task.role = 'Netzach'; },
    x => { x.value.status = 'failed'; },
    x => { x.value.result = ''; },
    x => { x.value.evidence = []; },
    x => { x.value.errors = ['unrelated failure']; },
    x => { x.value.deliverable.checks[0].evidence = 'Unable to verify'; },
    x => { x.value.deliverable.checks[0].outcome = 'failed'; },
    x => { x.value.deliverable.checks.push({...x.value.deliverable.checks[0]}); },
    x => { x.value.deliverable.checks[0].name = ''; },
    x => { x.value.deliverable.checks = [{name: 'lint', outcome: 'passed', evidence: 'clean'}]; },
    x => { x.raw.exitCode = 1; },
    x => { x.raw.failure = 'authentication failure'; x.raw.ok = false; },
    x => { x.raw.failureCode = 'PI_AUTH_EXPIRED'; x.raw.ok = false; },
    x => { x.raw.timeout = true; x.raw.ok = false; },
    x => { x.raw.routeMismatch = true; },
    x => { x.raw.truncated = true; },
    x => { x.raw.ok = false; },
    x => { x.patchProof.trusted = false; },
  ];
  for (const mutate of mutations) {
    const input = hostCandidateFixture();
    mutate(input);
    assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: false, requiredCheckNames: []});
  }
});

test('allows a specifically attested recoverable file-tool failure only for non-forced T2 admission', () => {
  const input = hostCandidateFixture();
  input.raw.ok = false;
  input.raw.failure = 'Tool execution failed';
  input.raw.recoverableToolFailure = true;
  input.raw.recoverableFileToolFailure = true;
  input.raw.toolErrors = 2;
  input.raw.unrecoveredErrors = 1;
  input.raw.fileToolErrors = 1;
  input.raw.unrecoveredFileToolErrors = 1;
  input.value.errors = ['write tool failed for a transient file operation'];
  assert.deepEqual(evaluateHostVerificationCandidate(input), {eligible: true, requiredCheckNames: ['npm test']});
  assert.deepEqual(evaluateHostVerificationCandidate({...input,forceHost:true}), {eligible:false,requiredCheckNames:[]});

  for (const mutate of [
    x => { x.raw.recoverableFileToolFailure = false; },
    x => { x.raw.fileToolErrors = 0; },
    x => { x.raw.fileToolErrors = 2; },
    x => { x.raw.failure = 'sandbox failed'; },
    x => { x.value.errors = ['unrelated error']; },
    x => { x.value.errors.push('read tool failed too'); },
  ]) {
    const changed = hostCandidateFixture();
    changed.raw.ok = false;
    changed.raw.failure = 'Tool execution failed';
    changed.raw.recoverableToolFailure = true;
    changed.raw.recoverableFileToolFailure = true;
    changed.raw.toolErrors = 2;
    changed.raw.unrecoveredErrors = 1;
    changed.raw.fileToolErrors = 1;
    changed.raw.unrecoveredFileToolErrors = 1;
    changed.value.errors = ['write tool failed for a transient file operation'];
    mutate(changed);
    assert.deepEqual(evaluateHostVerificationCandidate(changed), {eligible: false, requiredCheckNames: []});
  }
});
