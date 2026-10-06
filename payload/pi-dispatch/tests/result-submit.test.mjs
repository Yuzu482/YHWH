import test from 'node:test';
import assert from 'node:assert/strict';
import resultSubmit from '../extensions/result-submit.js';
import { roleValue } from './contract-fixtures.mjs';
import { validateRoleResult } from '../extensions/role-contract.js';

function setup(role) {
  const handlers = {};
  let tool;
  let ready = false;
  const flags = new Set();
  resultSubmit({
    getFlag(name) { return ready && name === 'yhwh-result-role' && flags.has(name) ? role : undefined; },
    registerFlag(name) { flags.add(name); },
    on(name, handler) { handlers[name] = handler; },
    registerTool(value) { tool = value; },
  });
  ready = true;
  return { handlers, tool };
}

const invoke = (tool, payload) => tool.execute('call-1', { payload });

test('submits canonical prefixed JSON and marks details for tool_execution_end', async () => {
  const { tool } = setup();
  const result = await invoke(tool, { status: 'completed', z: [1, true], a: { y: 'ok', b: null } });
  const canonicalText = 'KETHER_RESULT_JSON={"a":{"b":null,"y":"ok"},"status":"completed","z":[1,true]}';
  assert.deepEqual(result.content, [{ type: 'text', text: canonicalText }]);
  assert.deepEqual(result.details, { type: 'kether_result_submission', canonicalText });
});

test('rejects a second successful submission in the same turn and resets on next turn', async () => {
  const { handlers, tool } = setup();
  await invoke(tool, { ok: true });
  await assert.rejects(invoke(tool, { ok: false }), /RESULT_ALREADY_SUBMITTED/);
  handlers.agent_start();
  assert.equal((await invoke(tool, { ok: false })).details.canonicalText, 'KETHER_RESULT_JSON={"ok":false}');
});

test('role rejection is repairable and does not consume the success latch', async () => {
  const { tool } = setup('Chesed');
  const invalid = roleValue('Chesed');
  invalid.errors = ['failed'];
  const rejected = await invoke(tool, invalid);
  assert.deepEqual(rejected.details, { type: 'kether_result_rejection', code: 'RESULT_ROLE_SCHEMA_INVALID' });
  assert.equal(Object.hasOwn(rejected.details, 'canonicalText'), false);
  const invalidCheck = { ...invalid, status: 'failed', errors: [], uncertainty: ['Host test unavailable'], deliverable: { ...invalid.deliverable, checks: [{ name: 'tests', outcome: 'unknown', evidence: 'Host test unavailable', executionLimitation: { executor: 'host', reason: 'worker-execution-unavailable' } }] } };
  const failedRejected = await invoke(tool, invalidCheck);
  assert.equal(failedRejected.details.type, 'kether_result_rejection');
  const corrected = structuredClone(invalidCheck);
  corrected.status='completed';corrected.deliverable.checks[0].outcome='unverified';
  const accepted = await invoke(tool, corrected);
  assert.equal(accepted.details.type, 'kether_result_submission');
  await assert.rejects(invoke(tool, corrected), /RESULT_ALREADY_SUBMITTED/);
});

test('bounded optional Chesed limitation metadata is retained without changing worker status', async () => {
  for (const status of ['completed','unverified','failed','blocked']) for (const executionLimitation of [null,'explanation',{executor:'host',reason:'worker-execution-unavailable'},{executor:'other',reason:'informational'}]) {
    const {tool}=setup('Chesed');
    const value=roleValue('Chesed');value.status=status;
    value.deliverable.checks=[{name:'host tests',outcome:'unverified',evidence:'Host tests not run',executionLimitation}];
    const accepted=await invoke(tool,value);
    assert.equal(accepted.details.type,'kether_result_submission');
    assert.deepEqual(JSON.parse(accepted.details.canonicalText.slice('KETHER_RESULT_JSON='.length)),value);
    assert.equal(JSON.parse(accepted.details.canonicalText.slice('KETHER_RESULT_JSON='.length)).status,status);
  }
  const {tool}=setup('Chesed');
  const oversized=roleValue('Chesed');oversized.deliverable.checks[0].executionLimitation={detail:'x'.repeat(4097)};
  assert.equal((await invoke(tool,oversized)).details.type,'kether_result_rejection');
});

test('Netzach submits typed host references unchanged for authoritative gateway resolution', async () => {
  const { tool } = setup('Netzach');
  const value = roleValue('Netzach');
  const check = value.deliverable.checks[0];
  check.evidence = '';
  check.hostEvidence = { requestId:'fixture-host', artifactSha256:'a'.repeat(64), recordSha256:'b'.repeat(64), checkName:'fixture check' };
  const invalid = structuredClone(value);
  invalid.deliverable.checks[0].hostEvidence.recordSha256 = 'invalid';
  assert.equal((await invoke(tool, invalid)).details.type, 'kether_result_rejection');
  const accepted = await invoke(tool, value);
  assert.equal(accepted.details.type, 'kether_result_submission');
  assert.deepEqual(JSON.parse(accepted.details.canonicalText.slice('KETHER_RESULT_JSON='.length)), value);
  assert.equal(validateRoleResult(value, 'Netzach').ok, false);
  assert.equal(validateRoleResult(value, 'Netzach', { hostEvidenceResolver:()=>({ok:false,code:'HOST_EVIDENCE_UNRESOLVED'}) }).ok, false);
});

test('rejects malformed and non-JSON-safe payloads deterministically', async () => {
  const { tool } = setup();
  for (const payload of [null, [], 'text', { value: undefined }, { value: NaN }, { get value() { return 1; } }]) {
    await assert.rejects(invoke(tool, payload), /RESULT_/);
  }
  await assert.rejects(tool.execute('call-2', {}), /RESULT_ARGUMENT_INVALID/);
});

test('rejects oversize payload and produces stable key-sorted output', async () => {
  const { tool } = setup();
  await assert.rejects(invoke(tool, { text: 'x'.repeat(512 * 1024) }), /RESULT_(?:STRING_TOO_LARGE|TOO_LARGE)/);
  assert.equal((await invoke(tool, { z: 1, a: 2 })).details.canonicalText, 'KETHER_RESULT_JSON={"a":2,"z":1}');
});
