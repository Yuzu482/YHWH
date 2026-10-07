import { readFileSync } from 'node:fs';
import { sandboxPatchFiles } from './artifact-apply.mjs';

const [scopeFile, patchFile, baseline, workspace] = process.argv.slice(2);
if (!scopeFile || !patchFile || !baseline || !workspace) throw new Error('scope file, patch file, baseline, and workspace are required');
const scope = JSON.parse(readFileSync(scopeFile, 'utf8'));
const patch = readFileSync(patchFile, 'utf8');
const changedFiles = sandboxPatchFiles(patch, {writeScope:scope,baseline,workspace});
process.stdout.write(JSON.stringify({ ok: true, changedFiles }));
