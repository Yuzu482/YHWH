import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectMemory, projectFiles as safe } from './project-memory.mjs';
import { affectedFiles } from './code-graph.mjs';

export async function changeImpact({ cwd, baseline = 'HEAD' }) {
  if (baseline !== 'HEAD' && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseline)) throw Error('invalid_baseline');
  const ctx = await safe.context(cwd);
  const changed = new Set(); let excluded = 0;
  const groups = [
    await safe.git(ctx, ['diff', '--name-only', '-z', '--no-renames', baseline, '--']),
    await safe.git(ctx, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--']),
    await safe.git(ctx, ['ls-files', '--others', '--exclude-standard', '-z']),
  ];
  for (const p of groups.flatMap(s => s.split('\0').filter(Boolean))) {
    try { safe.sourcePath(p); changed.add(p); } catch { excluded++; }
  }
  if (changed.size > 512) throw Error('change_impact_limit');
  const graph = await affectedFiles(cwd, [...changed]);
  const affected = new Set([...changed, ...graph.files]);
  const memory = await projectMemory({ cwd, action: 'review' });
  const knowledge = memory.entries.filter(e => e.status !== 'deprecated').map(e => ({ id: e.id, title: e.title,
    freshness: e.freshness, affectedSources: e.sources.filter(s => affected.has(s.path)).map(s => s.path) })).filter(e => e.affectedSources.length);
  const tests = [...affected].filter(p => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
  return { schemaVersion: 1, readOnly: true, modelCalls: 0, baseline, changedFiles: [...changed].sort(), excluded,
    graph, knowledgeCandidates: knowledge, testCandidates: tests.sort(), memoryErrors: memory.errors,
    requiresReview: true, note: 'Candidates only. No tests are executed, no knowledge is promoted, no index is refreshed and no Git state is changed.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await changeImpact({ cwd: process.argv[2], baseline: process.argv[3] || 'HEAD' }), null, 2)); }
  catch { console.log('{"status":"failed","reason":"change_impact_input_or_source_error"}'); process.exitCode = 1; }
}
