// SPDX-License-Identifier: Apache-2.0
// YHWH patch logic is Apache-2.0; upstream matching excerpts retain pi-lsp-extension's declared MIT license.
// Original package: pi-lsp-extension 1.3.0, gitHead 5edc932d325b630483f84f7d7f038e88ceba1eba.
// See licenses/pi-lsp-extension-evidence.json and its notice for the pending upstream attribution.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Usage: node patch-pi-lsp.mjs <pi-lsp-extension-root>');

// Governed installations must never execute commands or Java agents from a repo.
for (const [file, before, after] of [
  ['index.ts', 'projectConfig = loadProjectConfig(ctx.cwd);', 'projectConfig = null; // KETHER: untrusted project executable config disabled'],
  ['lsp-manager.ts', 'findLombokJar(): string | null {', 'findLombokJar(): string | null {\n    return null; // KETHER: project Java agents disabled'],
]) {
  const path = join(root, 'src', file);
  let source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  if (!source.includes(after)) {
    if (!source.includes(before)) throw new Error(`Unsupported security patch layout: ${file}`);
    source = source.replace(before, after);
    writeFileSync(path, source);
  }
}

function recordPatchNotice(mode) {
  writeFileSync(join(root,'YHWH-PATCH-NOTICE.txt'),`Modified locally by YHWH contributors. Patch mode: ${mode}.\nUpstream: pi-lsp-extension 1.3.0, https://github.com/samfoy/pi-lsp-extension\nOriginal gitHead: 5edc932d325b630483f84f7d7f038e88ceba1eba\nUpstream declares MIT; complete upstream copyright notice remains pending.\nChanges: disable repository executable configuration and Lombok discovery;\nfull mode also adds hidden Windows subprocesses and C/C++/C# server entries.\nThis notice does not relicense upstream code or invent upstream attribution.\n`);
}
if (process.argv.includes('--security-only')) { recordPatchNotice('security-only'); process.exit(0); }

function patch(file, changes) {
  const path = join(root, 'src', file);
  let text = readFileSync(path, 'utf8');
  for (const change of changes) {
    if (text.includes(change.present)) continue;
    if (!text.includes(change.before)) throw new Error(`Unsupported pi-lsp-extension layout: ${file}`);
    text = text.replace(change.before, change.after);
  }
  writeFileSync(path, text, 'utf8');
}

patch('lsp-client.ts', [{
  present: 'cwd: this.rootDir,\n      windowsHide:',
  before: 'cwd: this.rootDir,\n    });',
  after: 'cwd: this.rootDir,\n      windowsHide: process.platform === "win32",\n    });',
}]);

patch('lsp-daemon.ts', [{
  present: 'env: process.env,\n    windowsHide:',
  before: 'env: process.env,\n  });',
  after: 'env: process.env,\n    windowsHide: process.platform === "win32",\n  });',
}]);

patch('lsp-manager.ts', [
  {
    present: 'csharp: { command: "csharp-ls"',
    before: 'java: { command: "jdtls", args: [] },',
    after: 'java: { command: "jdtls", args: [] },\n  c: { command: "clangd", args: [] },\n  cpp: { command: "clangd", args: [] },\n  csharp: { command: "csharp-ls", args: [] },',
  },
  {
    present: 'stdio: "ignore",\n        windowsHide:',
    before: 'stdio: "ignore",\n      },',
    after: 'stdio: "ignore",\n        windowsHide: process.platform === "win32",\n      },',
  },
]);

recordPatchNotice('full');
