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

if (process.argv.includes('--security-only')) process.exit(0);

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
