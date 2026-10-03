import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRoleWorkerTaskPrompt, compileWorkerTaskPrompt } from '../scripts/task-packet-guidance.mjs';
import { validateRoleResult } from '../extensions/role-contract.js';
import { roleValue } from './contract-fixtures.mjs';

const packet = {
  contractVersion: 2, role: 'Chochmah', objective: 'plan implementation', context: ['source evidence'],
  readScope: ['src/a.js'], writeScope: [], fixtureScope: [], forbidden: [], dependencies: [],
  acceptance: ['Provide a justified plan'],
  returnFields: ['status','result','evidence','changedFiles','assumptions','uncertainty','errors','nextAction','deliverable'],
  assumptions: [],
};

test('compiled worker task carries stage and exact-file guidance without changing caller or compiled data', () => {
  const before = structuredClone(packet);
  const upstreamResults = [{ role: 'Hod', result: 'Observed assessment' }];
  const upstreamBefore = structuredClone(upstreamResults);
  const prompt = compileRoleWorkerTaskPrompt(packet, 'read', { upstreamResults });
  assert.match(prompt, /TASK_PACKET_JSON=/);
  assert.match(prompt, /future implementation or test checks.*unrun/);
  assert.match(prompt, /read\(\{path: exactScopePath\}\)/);
  assert.match(prompt, /Optional directory-search backends may be unavailable/);
  const compiledPacket = JSON.parse(prompt.match(/TASK_PACKET_JSON=(\{[^\n]+\})/)[1]);
  assert.deepEqual(compiledPacket.context, packet.context);
  assert.deepEqual(compiledPacket.readScope, packet.readScope);
  assert.deepEqual(compiledPacket.acceptance, packet.acceptance);
  assert.deepEqual(JSON.parse(prompt.match(/UPSTREAM_RESULTS_JSON=(\[[^\n]+\])/)[1]), upstreamResults);
  assert.deepEqual(packet, before);
  assert.deepEqual(upstreamResults, upstreamBefore);

  for (const role of ['Yesod','Binah','Hod','Malkuth','Chochmah','Chesed','Netzach']) {
    const eligible = { ...packet, role };
    assert.match(compileRoleWorkerTaskPrompt(eligible, 'workspace-write'), /Stage completion:/);
  }
});

test('real role validation accepts completed planning with later checks explicitly unrun, but rejects missing plan evidence and unrun verification', () => {
  const plan = roleValue('Chochmah');
  plan.uncertainty = ['Host-owned implementation tests remain unrun.'];
  plan.deliverable.verification = ['Host runs implementation tests; currently unrun.'];
  assert.equal(validateRoleResult(plan, 'Chochmah').ok, true);

  const missing = roleValue('Chochmah');
  missing.deliverable.steps = [];
  assert.equal(validateRoleResult(missing, 'Chochmah').ok, false);

  const verification = roleValue('Netzach');
  verification.deliverable.verdict = 'unverified';
  verification.deliverable.checks[0].outcome = 'unverified';
  assert.equal(validateRoleResult(verification, 'Netzach').ok, false);
});

test('reviewer, probe-like roles, none access, and unscoped workers receive no exact-file guidance', () => {
  for (const [role, access, scope] of [
    ['Geburah', 'none', []], ['reviewer', 'none', []], ['Netzach-probe', 'read', ['a.js']],
    ['Chesed', 'none', ['a.js']],
  ]) {
    assert.equal(compileWorkerTaskPrompt('', { ...packet, role, readScope: scope }, access), '');
  }
  const unscoped = compileWorkerTaskPrompt('', { ...packet, role: 'Chesed', readScope: [] }, 'read');
  assert.match(unscoped, /Stage completion:/);
  assert.doesNotMatch(unscoped, /Exact-file read scope:/);
  const broad = compileWorkerTaskPrompt('', { ...packet, role: 'Chesed', readScope: ['src/**'] }, 'read');
  assert.match(broad, /Stage completion:/);
  assert.doesNotMatch(broad, /Exact-file read scope:/);
});