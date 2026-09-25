import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPiArgs, summarize } from '../scripts/dispatch.mjs';
import { compileKetherTask } from '../extensions/kether-envelope.js';

const request = { target: 'model', provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', rolePresetId: 'Chesed' };
const assistant = { type: 'message_end', message: { role: 'assistant', provider: request.provider, model: request.model, stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } };
const end = { type: 'agent_end' };
const resultEvent = (details, toolName = 'yhwh_submit_result') => ({ type: 'tool_execution_end', toolName, result: { details } });
const canonicalText = 'KETHER_RESULT_JSON={"evidence":["observed"],"result":"done","status":"completed"}';
const details = { type: 'kether_result_submission', canonicalText };
const raw = (...events) => ({ exitCode: 0, stderr: '', stdout: events.map(event => JSON.stringify(event)).join('\n') });

test('structured result tool is explicit, WSL-only, and role-ceiling bounded', () => {
  const args = buildPiArgs(request, 'wsl2', false, true);
  assert.ok(args.includes('/opt/pi-kether/extensions/result-submit.js'));
  assert.ok(args[args.indexOf('--tools') + 1].split(',').includes('yhwh_submit_result'));
  assert.throws(() => buildPiArgs(request, 'host', false, true), /Role presets require WSL2/);
  assert.throws(() => buildPiArgs({ ...request, access: 'none' }, 'wsl2', false, true), /requires WSL2|Role presets require WSL2/);
  const legacy = buildPiArgs(request, 'wsl2');
  assert.ok(!legacy.includes('/opt/pi-kether/extensions/result-submit.js'));
  assert.ok(!legacy[legacy.indexOf('--tools') + 1].split(',').includes('yhwh_submit_result'));
});

test('structured result prompt requests schema payload only when opted in', () => {
  const task = { role: 'Chesed', objective: 'Do work', acceptance: ['Report result'] };
  const enabled = compileKetherTask(task, { structuredResultTool: true });
  assert.match(enabled, /Call yhwh_submit_result exactly once/);
  assert.match(enabled, /short final acknowledgement/);
  const legacy = compileKetherTask(task);
  assert.doesNotMatch(legacy, /Call yhwh_submit_result/);
  assert.match(legacy, /Return exactly one line: KETHER_RESULT_JSON=/);
});

test('summarize accepts one canonical marked tool event, never assistant text', () => {
  const submission = summarize(raw(resultEvent(details), assistant, end), { ...request, resultSubmissionRequired: true }).resultSubmission;
  assert.deepEqual(submission, { ok: true, canonicalText });
  const spoof = summarize(raw({ ...assistant, message: { ...assistant.message, content: [{ type: 'text', text: canonicalText }] } }, end), { ...request, resultSubmissionRequired: true }).resultSubmission;
  assert.deepEqual(spoof, { ok: false, code: 'RESULT_SUBMISSION_MISSING' });
  const otherTool = summarize(raw(resultEvent(details, 'some_other_tool'), assistant, end), { ...request, resultSubmissionRequired: true }).resultSubmission;
  assert.deepEqual(otherTool, { ok: false, code: 'RESULT_SUBMISSION_MISSING' });
});

test('summarize fails closed on malformed or multiple result events without payload metadata', () => {
  assert.deepEqual(summarize(raw(resultEvent({ type: 'wrong', canonicalText: 'private payload' }), assistant, end), { ...request, resultSubmissionRequired: true }).resultSubmission, { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' });
  assert.deepEqual(summarize(raw(resultEvent(details), resultEvent(details), assistant, end), { ...request, resultSubmissionRequired: true }).resultSubmission, { ok: false, code: 'RESULT_SUBMISSION_MULTIPLE' });
  assert.deepEqual(summarize(raw(resultEvent({ type: 'kether_result_submission', canonicalText: 'KETHER_RESULT_JSON={"b":1,"a":2}' }), assistant, end), { ...request, resultSubmissionRequired: true }).resultSubmission, { ok: false, code: 'RESULT_SUBMISSION_MALFORMED' });
});
