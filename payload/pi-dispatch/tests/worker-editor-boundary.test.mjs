import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiArgs } from '../scripts/dispatch.mjs';

const request = {
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  access: 'none',
  thinking: 'max',
};
const editorProxy = '/opt/pi-kether/extensions/editor-proxy.js';

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function extensions(args) {
  return args.flatMap((arg, index) => arg === '--extension' ? [args[index + 1]] : []);
}

test('editor authorization grants only the editor tool for none access', () => {
  const args = buildPiArgs(request, 'wsl2', true);
  const tools = flagValue(args, '--tools').split(',');
  const extensionArgs = extensions(args);

  assert.deepEqual(tools, ['pi_editor_execute']);
  assert.ok(extensionArgs.includes(editorProxy));
  assert.equal(extensionArgs.some((extension) => /read|write|lsp-proxy|legacy/i.test(extension)), false);
  assert.equal(args.includes('--no-tools'), false);
});

test('none access without editor authorization disables tools', () => {
  const args = buildPiArgs(request, 'wsl2', false);

  assert.ok(args.includes('--no-tools'));
  assert.equal(args.includes('--tools'), false);
  assert.equal(extensions(args).includes(editorProxy), false);
});
