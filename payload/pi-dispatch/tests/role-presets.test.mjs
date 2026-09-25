import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_PRESETS, resolveRolePreset, validateRoleAccess } from '../scripts/role-presets.mjs';
import { buildPiArgs, validateKetherInvocation } from '../scripts/dispatch.mjs';

const expected = { Yesod: ['none'], Binah: ['none'], Malkuth: ['none','read'], Hod: ['none'], Chochmah: ['none','read'], Chesed: ['none','read','workspace-write'], Netzach: ['none','read'], Geburah: ['none'] };
test('static role registry covers canonical roles, aliases, access and ceilings', () => {
  assert.deepEqual(Object.keys(ROLE_PRESETS), Object.keys(expected));
  for (const [role, accesses] of Object.entries(expected)) {
    const preset = resolveRolePreset(role);
    assert.equal(preset.id, role);
    assert.ok(preset.purpose);
    assert.deepEqual([...preset.allowedAccess], accesses);
    for (const access of accesses) assert.ok(Array.isArray(preset.toolCeilings[access]));
  }
  for (const [alias, canonical] of Object.entries({ worker: 'Chesed', researcher: 'Malkuth', reviewer: 'Geburah' })) assert.equal(resolveRolePreset(alias).id, canonical);
  assert.throws(() => resolveRolePreset('unknown'), /not admitted/);
  assert.throws(() => validateRoleAccess('Malkuth', 'workspace-write'), /does not allow/);
  assert.equal(validateRoleAccess('Chochmah', 'read').id, 'Chochmah');
  assert.throws(() => validateRoleAccess('Chochmah', 'workspace-write'), /does not allow/);
});

test('gateway selects explicit role extension and enforces per-role tool ceilings', () => {
  const roleRequest = (role, access) => ({ provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'medium', access, rolePresetId: role });
  const args = buildPiArgs(roleRequest('Malkuth', 'read'), 'wsl2');
  assert.ok(args.includes('/opt/pi-kether/extensions/role-presets.js'));
  assert.equal(args[args.indexOf('--yhwh-role-preset') + 1], 'Malkuth');
  const malkuthTools = args[args.indexOf('--tools') + 1].split(',');
  assert.ok(malkuthTools.includes('read'));
  assert.ok(malkuthTools.includes('yhwh_lsp_diagnostics'));
  assert.ok(!malkuthTools.includes('edit'));
  const geburah = buildPiArgs(roleRequest('Geburah', 'none'), 'wsl2');
  assert.ok(geburah.includes('--no-tools'));
  const chesed = buildPiArgs(roleRequest('Chesed', 'workspace-write'), 'wsl2');
  const chesedTools = chesed[chesed.indexOf('--tools') + 1].split(',');
  assert.ok(chesedTools.includes('write'));
  assert.ok(!chesedTools.includes('code_rewrite'));
  assert.ok(!chesedTools.includes('bash'));
  for (const tool of ['read', 'grep', 'find', 'ls']) assert.ok(chesedTools.includes(tool));
  assert.ok(!chesedTools.includes('yhwh_lsp_diagnostics'));
  assert.ok(!chesedTools.some(tool => tool.startsWith('yhwh_lsp_') || tool.startsWith('lsp_')));
  assert.throws(() => buildPiArgs(roleRequest('forged', 'read'), 'wsl2'), /not admitted/);
  assert.throws(() => buildPiArgs(roleRequest('Malkuth', 'workspace-write'), 'wsl2'), /does not allow/);
});

test('gateway rejects role access escalation and attaches canonical preset identity', () => {
  const task = { role: 'researcher', objective: 'Inspect files', readScope: ['package.json'], acceptance: ['Report findings'] };
  const base = { cwd: process.cwd(), task };
  assert.equal(validateKetherInvocation({ ...base, access: 'read' }).request.rolePresetId, 'Malkuth');
  assert.throws(() => validateKetherInvocation({ ...base, access: 'workspace-write', task: { ...task, writeScope: ['package.json'] } }, true), /does not allow/);
  assert.throws(() => validateKetherInvocation({ ...base, task: { ...task, role: 'unknown' } }), /not admitted/);
});
