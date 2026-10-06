import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewAttemptLedger, reviewBlockers, REVIEW_QUOTA_POLICY } from '../scripts/tier-review-policy.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workspaceSha256 = 'a'.repeat(64);
const runAnchorSha256 = 'b'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const repeat = character => character.repeat(64);
const input = (requestId, stage = 'pre-review', tier = 'T2', extra = {}) => ({ workspaceSha256, runAnchorSha256, stage, tier, requestId, ...extra });
const postReview = (requestId, material, artifact, host, extra = {}, tier = 'T1') => input(requestId, 'post-review', tier, {
  materialDigest: repeat(material), artifactDigest: repeat(artifact), hostRecordDigest: repeat(host), ...extra,
});
const errorCode = code => error => error.code === code;
const emptyDecision = reviewDecision => ({ reviewDecision, findings: [], missingMaterials: [] });
const blockerDecision = (description = 'Correct unsafe behavior in src/plan.mjs:27', evidence = 'See src/plan.mjs:27') => ({
  reviewDecision: 'request-changes',
  findings: [{ severity: 'high', description, evidence }],
  missingMaterials: [],
});
const citeClosure = (decision, previousReviewRequestId, paths, evidence = 'Corrected and verified') => ({
  version: 1,
  previousReviewRequestId,
  closures: [{ key: reviewBlockers(decision)[0].key, paths, evidence }],
});
const progressFor = (decision, previous, paths, evidence) => citeClosure(decision, previous, paths, evidence);
const expectQuotaDenied = (operation, code = 'PI_REVIEW_LIMIT_EXCEEDED') => assert.throws(operation, errorCode(code));
const stateFile = directory => join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name)));
const loadState = directory => JSON.parse(readFileSync(stateFile(directory), 'utf8'));
const saveState = (directory, state) => writeFileSync(stateFile(directory), JSON.stringify(state));
function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'tier-review-policy-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function complete(ledger, request, decision = emptyDecision('approve')) {
  ledger.markStarted(request);
  ledger.finish(request, { started: true, outcome: 'complete', executionMs: 1000 });
  ledger.recordDecision(request, decision);
}

 test('T2 permits two per stage across instances/restart and request IDs, then fails closed', () => withDirectory(directory => {
  const first = createReviewAttemptLedger(directory), second = createReviewAttemptLedger(directory);
  const a = first.reserve(input('one'));
  complete(first, a, emptyDecision('request-changes'));
  const b = second.reserve(input('two'));
  complete(second, b, emptyDecision('request-changes'));
  assert.notEqual(a.attemptId, b.attemptId);
  assert.throws(() => first.reserve(input('three')), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  assert.throws(() => createReviewAttemptLedger(directory).reserve(input('four')), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  assert.equal(second.reserve(input('one')).replayed, true);
  assert.equal(first.reserve(input('post', 'post-review')).replayed, false);
}));

test('T1 post-review has one base slot; tier changes cannot enlarge a same-key budget', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('t1', 'post-review', 'T1'));
  complete(ledger, ticket);
  assert.throws(() => ledger.reserve(input('t2', 'post-review', 'T2')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.reserve(input('t2', 'post-review', 'T1')), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  assert.equal(ticket.replayed, false);
}));

test('zero-execution release retains request identity while another ID may claim slot and time', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('cancelled', 'post-review', 'T1'));
  assert.equal(ledger.finish(ticket, { started: false, outcome: 'not-started' }).status, 'released');
  assert.equal(ledger.reserve(input('cancelled', 'post-review', 'T1')).replayed, true);
  const next = ledger.reserve(input('new-attempt', 'post-review', 'T1'));
  assert.equal(next.replayed, false);
  assert.equal(ledger.markStarted(next).status, 'started');
  assert.throws(() => ledger.finish(next, { started: false, outcome: 'not-started' }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.equal(ledger.finish(next, { started: true, outcome: 'timeout', executionMs: 10 }).status, 'finished');
  assert.equal(ledger.finish(next, { started: true, outcome: 'timeout', executionMs: 10 }).status, 'finished');
}));

