import test from 'node:test';
import assert from 'node:assert/strict';
import rolePresetsExtension, { ROLE_PRESETS as EXTENSION_ROLE_PRESETS, resolveSelectedPreset } from '../extensions/role-presets.js';
import { ROLE_PRESETS as HOST_ROLE_PRESETS } from '../scripts/role-presets.mjs';

test('extension registry matches the host registry exactly', () => {
  assert.deepEqual(Object.keys(EXTENSION_ROLE_PRESETS).sort(), Object.keys(HOST_ROLE_PRESETS).sort());
  for (const [id, preset] of Object.entries(HOST_ROLE_PRESETS)) {
    assert.deepEqual(EXTENSION_ROLE_PRESETS[id], { id: preset.id, purpose: preset.purpose });
  }
});

test('extension accepts every exact canonical role and rejects missing or unknown values', () => {
  for (const [id, preset] of Object.entries(EXTENSION_ROLE_PRESETS)) assert.equal(resolveSelectedPreset(id), preset);
  assert.throws(() => resolveSelectedPreset(undefined), /requires one of/);
  assert.throws(() => resolveSelectedPreset('worker'), /requires one of/);
  assert.throws(() => resolveSelectedPreset('unknown'), /requires one of/);
});

test('extension registers flag, validates at startup, and appends only the selected bounded role card', () => {
  const handlers = {};
  let registered;
  let flag;
  const pi = {
    registerFlag(name, options) { registered = [name, options]; },
    getFlag(name) { assert.equal(name, 'yhwh-role-preset'); return flag; },
    on(name, handler) { handlers[name] = handler; },
  };
  rolePresetsExtension(pi);
  assert.equal(registered[0], 'yhwh-role-preset');
  assert.deepEqual(registered[1], { type: 'string', description: 'Select a canonical Kether role preset' });
  assert.throws(() => handlers.session_start(), /requires one of/);
  const original = 'Existing system prompt';
  for (const id of Object.keys(EXTENSION_ROLE_PRESETS)) {
    flag = id;
    assert.equal(handlers.session_start(), undefined);
    const result = handlers.before_agent_start({ systemPrompt: original });
    assert.ok(result.systemPrompt.startsWith(`${original}\n\n`));
    assert.match(result.systemPrompt, new RegExp(`Kether role card \\(${id}\\):`));
    for (const other of Object.keys(EXTENSION_ROLE_PRESETS).filter(role => role !== id)) {
      assert.doesNotMatch(result.systemPrompt, new RegExp(`Kether role card \\(${other}\\):`));
    }
    const card = result.systemPrompt.slice(result.systemPrompt.indexOf('Kether role card'));
    assert.ok(card.length < 600, `${id} card is not bounded`);
    assert.match(card, /host-authorized scope/);
    assert.match(result.systemPrompt, /one line starting KETHER_RESULT_JSON=/);
    assert.match(result.systemPrompt, /followed by one RESULT_SCHEMA_JSON object/);
    assert.match(result.systemPrompt, /No preamble/);
    assert.deepEqual(Object.keys(result), ['systemPrompt']);
  }
});
