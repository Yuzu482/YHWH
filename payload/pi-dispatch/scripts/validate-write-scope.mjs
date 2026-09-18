import { readFileSync } from 'node:fs';
import { validateUnifiedPatch } from '../extensions/write-scope-guard.js';

const [scopeFile, patchFile, baseline, workspace] = process.argv.slice(2);
if (!scopeFile || !patchFile || !baseline || !workspace) throw new Error('scope file, patch file, baseline, and workspace are required');
const scope = JSON.parse(readFileSync(scopeFile, 'utf8'));
const patch = readFileSync(patchFile, 'utf8');
const changedFiles = validateUnifiedPatch(patch, scope, baseline, workspace);
process.stdout.write(JSON.stringify({ ok: true, changedFiles }));
