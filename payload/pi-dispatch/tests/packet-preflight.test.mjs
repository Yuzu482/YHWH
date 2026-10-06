import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectPrimaryPacket} from '../scripts/runtime-preflight.mjs';
import {COMPLEXITY_PREFIX} from '../scripts/task-planning.mjs';
import {roleResultSchema} from '../extensions/role-contract.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assessment = COMPLEXITY_PREFIX + JSON.stringify({changeKind:'bounded',uncertainty:'localized',coupling:'cross-file',reason:'Two-module wiring with focused tests; medium.'});
const task = overrides => ({contractVersion:2,role:'Chesed',objective:'Implement a bounded behavior',readScope:['scripts/runtime-preflight.mjs'],writeScope:['scripts/runtime-preflight.mjs'],context:[assessment],acceptance:['Host asserts the expected result'],...overrides});

test('primary packet check rejects only supplied invalid assessment and explicit wrong role fields', () => {
  const valid = task(), before = structuredClone(valid);
  assert.deepEqual(inspectPrimaryPacket(valid), {ok:true,criticalCodes:[]});
  assert.deepEqual(valid,before);
  assert.deepEqual(inspectPrimaryPacket(task({context:[COMPLEXITY_PREFIX+'{']})), {ok:false,criticalCodes:['invalid_complexity_assessment']});
  assert.deepEqual(inspectPrimaryPacket(task({context:[assessment,assessment]})), {ok:false,criticalCodes:['invalid_complexity_assessment']});
  assert.deepEqual(inspectPrimaryPacket(task({returnFields:['status']})), {ok:false,criticalCodes:['role_fields_invalid']});
  assert.deepEqual(inspectPrimaryPacket(task({returnFields:roleResultSchema('Chesed').required})), {ok:true,criticalCodes:[]});
  assert.equal(inspectPrimaryPacket(task({context:[]})).ok,true);
  assert.equal(inspectPrimaryPacket(task({returnFields:undefined})).criticalCodes.includes('role_fields_invalid'),true);
  assert.equal(inspectPrimaryPacket(task({contractVersion:1,returnFields:['legacy']})).ok,true);
  assert.equal(JSON.stringify(inspectPrimaryPacket(task({context:[COMPLEXITY_PREFIX+JSON.stringify({reason:'PRIVATE_TOKEN'})]}))).includes('PRIVATE_TOKEN'),false);
});

test('offline task-plan reports deterministic closed packet errors and preserves valid advisory output', () => {
  const dir = mkdtempSync(join(tmpdir(),'yhwh-packet-check-'));
  const cli = join(root,'scripts/gateway-client.mjs');
  const invoke = value => {
    const file = join(dir,'request.json'); writeFileSync(file,JSON.stringify({cwd:root,access:'workspace-write',task:value}));
    return spawnSync(process.execPath,[cli,'task-plan',file],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,PI_GATEWAY_CONFIG:'',PI_GATEWAY_TOKEN_FILE:''}});
  };
  try {
    for (const [value,code] of [[task({context:[COMPLEXITY_PREFIX+'{']}),'invalid_complexity_assessment'],[task({context:[assessment,assessment]}),'invalid_complexity_assessment'],[task({returnFields:['status']}),'role_fields_invalid']]) {
      const result=invoke(value); assert.equal(result.status,1,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).packetCheck,{ok:false,criticalCodes:[code]});
      assert.equal(result.stderr,'');
    }
    const good=invoke(task({writeScope:['a','b','c','d'],acceptance:['Done']}));
    assert.equal(good.status,0,good.stderr);
    const output=JSON.parse(good.stdout);
    assert.deepEqual(output.packetCheck,{ok:true,criticalCodes:[]});
    assert.equal(output.modelCalls,0); assert.equal(output.readOnly,true);
    assert.ok(output.preflight.counts.task_scope_broad);
    assert.equal(invoke(task({context:[]})).status,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
