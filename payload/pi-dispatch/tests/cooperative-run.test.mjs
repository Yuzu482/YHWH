import test from 'node:test';
import assert from 'node:assert/strict';
import { planCooperativeRun } from '../scripts/cooperative-run.mjs';

const base = (cwd = '/workspace') => ({
  cwd, parentRunId: 'parent-1', runGoal: 'Complete the run', runAcceptance: ['All units finish'],
  units: [
    { id: 'alpha', objective: 'Do alpha', acceptance: ['Alpha done'], context: ['alpha-only'], readScope: ['src/a'], writeScope: ['out/a'] },
    { id: 'beta', objective: 'Do beta', acceptance: ['Beta done'], context: ['beta-only'], readScope: ['src/b'], writeScope: ['out/b'] },
  ],
});

test('defaults omitted thinking to medium', () => {
  const plan = planCooperativeRun(base());

  assert.equal(plan.thinking, 'medium');
  assert.deepEqual(plan.requests.map((request) => request.thinking), ['medium', 'medium']);
});

test('supports explicit low and medium thinking', () => {
  assert.equal(planCooperativeRun({ ...base(), thinking: 'low' }).thinking, 'low');
  assert.equal(planCooperativeRun({ ...base(), thinking: 'medium' }).thinking, 'medium');
});

test('rejects invalid thinking with a TypeError', () => {
  assert.throws(() => planCooperativeRun({ ...base(), thinking: 'high' }), TypeError);
});

test('omitted and explicit medium thinking produce stable run and request IDs', () => {
  const omitted = planCooperativeRun(base());
  const explicit = planCooperativeRun({ ...base(), thinking: 'medium' });

  assert.equal(omitted.runAnchor, explicit.runAnchor);
  assert.deepEqual(omitted.requests.map((request) => request.requestId), explicit.requests.map((request) => request.requestId));
});

test('low and medium thinking produce distinct run and request IDs', () => {
  const low = planCooperativeRun({ ...base(), thinking: 'low' });
  const medium = planCooperativeRun({ ...base(), thinking: 'medium' });

  assert.notEqual(low.runAnchor, medium.runAnchor);
  assert.notDeepEqual(low.requests.map((request) => request.requestId), medium.requests.map((request) => request.requestId));
});

test('supports Windows and POSIX cwd', () => {
  for (const cwd of ['/workspace/project', 'C:\\work\\project']) {
    assert.equal(planCooperativeRun(base(cwd)).requests[0].cwd, cwd);
  }
});

test('shares run identity while preserving unit-only context and access', () => {
  const { runAnchor, requests } = planCooperativeRun(base());
  assert.equal(requests[0].parentRunId, requests[1].parentRunId);
  assert.match(runAnchor, /^cooperative-[a-f0-9]{24}$/);
  assert.equal(requests[0].task.context[0], 'alpha-only');
  assert.equal(requests[1].task.context[0], 'beta-only');
  assert.ok(!requests[0].task.context.includes('beta-only'));
  assert.ok(!requests[1].task.context.includes('alpha-only'));
  assert.equal(requests[0].access, 'workspace-write');
  const readOnly = base();
  readOnly.units[0].writeScope = [];
  assert.equal(planCooperativeRun(readOnly).requests[0].access, 'read');
});

test('freezes nested request data and produces stable IDs', () => {
  const spec = base();
  const first = planCooperativeRun(spec);
  const second = planCooperativeRun(spec);
  assert.equal(first.runAnchor, second.runAnchor);
  assert.deepEqual(first.requests.map(r => r.requestId), second.requests.map(r => r.requestId));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.requests));
  for (const request of first.requests) {
    assert.ok(Object.isFrozen(request) && Object.isFrozen(request.task));
    for (const key of ['context', 'acceptance', 'readScope', 'writeScope']) assert.ok(Object.isFrozen(request.task[key]));
  }
});

test('rejects unsafe scope paths', () => {
  for (const path of ['../secret', 'src/*', '/etc/passwd']) {
    const spec = base(); spec.units[0].readScope = [path];
    assert.throws(() => planCooperativeRun(spec), TypeError);
  }
});

test('rejects duplicate IDs ignoring case, overlapping writes, invalid scope types, and long objectives', () => {
  let spec = base(); spec.units[1].id = 'ALPHA';
  assert.throws(() => planCooperativeRun(spec), TypeError);
  spec = base(); spec.units[1].writeScope = ['out/a/file'];
  assert.throws(() => planCooperativeRun(spec), TypeError);
  spec = base(); spec.units[0].readScope = 'src/a';
  assert.throws(() => planCooperativeRun(spec), TypeError);
  spec = base(); spec.units[0].writeScope = null;
  assert.throws(() => planCooperativeRun(spec), TypeError);
  spec = base(); spec.units[0].objective = 'x'.repeat(601);
  assert.throws(() => planCooperativeRun(spec), TypeError);
});
