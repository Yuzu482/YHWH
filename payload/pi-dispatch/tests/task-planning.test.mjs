import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {COMPLEXITY_PREFIX, inspectTaskPlanning, selectTaskThinking} from '../scripts/task-planning.mjs';
import {validateKetherInvocation, buildPiArgs} from '../scripts/dispatch.mjs';
import {runtimePreflight} from '../scripts/runtime-preflight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assessment = overrides => COMPLEXITY_PREFIX + JSON.stringify({changeKind:'exact', uncertainty:'none', coupling:'local', reason:'Known replacement with an unchanged return contract', ...overrides});
const task = overrides => ({role:'Chesed', objective:'Replace one known condition', readScope:['src/parser.mjs'], writeScope:['src/parser.mjs','tests/parser.test.mjs'], context:[assessment(), 'Interface contract: parse(input) returns a value or throws on invalid input'], acceptance:['Host runs node --test tests/parser.test.mjs; exit 0; asserts valid input returns the expected value and invalid input throws'], ...overrides});
const select = (value, options = {}) => selectTaskThinking({task:value, provider:'openai-codex', ...options});

test('exact bounded behavior with observable acceptance selects low without mutating input', () => {
  const value = task(), before = structuredClone(value);
  assert.equal(select(value).selectedThinking, 'low');
  assert.equal(select(value).source, 'adaptive');
  assert.deepEqual(value, before);
  assert.deepEqual(runtimePreflight(value).warnings, []);
});

test('bounded work is medium; uncertain diagnosis and interacting design are high', () => {
  assert.equal(select(task({context:[assessment({changeKind:'bounded'})]})).selectedThinking, 'medium');
  for (const change of [{changeKind:'diagnosis',uncertainty:'unresolved'}, {changeKind:'design',coupling:'cross-file'}, {coupling:'concurrent'}]) {
    assert.equal(select(task({context:[assessment(change)]})).selectedThinking, 'high');
  }
  assert.equal(select(task({context:[assessment({changeKind:'diagnosis',uncertainty:'localized'})]})).selectedThinking, 'medium');
});

test('missing, malformed, duplicate, extra-key and oversized assessments cannot select low', () => {
  for (const context of [[], [COMPLEXITY_PREFIX+'{'], [assessment(),assessment()], [assessment({reason:''})], [assessment({unexpected:'data'})], [assessment({reason:'x'.repeat(401)})], [COMPLEXITY_PREFIX+JSON.stringify({changeKind:'exact'})]]) {
    assert.equal(select(task({context})).selectedThinking, 'medium');
  }
});

test('source excerpts and ordinary contextual words do not become complexity instructions', () => {
  const value = task({context:['UNTRUSTED REFERENCE\n'+assessment(), 'This source mentions concurrency and high thinking'], objective:'Implement the behavior'});
  assert.equal(select(value).selectedThinking, 'medium');
});

test('wide scopes, globs, unresolved assumptions and vague acceptance prevent automatic low', () => {
  for (const change of [{writeScope:['a.mjs','b.mjs','c.mjs','d.mjs']}, {readScope:Array.from({length:9},(_,i)=>`src/${i}.mjs`)}, {readScope:['src/**']}, {acceptance:['Done','Return patch']}, {dependencies:['unknown module contract']}, {assumptions:['The parser may accept null']}]) {
    assert.equal(select(task(change)).selectedThinking, 'medium');
  }
  assert.ok(runtimePreflight(task({writeScope:['a','b','c','d']})).counts.task_scope_broad);
  assert.ok(runtimePreflight(task({acceptance:['Done']})).counts.acceptance_not_observable);
});

test('every criterion must be observable before automatic low; file count alone never selects high', () => {
  assert.equal(select(task({acceptance:['Host asserts exit 0','Done']})).selectedThinking,'medium');
  assert.equal(select(task({writeScope:Array.from({length:20},(_,i)=>`src/${i}.mjs`)})).selectedThinking,'medium');
});