test('pending reservation after restart consumes its slot conservatively', () => withDirectory(directory => {
  const ticket = createReviewAttemptLedger(directory).reserve(input('pending', 'post-review', 'T1'));
  assert.equal(createReviewAttemptLedger(directory).reserve(input('pending', 'post-review', 'T1')).replayed, true);
  assert.throws(() => createReviewAttemptLedger(directory).reserve(input('retry', 'post-review', 'T1')),
    error => errorCode('PI_REVIEW_ATTEMPTS_INVALID')(error) && error.message.includes(ticket.attemptId));
  assert.equal(createReviewAttemptLedger(directory).snapshot(input('inspect', 'post-review', 'T1')).timeUsedMs, 600000);
}));

test('corrupt state and malformed input fail closed', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  ledger.reserve(input('first'));
  const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json')));
  writeFileSync(file, '{');
  assert.throws(() => ledger.reserve(input('second')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.reserve({ ...input('bad'), extra: true }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.reserve(input('t0', 'pre-review', 'T0')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
}));

test('cross-process reservations contend for exactly one final slot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tier-review-process-race-'));
  try {
    const ledger = createReviewAttemptLedger(directory);
    const first = ledger.reserve(input('occupied-one'));
    complete(ledger, first, emptyDecision('request-changes'));
    const script = `import {createReviewAttemptLedger} from ${JSON.stringify(new URL('../scripts/tier-review-policy.mjs', import.meta.url).href)}; try { createReviewAttemptLedger(process.argv[1]).reserve({workspaceSha256:'${workspaceSha256}',runAnchorSha256:'${runAnchorSha256}',stage:'pre-review',tier:'T2',requestId:process.argv[2]}); console.log('reserved'); } catch(e) { console.log(e.code); }`;
    const invoke = id => execFileAsync(process.execPath, ['--input-type=module', '-e', script, directory, id]);
    const outcomes = await Promise.all([invoke('process-a'), invoke('process-b')]);
    assert.equal(outcomes.filter(item => item.stdout.trim() === 'reserved').length, 1);
    assert.equal(outcomes.filter(item => item.stdout.trim() === 'PI_REVIEW_LIMIT_EXCEEDED' || item.stdout.trim() === 'PI_REVIEW_ATTEMPTS_INVALID').length, 1);
    assert.equal(ledger.snapshot(input('inspect')).attempts.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('blocker keys normalize case, whitespace, and line numbers; explicit nonblocking findings are excluded', () => {
  const first = {
    reviewDecision: 'request-changes',
    findings: [
      { severity: 'HIGH', description: 'Fix unsafe   branch in src/a.mjs:12', evidence: 'Check src/a.mjs:12' },
      { severity: 'medium', description: 'Optional note', evidence: '', blocking: false },
    ],
    missingMaterials: [],
  };
  const second = {
    ...first,
    findings: [{ severity: 'high', description: 'fix unsafe branch in SRC/A.MJS:99', evidence: 'Checked SRC/A.MJS:99' }, first.findings[1]],
  };
  assert.deepEqual(reviewBlockers(first), reviewBlockers(second));
  assert.equal(reviewBlockers(first).length, 1);
});

test('T1 extension requires trusted blocker correction and conditional closure; approval closes unchanged review', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const material = '1'.repeat(64), artifact = '2'.repeat(64), host = '3'.repeat(64);
  const finding = blockerDecision();
  const first = ledger.reserve(input('base', 'post-review', 'T1', { materialDigest: material, artifactDigest: artifact, hostRecordDigest: host }));
  complete(ledger, first, finding);
  const altered = blockerDecision('Correct   unsafe behavior in SRC/PLAN.MJS:99', 'See SRC/PLAN.MJS:99');
  assert.equal(reviewBlockers(finding)[0].key, reviewBlockers(altered)[0].key);
  assert.throws(() => ledger.reserve(input('forged', 'post-review', 'T1', {
    materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64), hostRecordDigest: host, changedPaths: ['src/plan.mjs'],
    progress: { version: 1, previousReviewRequestId: 'base', closures: [{ key: reviewBlockers(finding)[0].key, paths: ['src/plan.mjs'], evidence: 'Fixed' }] },
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  const extra = ledger.reserve(input('extra', 'post-review', 'T1', {
    materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64), hostRecordDigest: '6'.repeat(64), changedPaths: ['src/plan.mjs'],
    progress: { version: 1, previousReviewRequestId: 'base', closures: [{ key: reviewBlockers(finding)[0].key, paths: ['src/plan.mjs'], evidence: 'Corrected and verified' }] },
  }));
  assert.equal(extra.timeoutSeconds, 599);
  complete(ledger, extra, emptyDecision('conditional-approve'));
  assert.throws(() => ledger.reserve(input('unchanged', 'post-review', 'T1', { materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64) })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('PRE extension needs actual changed material sections and closes cited section/path', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const initialSections = { 'plan/review.md': '1'.repeat(64), scope: '2'.repeat(64), context: '3'.repeat(64) };
  const finding = blockerDecision('Fix section Scope in plan/review.md:12', 'See section Scope and plan/review.md:12');
  const initialFinding = { ...finding, findings: [...finding.findings, { severity: 'medium', description: 'Fix section Context in plan/review.md:40', evidence: 'See section Context and plan/review.md:40' }] };
  const first = ledger.reserve(input('pre-one', 'pre-review', 'T2', { materialDigest: '4'.repeat(64), materialSections: initialSections }));
  complete(ledger, first, initialFinding);
  const second = ledger.reserve(input('pre-two', 'pre-review', 'T2', { materialDigest: '5'.repeat(64), materialSections: initialSections }));
  complete(ledger, second, finding);
  const progress = {
    version: 1, previousReviewRequestId: 'pre-two',
    closures: [{ key: reviewBlockers(finding)[0].key, paths: ['scope', 'plan/review.md'], evidence: 'Updated the cited plan section.' }],
  };
  assert.throws(() => ledger.reserve(input('pre-unchanged-sections', 'pre-review', 'T2', {
    materialDigest: '6'.repeat(64), materialSections: initialSections, changedPaths: ['scope', 'plan/review.md'], progress,
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  assert.throws(() => ledger.reserve(input('pre-missing-sections', 'pre-review', 'T2', {
    materialDigest: '6'.repeat(64), changedPaths: ['scope', 'plan/review.md'], progress,
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  const changedSections = { ...initialSections, scope: '7'.repeat(64), 'plan/review.md': '8'.repeat(64) };
  assert.throws(() => ledger.reserve(input('pre-unrelated-section', 'pre-review', 'T2', {
    materialDigest: '6'.repeat(64), materialSections: changedSections,
    progress: { version: 1, previousReviewRequestId: 'pre-two', closures: [{ key: reviewBlockers(finding)[0].key, paths: ['scope', 'unrelated'], evidence: 'Changed another section' }] },
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  const third = ledger.reserve(input('pre-three', 'pre-review', 'T2', { materialDigest: '6'.repeat(64), materialSections: changedSections, progress }));
  assert.equal(third.replayed, false);
  assert.equal(ledger.snapshot(input('inspect')).attempts[2].extension, true);
}));

test('T2 has five real executions: two base per stage and only one shared extension', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const preSections = { 'plan/scope.md': '1'.repeat(64) };
  const preFinding = blockerDecision('Fix plan/scope.md:1', 'See plan/scope.md:1');
  const preInitialFinding = { ...preFinding, findings: [...preFinding.findings, { severity: 'medium', description: 'Fix another section plan/scope.md:20', evidence: 'See plan/scope.md:20' }] };
  for (const [index, id] of ['pre-a', 'pre-b'].entries()) {
    const ticket = ledger.reserve(input(id, 'pre-review', 'T2', { materialDigest: id === 'pre-a' ? '2'.repeat(64) : '3'.repeat(64), materialSections: preSections }));
    complete(ledger, ticket, index === 0 ? preInitialFinding : preFinding);
  }
  const postFinding = blockerDecision('Fix src/host.mjs:2', 'See src/host.mjs:2');
  for (const [index, id] of ['post-a', 'post-b'].entries()) {
    const ticket = ledger.reserve(input(id, 'post-review', 'T2', {
      materialDigest: (index + 4).toString().repeat(64), artifactDigest: (index + 6).toString().repeat(64),
      hostRecordDigest: (index + 8).toString().repeat(64),
    }));
    complete(ledger, ticket, index === 0 ? { ...postFinding, findings: [...postFinding.findings, { severity: 'medium', description: 'Fix another file src/host.mjs:20', evidence: 'See src/host.mjs:20' }] } : postFinding);
  }
  const extension = ledger.reserve(input('post-extra', 'post-review', 'T2', {
    materialDigest: 'a'.repeat(64), artifactDigest: 'c'.repeat(64), hostRecordDigest: 'e'.repeat(64), changedPaths: ['src/host.mjs'],
    progress: { version: 1, previousReviewRequestId: 'post-b', closures: [{ key: reviewBlockers(postFinding)[0].key, paths: ['src/host.mjs'], evidence: 'Fixed and host verified' }] },
  }));
  complete(ledger, extension, emptyDecision('approve'));
  const state = ledger.snapshot(input('inspect'));
  assert.equal(state.attempts.filter(attempt => attempt.status === 'finished').length, 5);
  assert.equal(state.attempts.filter(attempt => attempt.extension).length, 1);
  assert.equal(state.extensionUsed, true);
  assert.throws(() => ledger.reserve(input('second-stage-extra', 'pre-review', 'T2', {
    materialDigest: 'f'.repeat(64), materialSections: { 'plan/scope.md': '9'.repeat(64) },
    progress: { version: 1, previousReviewRequestId: 'pre-b', closures: [{ key: reviewBlockers(preFinding)[0].key, paths: ['plan/scope.md'], evidence: 'Changed section' }] },
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('latest nonreleased undecided attempt prevents skipping older progress evidence', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const finding = blockerDecision();
  const first = ledger.reserve(input('review-one', 'pre-review', 'T2', { materialDigest: '1'.repeat(64) }));
  complete(ledger, first, finding);
  const second = ledger.reserve(input('review-two', 'pre-review', 'T2', { materialDigest: '2'.repeat(64) }));
  ledger.markStarted(second);
  ledger.finish(second, { started: true, outcome: 'done', executionMs: 10 });
  const progress = { version: 1, previousReviewRequestId: 'review-one', closures: [{ key: reviewBlockers(finding)[0].key, paths: ['src/plan.mjs'], evidence: 'Fixed and verified' }] };
  assert.throws(() => ledger.reserve(input('review-three', 'pre-review', 'T2', {
    materialDigest: '3'.repeat(64), changedPaths: ['src/plan.mjs'], progress,
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('two stalled blocker decisions stop retry even when the proposed closure looks valid', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory), finding = blockerDecision();
  const extraFinding = { severity: 'medium', description: 'Fix src/other.mjs:9', evidence: 'See src/other.mjs:9' };
  const largerFinding = { ...finding, findings: [...finding.findings, extraFinding] };
  const sections = { 'src/plan.mjs': '1'.repeat(64), 'src/other.mjs': '2'.repeat(64) };
  for (const [index, id] of ['stall-one', 'stall-two'].entries()) {
    const ticket = ledger.reserve(input(id, 'pre-review', 'T2', { materialDigest: (index + 2).toString().repeat(64), materialSections: sections }));
    complete(ledger, ticket, index === 0 ? finding : largerFinding);
  }
  const progress = {
    version: 1, previousReviewRequestId: 'stall-two',
    closures: reviewBlockers(largerFinding).map(blocker => ({ key: blocker.key, paths: blocker.paths, evidence: 'Changed and checked' })),
  };
  assert.throws(() => ledger.reserve(input('stall-three', 'pre-review', 'T2', {
    materialDigest: '4'.repeat(64), materialSections: { 'src/plan.mjs': '5'.repeat(64), 'src/other.mjs': '6'.repeat(64) },
    changedPaths: ['src/plan.mjs', 'src/other.mjs'], progress,
  })), error => errorCode('PI_REVIEW_LIMIT_EXCEEDED')(error) && error.message.includes('non-progress'));
}));

test('released zero-launch attempt grants no repair credit and does not count as execution', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory), finding = blockerDecision();
  const first = ledger.reserve(postReview('zero-base', '1', '2', '3'));
  complete(ledger, first, finding);
  const ext = ledger.reserve(postReview('zero-extension', '4', '5', '6', {
    changedPaths: ['src/plan.mjs'], progress: progressFor(finding, 'zero-base', ['src/plan.mjs'], 'Corrected'),
  }));
  ledger.finish(ext, { started: false, outcome: 'not-launched' });
  assert.equal(ledger.snapshot(input('inspect', 'post-review', 'T1')).attempts.filter(attempt => attempt.status !== 'released').length, 1);
  assert.equal(ledger.snapshot(input('inspect', 'post-review', 'T1')).extensionUsed, false);
}));

test('missing-material closure is normalized and unrelated paths/sections are rejected', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const missing = { reviewDecision: 'insufficient-materials', findings: [], missingMaterials: ['Host evidence from src/host.mjs:18'] };
  const first = ledger.reserve(postReview('missing-one', '1', '2', '3'));
  complete(ledger, first, missing);
  const key = reviewBlockers(missing)[0].key;
  const makeProgress = paths => ({ version: 1, previousReviewRequestId: 'missing-one', closures: [{ key, paths, evidence: 'Added current host evidence' }] });
  assert.throws(() => ledger.reserve(input('bad-path', 'post-review', 'T1', {
    materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64), hostRecordDigest: '6'.repeat(64), changedPaths: ['docs/unrelated.md'],
    progress: makeProgress(['docs/unrelated.md']),
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  const good = ledger.reserve(input('good-path', 'post-review', 'T1', {
    materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64), hostRecordDigest: '6'.repeat(64), changedPaths: ['src/host.mjs'],
    progress: makeProgress(['src/host.mjs']),
  }));
  assert.equal(good.replayed, false);
}));

test('shared quota policy is deeply frozen and approval preserves nonblocking informational findings', () => withDirectory(directory => {
  assert.equal(Object.isFrozen(REVIEW_QUOTA_POLICY), true);
  assert.equal(Object.isFrozen(REVIEW_QUOTA_POLICY.T1), true);
  assert.equal(Object.isFrozen(REVIEW_QUOTA_POLICY.T2), true);
  assert.throws(() => { REVIEW_QUOTA_POLICY.T1.base = 99; }, TypeError);
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('informational-approval'));
  complete(ledger, ticket, { reviewDecision: 'approve', findings: [{ severity: 'info', description: 'Reference note', evidence: 'No action required' }], missingMaterials: [] });
  assert.equal(ledger.snapshot(input('inspect')).decisions['informational-approval'].decision.reviewDecision, 'approve');
}));

test('decision persistence rejects malformed shapes and approval blockers', () => withDirectory(directory => { 
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('decision-shape'));
  ledger.markStarted(ticket);
  ledger.finish(ticket, { started: true, outcome: 'done', executionMs: 10 });
  assert.throws(() => ledger.recordDecision(ticket, { ...emptyDecision('request-changes'), extra: true }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.recordDecision(ticket, { reviewDecision: 'insufficient-materials', findings: [], missingMaterials: [] }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.recordDecision(ticket, { reviewDecision: 'approve', findings: [{ severity: 'high', description: 'Block', evidence: '', blocking: true }], missingMaterials: [] }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.throws(() => ledger.recordDecision(ticket, { reviewDecision: 'request-changes', findings: [{ severity: 'high', description: 'Block', evidence: '', paths: ['src/a'] }], missingMaterials: [] }), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  ledger.recordDecision(ticket, emptyDecision('approve'));
}));

test('one relevant cited path suffices when a blocker cites multiple changed files', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const decision = blockerDecision('Correct issue in src/a.mjs:1 and src/b.mjs:2', 'See src/a.mjs:1 and src/b.mjs:2');
  const first = ledger.reserve(postReview('multi-path', '1', '2', '3'));
  complete(ledger, first, decision);
  const next = ledger.reserve(input('single-relevant-path', 'post-review', 'T1', {
    materialDigest: '4'.repeat(64), artifactDigest: '5'.repeat(64), hostRecordDigest: '6'.repeat(64), changedPaths: ['src/a.mjs'],
    progress: progressFor(decision, 'multi-path', ['src/a.mjs'], 'Fixed cited file and verified'),
  }));
  assert.equal(next.replayed, false);
}));

test('approved POST artifact cannot be re-reviewed after packet digest changes', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(postReview('post-approved', '1', '2', '3'));
  complete(ledger, ticket);
  assert.throws(() => ledger.reserve(input('changed-packet-same-artifact', 'post-review', 'T1', { materialDigest: '4'.repeat(64), artifactDigest: '2'.repeat(64), hostRecordDigest: '3'.repeat(64) })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('approval of unchanged content closes review; changed content is base-only', () => withDirectory(directory => { 
  const ledger = createReviewAttemptLedger(directory);
  const approved = ledger.reserve(input('approved', 'post-review', 'T2', { materialDigest: '1'.repeat(64), artifactDigest: '2'.repeat(64) }));
  complete(ledger, approved, emptyDecision('approve'));
  assert.throws(() => ledger.reserve(input('same-approved', 'post-review', 'T2', { materialDigest: '1'.repeat(64), artifactDigest: '2'.repeat(64) })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
  const changed = ledger.reserve(input('changed-after-approval', 'post-review', 'T2', { materialDigest: '3'.repeat(64), artifactDigest: '4'.repeat(64) }));
  complete(ledger, changed, blockerDecision());
  assert.throws(() => ledger.reserve(input('no-approved-extension', 'post-review', 'T2', {
    materialDigest: '5'.repeat(64), artifactDigest: '6'.repeat(64), hostRecordDigest: '7'.repeat(64), changedPaths: ['src/plan.mjs'],
    progress: progressFor(blockerDecision(), 'changed-after-approval', ['src/plan.mjs'], 'Fixed'),
  })), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('base attempt persists verified progress for later stall comparison', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory), finding = blockerDecision();
  const sections = { 'src/plan.mjs': '1'.repeat(64) };
  const first = ledger.reserve(input('base-progress-one', 'pre-review', 'T2', { materialDigest: '2'.repeat(64), materialSections: sections }));
  complete(ledger, first, finding);
  const second = ledger.reserve(input('base-progress-two', 'pre-review', 'T2', {
    materialDigest: '3'.repeat(64), materialSections: { 'src/plan.mjs': '4'.repeat(64) },
    progress: progressFor(finding, 'base-progress-one', ['src/plan.mjs'], 'Changed actual section'),
  }));
  assert.equal(ledger.snapshot(input('inspect')).attempts[1].progressVerified, true);
}));

test('reserved time bounds timeout; confirmed zero releases, unknown and overrun execution are charged', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const zero = ledger.reserve(input('zero-time', 'post-review', 'T1'));
  assert.equal(ledger.snapshot(input('inspect', 'post-review', 'T1')).timeUsedMs, 600000);
  ledger.finish(zero, { started: false, outcome: 'not-launched' });
  const unknown = ledger.reserve(input('unknown-time', 'post-review', 'T1'));
  ledger.markStarted(unknown);
  ledger.finish(unknown, { started: true, outcome: 'uncertain', executionKnown: false });
  assert.equal(createReviewAttemptLedger(directory).snapshot(input('inspect', 'post-review', 'T1')).timeUsedMs, 600000);
  const snapshot = ledger.snapshot(input('inspect', 'post-review', 'T1'));
  assert.equal(snapshot.attempts[1].timeKnown, false);
  assert.throws(() => ledger.reserve(input('out-of-time', 'post-review', 'T1')), errorCode('PI_REVIEW_LIMIT_EXCEEDED'));
}));

test('execution overrun is charged in full and prevents another admission', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('overrun', 'post-review', 'T1'));
  ledger.markStarted(ticket);
  ledger.finish(ticket, { started: true, outcome: 'complete', executionMs: 700000 });
  assert.equal(ledger.snapshot(input('inspect', 'post-review', 'T1')).timeUsedMs, 700000);
  expectQuotaDenied(() => ledger.reserve(input('after-overrun', 'post-review', 'T1')));
}));

test('forged persisted T1 pre-review attempt is rejected during state validation', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('forged-pre', 'post-review', 'T1'));
  const state = loadState(directory);
  state.attempts[0].stage = 'pre-review';
  saveState(directory, state);
  assert.throws(() => createReviewAttemptLedger(directory).snapshot(input('inspect', 'post-review', 'T1')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  assert.equal(ticket.stage, 'post-review');
}));

test('migration preserves v2 counters when optional progress fields were absent', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const ticket = ledger.reserve(input('old-v2'));
  const state = loadState(directory);
  delete state.attempts[0].materialSections;
  delete state.attempts[0].progressVerified;
  delete state.attempts[0].legacyImportDigest;
  saveState(directory, state);
  const snapshot = createReviewAttemptLedger(directory).snapshot(input('inspect'));
  assert.equal(snapshot.attempts[0].attemptId, ticket.attemptId);
  assert.equal(snapshot.attempts[0].reservedMs, 900000);
  assert.deepEqual(snapshot.attempts[0].materialSections, {});
  assert.equal(snapshot.attempts[0].progressVerified, false);
}));

function legacyFile(directory, stage, attempts, tier = 'T2') {
  const identity = { workspaceSha256, runAnchorSha256, tier, stage };
  const key = digest(JSON.stringify({ workspaceSha256, runAnchorSha256, stage }));
  const requests = Object.fromEntries(attempts.map(attempt => [attempt.requestId, attempt.attemptId]));
  writeFileSync(join(directory, `${key}.json`), JSON.stringify({ version: 1, key, identity, attempts, requests }));
}
const oldAttempt = (requestId, attemptId = `${requestId}-id`) => ({ attemptId, requestId, status: 'finished', started: true, outcome: 'done' });

test('both legacy stages import idempotently across restart and late old-runtime writes', () => withDirectory(directory => {
  legacyFile(directory, 'pre-review', [oldAttempt('legacy-pre')]);
  legacyFile(directory, 'post-review', [oldAttempt('legacy-post')]);
  let ledger = createReviewAttemptLedger(directory);
  let snapshot = ledger.snapshot(input('inspect'));
  assert.equal(snapshot.attempts.length, 2);
  assert.equal(snapshot.timeUsedMs, 1800000);
  assert.ok(snapshot.attempts.every(attempt => attempt.timeKnown === false && attempt.parentRunId === null && attempt.materialSections));
  ledger = createReviewAttemptLedger(directory);
  assert.equal(ledger.snapshot(input('inspect')).attempts.length, 2);
  legacyFile(directory, 'post-review', [oldAttempt('legacy-post'), oldAttempt('late-old-write')]);
  snapshot = createReviewAttemptLedger(directory).snapshot(input('inspect'));
  assert.equal(snapshot.attempts.length, 3);
  assert.equal(snapshot.attempts.filter(attempt => attempt.requestId === 'late-old-write').length, 1);
}));

test('legacy mutation, corrupt indexes, and pending records fail closed', () => withDirectory(directory => {
  legacyFile(directory, 'pre-review', [oldAttempt('legacy')]);
  const ledger = createReviewAttemptLedger(directory);
  ledger.snapshot(input('inspect'));
  legacyFile(directory, 'pre-review', [{ ...oldAttempt('legacy'), outcome: 'mutated' }]);
  assert.throws(() => createReviewAttemptLedger(directory).snapshot(input('inspect')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));

  const other = mkdtempSync(join(tmpdir(), 'tier-review-legacy-index-'));
  try {
    legacyFile(other, 'pre-review', [oldAttempt('indexed')]);
    const file = join(other, readdirSync(other).find(name => name.endsWith('.json')));
    const state = JSON.parse(readFileSync(file, 'utf8'));
    state.requests = {};
    writeFileSync(file, JSON.stringify(state));
    assert.throws(() => createReviewAttemptLedger(other).snapshot(input('inspect')), errorCode('PI_REVIEW_ATTEMPTS_INVALID'));
  } finally { rmSync(other, { recursive: true, force: true }); }

  const pendingDir = mkdtempSync(join(tmpdir(), 'tier-review-legacy-pending-'));
  try {
    legacyFile(pendingDir, 'pre-review', [{ attemptId: 'pending-id', requestId: 'pending-old', status: 'started', started: true, outcome: null }]);
    assert.throws(() => createReviewAttemptLedger(pendingDir).snapshot(input('inspect')), error => errorCode('PI_REVIEW_ATTEMPTS_INVALID')(error) && error.message.includes('pending-id'));
  } finally { rmSync(pendingDir, { recursive: true, force: true }); }
}));

test('duplicate request ID cannot create another launch ticket', () => withDirectory(directory => {
  const ledger = createReviewAttemptLedger(directory);
  const original = ledger.reserve(input('same'));
  const replay = ledger.reserve(input('same'));
  assert.equal(replay.attemptId, original.attemptId);
  assert.equal(replay.replayed, true);
  assert.equal(Object.isFrozen(replay), true);
  assert.equal(JSON.parse(readFileSync(join(directory, readdirSync(directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))), 'utf8')).attempts.length, 1);
}));
