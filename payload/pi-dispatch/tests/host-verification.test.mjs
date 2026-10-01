import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostPending, createHostAttestation, verifyHostPending, verifyHostAttestation, hostRecordDigest, hostSubmissionDigest, HostVerificationError} from '../extensions/host-verification.js';

const hex = n => String(n).repeat(64);
function pending(overrides = {}) { return createHostPending({requestId:'req-1', artifactSha256:hex('a'), resultSha256:hex('b'), workspace:'/tmp/work', parentRunId:'parent-1', goal:'test objective', phase:1, requiredCheckNames:['focused tests','build'], ...overrides}); }
const commands = [
  {checkName:'build', command:'npm run build', exitCode:0, outputSummary:'build ok'},
  {checkName:'focused tests', command:'node --test', exitCode:0, outputSummary:'tests ok'},
];

test('pending binding is canonical, immutable, sanitized, and integrity checked', () => {
  const first = pending();
  const reordered = createHostPending({phase:1, requiredCheckNames:['focused tests','build'], goal:'test objective', parentRunId:'parent-1', workspace:'/tmp/work', resultSha256:hex('b'), artifactSha256:hex('a'), requestId:'req-1'});
  assert.equal(first.pendingSha256, reordered.pendingSha256);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(verifyHostPending(first), true);
  assert.equal(verifyHostPending({...first, goal:'tampered'}), false);

  const withoutTemplate = createHostPending({requestId:'req-1', artifactSha256:hex('a'), resultSha256:hex('b'), workspace:'/tmp/work', parentRunId:null, goal:'test objective', phase:1, requiredCheckNames:['focused tests','build']});
  assert.equal(Object.hasOwn(withoutTemplate, 'contractTemplateSha256'), false);
  assert.equal(verifyHostPending(withoutTemplate), true);
  const withoutTemplateAttestation = createHostAttestation(withoutTemplate, {requestId:withoutTemplate.requestId, artifactSha256:withoutTemplate.artifactSha256, commands});
  assert.equal(verifyHostAttestation(withoutTemplateAttestation, withoutTemplate), true);

  const withTemplate = pending({contractTemplateSha256:hex('c')});
  assert.equal(withTemplate.contractTemplateSha256, hex('c'));
  const withTemplateAttestation = createHostAttestation(withTemplate, {requestId:withTemplate.requestId, artifactSha256:withTemplate.artifactSha256, commands});
  assert.equal(verifyHostPending(withTemplate), true);
  assert.equal(verifyHostAttestation(withTemplateAttestation, withTemplate), true);
  assert.throws(() => pending({contractTemplateSha256:'invalid'}), /invalid_binding/);
  assert.equal(verifyHostPending({...withTemplate, contractTemplateSha256:hex('d')}), false);
});

test('complete attestation derives outcome, sanitizes evidence, and verifies binding', () => {
  const p = pending();
  const record = createHostAttestation(p, {requestId:p.requestId, artifactSha256:p.artifactSha256, commands:commands.map(c => ({...c, outputSummary: c.checkName === 'build' ? 'api_key=[REDACTED] nested {"apiKey":"[REDACTED]"}' : c.outputSummary}))});
  assert.equal(record.outcome, 'completed');
  assert.equal(record.commands[0].checkName, 'focused tests');
  assert.doesNotMatch(JSON.stringify(record), /FAKE_SECRET|FAKE_NESTED_SECRET/);
  assert.equal(verifyHostAttestation(record, p), true);
  assert.equal(verifyHostAttestation({...record, outcome:'failed'}, p), false);
  const failed = createHostAttestation(p, {requestId:p.requestId, artifactSha256:p.artifactSha256, commands:commands.map(c => c.checkName === 'build' ? {...c, exitCode:2} : c)});
  assert.equal(failed.outcome, 'failed');
  assert.equal(verifyHostAttestation(failed, p), true);
});

test('strict coverage, fields, bounds, and binding reject malformed host submissions', () => {
  const p = pending();
  const submit = value => createHostAttestation(p, value);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, commands:[]}), HostVerificationError);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, commands:commands.slice(0,1)}), /incomplete_checks/);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, outcome:'completed', commands}), /invalid_submission/);
  assert.throws(() => submit({requestId:'foreign', artifactSha256:p.artifactSha256, commands}), /binding_mismatch/);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, commands:[...commands,{...commands[0]}]}), /incomplete_checks/);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, commands:commands.map(c => c.checkName === 'build' ? {...c, checkName:'other'} : c)}), /unknown_or_duplicate_check/);
  assert.throws(() => submit({requestId:p.requestId, artifactSha256:p.artifactSha256, commands:commands.map(c => ({...c, exitCode:1.5}))}), /invalid_exit_code/);
});

test('pending bounds, nullable standalone parent, own fields, and strict strings are enforced', () => {
  assert.equal(pending({parentRunId:null}).parentRunId, null);
  assert.equal(pending({goal:'g'.repeat(20000), workspace:'w'.repeat(4096)}).goal.length, 20000);
  assert.throws(() => pending({parentRunId:''}), /invalid_binding/);
  assert.throws(() => pending({goal:'g'.repeat(20001)}), /invalid_binding/);
  assert.throws(() => pending({workspace:'w'.repeat(4097)}), /invalid_binding/);
  for (const phase of ['implementing', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => pending({phase}), /invalid_binding/);
  for (const value of ['   ', 'bad\0text']) assert.throws(() => pending({goal:value}), /invalid_binding/);
  const inherited = Object.assign(Object.create({requestId:'req-1'}), {artifactSha256:hex('a'), resultSha256:hex('b'), workspace:'/tmp', parentRunId:null, goal:'ok', phase:1, requiredCheckNames:['check']});
  assert.throws(() => createHostPending(inherited), /invalid_pending/);
  assert.throws(() => createHostPending({...pending(), unexpected:true}), /invalid_pending/);
});

test('host records accept bounded Windows exit codes and reject tampered bindings', () => {
  const p = pending({requiredCheckNames:['windows']});
  const base = {requestId:p.requestId, artifactSha256:p.artifactSha256, commands:[{checkName:'windows', command:'cmd /c exit 1', exitCode:4294967295, outputSummary:'failed'}]};
  assert.equal(createHostAttestation(p, base).outcome, 'failed');
  for (const exitCode of [-2147483649, 4294967296, 1.25]) assert.throws(() => createHostAttestation(p, {...base, commands:[{...base.commands[0], exitCode}]}), /invalid_exit_code/);
  assert.equal(verifyHostAttestation({...createHostAttestation(p, base), workspace:'tampered'}, p), false);
  const inherited = Object.assign(Object.create({requestId:p.requestId}), {artifactSha256:p.artifactSha256, commands:base.commands});
  assert.throws(() => createHostAttestation(p, inherited), /invalid_submission/);
  assert.throws(() => createHostAttestation(p, {...base, extra:1}), /invalid_submission/);
});

test('digest is deterministic and timestamp is not part of submission identity', () => {
  const p = pending();
  const submission = {requestId:p.requestId, artifactSha256:p.artifactSha256, commands};
  assert.equal(hostSubmissionDigest(submission), hostSubmissionDigest(JSON.parse(JSON.stringify(submission))));
  assert.equal(hostRecordDigest({z:1,a:2}), hostRecordDigest({a:2,z:1}));
  assert.notEqual(createHostAttestation(p, submission, {timestamp:1}).recordSha256, createHostAttestation(p, submission, {timestamp:2}).recordSha256);
});
