import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPiArgs } from '../scripts/dispatch.mjs';

const requestBase = {
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  thinking: 'max',
};
const editorProxy = '/opt/pi-kether/extensions/editor-proxy.js';
const fixtureUserProfile = '/tmp/pi-dispatch-editor-access-matrix-userprofile';
const readTools = ['read', 'grep', 'find', 'ls'];
const wslLspTools = [
  'yhwh_lsp_diagnostics',
  'yhwh_lsp_hover',
  'yhwh_lsp_definition',
  'yhwh_lsp_references',
  'yhwh_lsp_symbols',
  'yhwh_lsp_completions',
  'yhwh_lsp_code_actions',
];

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function extensions(args) {
  return args.flatMap((arg, index) => arg === '--extension' ? [args[index + 1]] : []);
}

function withFixtureUserProfile(callback) {
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = fixtureUserProfile;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  }
}

function expectedTools(access, editorAuthorized) {
  return [
    ...readTools,
    ...(access === 'workspace-write' ? ['edit', 'write'] : []),
    ...wslLspTools,
    ...(editorAuthorized ? ['pi_editor_execute'] : []),
  ];
}

function assertToolAndExtensionPolicy(args, access, editorAuthorized) {
  const tools = flagValue(args, '--tools').split(',');
  assert.equal(args.includes('--no-tools'), false);
  assert.equal(new Set(tools).size, tools.length);
  assert.deepEqual(tools, expectedTools(access, editorAuthorized));

  const extensionArgs = extensions(args);
  assert.equal(extensionArgs.includes(editorProxy), editorAuthorized);
  assert.equal(extensionArgs.some((extension) => extension.includes('pi-lsp-extension')), false);
}

for (const access of ['read', 'workspace-write']) {
  test(`WSL2 ${access} preserves file access with and without editor authorization`, () => {
    withFixtureUserProfile(() => {
      const request = { ...requestBase, access };
      const withoutEditor = buildPiArgs(request, 'wsl2', false);
      const withEditor = buildPiArgs(request, 'wsl2', true);

      assert.equal(flagValue(withoutEditor, '--provider'), 'openai-codex');
      assert.equal(flagValue(withoutEditor, '--model'), 'gpt-5.6-luna');
      assert.equal(flagValue(withoutEditor, '--thinking'), 'max');
      assertToolAndExtensionPolicy(withoutEditor, access, false);
      assertToolAndExtensionPolicy(withEditor, access, true);

      const baseTools = flagValue(withoutEditor, '--tools').split(',');
      const authorizedTools = flagValue(withEditor, '--tools').split(',');
      assert.deepEqual(authorizedTools.filter((tool) => !baseTools.includes(tool)), ['pi_editor_execute']);
      assert.deepEqual(baseTools.filter((tool) => !authorizedTools.includes(tool)), []);
    });
  });
}

test('rejects editor authorization for host runtime even with no file access', () => {
  withFixtureUserProfile(() => {
    assert.throws(
      () => buildPiArgs({ ...requestBase, access: 'none' }, 'host', true),
      /Editor proxy requires WSL openai-codex/,
    );
  });
});
