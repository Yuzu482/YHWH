import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {buildPiArgs,summarize} from '../scripts/dispatch.mjs';
import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {vectors,observe,normalizeRoots} from './fixtures/worker-runtime/cases.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),golden=JSON.parse(fs.readFileSync(new URL('./fixtures/worker-runtime/baseline.json',import.meta.url),'utf8'));

test('27 argument vectors preserve exact values after explicit installation-root relocation',t=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-golden-profile-')),lsp=path.join(profile,'.pi/agent/npm/node_modules/pi-lsp-extension/src/index.ts'),previous=process.env.USERPROFILE;
  fs.mkdirSync(path.dirname(lsp),{recursive:true});fs.writeFileSync(lsp,'// inert existence fixture\n');process.env.USERPROFILE=profile;
  t.after(()=>{if(previous===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=previous;assert.equal(path.dirname(profile),os.tmpdir());fs.rmSync(profile,{recursive:true,force:true});});
  for(const [i,v] of vectors.args.entries())assert.deepEqual(normalizeRoots(observe(()=>buildPiArgs(structuredClone(v.request),v.runtime,v.editor,v.structured)),root.replace(/[\\/]$/,''),profile),golden.source.args[i],v.name);
});
test('35 summary vectors preserve failure precedence, field absence, patch suppression and tool recovery',()=>{
  for(const [i,v] of vectors.summaries.entries())assert.deepEqual(observe(()=>summarize(structuredClone(v.raw),structuredClone(v.request))),golden.source.summaries[i],v.name);
});
test('five fixed-clock timelines preserve every progress frame, tail timing and null measurement',()=>{
  for(const [i,v] of vectors.timelines.entries()){
    const actual=observe(()=>{let tick=0;const progress=[],t=createExecutionTimeline({now:()=>++tick,onProgress:s=>progress.push(s)});for(const c of v.chunks)t.feed(c);t.close();t.cleaned(17);return {snapshot:t.snapshot(),progress};});
    assert.deepEqual(actual,golden.source.timelines[i],v.name);
  }
});
test('pre-change source and installed golden behavior agree after declared root relocation only',()=>assert.deepEqual(golden.source,golden.installed));