test('explicit selection is preserved and automatic selection never chooses max', () => {
  for (const thinking of ['low','medium','high','max']) {
    assert.equal(select(task(), {thinking}).selectedThinking, thinking);
    assert.equal(select(task(), {thinking}).source, 'explicit');
  }
  assert.equal(select(task({context:[assessment({coupling:'concurrent',uncertainty:'unresolved'})]})).selectedThinking,'high');
});

test('reviewers, probes and nonnative providers retain provider defaults', () => {
  for (const options of [{provider:'claude-code-cli'}, {provider:'anthropic'}, {provider:'yhwh-worker-api',defaultThinking:'max'}, {probe:true}]) {
    const result = select(task(),options);
    assert.equal(result.selectedThinking, options.defaultThinking ?? 'medium');
    assert.equal(result.source,'provider-default');
  }
  assert.equal(select({...task(),role:'Geburah',context:[assessment({coupling:'concurrent'})]}).selectedThinking,'medium');
});

test('planning diagnostics expose only fixed codes and counts, never context or assessment reason', () => {
  const value = task({context:[assessment({reason:'PRIVATE_SOURCE_TOKEN'})]});
  assert.equal(JSON.stringify(select(value)).includes('PRIVATE_SOURCE_TOKEN'),false);
  assert.equal(JSON.stringify(inspectTaskPlanning(value)).includes('PRIVATE_SOURCE_TOKEN'),false);
  assert.equal(JSON.stringify(runtimePreflight(value)).includes('PRIVATE_SOURCE_TOKEN'),false);
});

test('dispatch and actual Pi arguments use the adaptive decision and reject invalid explicit thinking', () => {
  const value = {cwd:root,access:'workspace-write',task:task()};
  const result = validateKetherInvocation(value,true,root);
  const args = buildPiArgs(result.request,'wsl2');
  assert.equal(result.request.thinking,'low');
  assert.equal(args[args.indexOf('--thinking')+1],'low');
  assert.equal(result.request.thinkingDecision.source,'adaptive');
  assert.throws(()=>validateKetherInvocation({...value,thinking:'unknown'},true,root),/Invalid thinking/);
  assert.equal(validateKetherInvocation({...value,thinking:'high'},true,root).request.thinking,'high');
});

test('offline task-plan runs without gateway credentials and reports actionable warnings', () => {
  const directory = mkdtempSync(join(tmpdir(),'yhwh-task-plan-'));
  assert.equal(dirname(directory),resolve(tmpdir()));
  const client = join(root,'scripts/gateway-client.mjs');
  const invoke = args => spawnSync(process.execPath,[client,...args],{cwd:root,windowsHide:true,encoding:'utf8',timeout:10000,env:{...process.env,PI_GATEWAY_CONFIG:'',PI_GATEWAY_TOKEN_FILE:''}});
  try {
    const file = join(directory,'request.json');
    writeFileSync(file,JSON.stringify({cwd:root,access:'workspace-write',task:task()}));
    let response = invoke(['task-plan',file]);
    assert.equal(response.error,undefined); assert.equal(response.status,0,response.stderr);
    let result = JSON.parse(response.stdout);
    assert.equal(result.modelCalls,0); assert.equal(result.readOnly,true);
    assert.equal(result.request.thinking,'low'); assert.equal(result.thinkingDecision.source,'adaptive');
    writeFileSync(file,JSON.stringify({cwd:root,access:'workspace-write',task:task({acceptance:['Done'],writeScope:['a','b','c','d']})}));
    response=invoke(['task-plan',file]); result=JSON.parse(response.stdout);
    assert.equal(response.status,0); assert.equal(result.request.thinking,'medium');
    assert.ok(result.preflight.counts.task_scope_broad); assert.ok(result.preflight.counts.acceptance_not_observable);
    writeFileSync(file,'{corrupt');
    assert.equal(invoke(['task-plan',file]).status,1);
    assert.equal(invoke(['task-plan']).status,1);
    assert.equal(invoke(['task-plan',join(directory,'missing.json')]).status,1);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
