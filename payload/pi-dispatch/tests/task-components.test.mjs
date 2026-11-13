import test from 'node:test';
import assert from 'node:assert/strict';
import {selectTaskComponents,withTaskComponents} from '../scripts/task-components.mjs';
import {requestDigest} from '../extensions/request-ledger.js';

const plan=components=>'TASK_COMPONENTS_JSON='+JSON.stringify({version:1,components});
const definitions=events=>[
  {id:'gitContext',create:({defer})=>{events.push('git-open');defer(async()=>events.push('git-close'));return {name:'git'};}},
  {id:'projectMemory',create:({defer})=>{events.push('memory-open');defer(async()=>events.push('memory-close'));return {name:'memory'};}},
];

test('primary selects only approved components; absent selection loads none',()=>{
  const task={role:'worker',context:['keep']};
  assert.deepEqual(selectTaskComponents(task),{task,selected:[],explicit:false});
  const selected=selectTaskComponents({...task,context:['keep',plan(['projectMemory','gitContext'])]});
  assert.deepEqual(selected.selected,['gitContext','projectMemory']);
  assert.deepEqual(selected.task.context,['keep']);
  assert.deepEqual(selectTaskComponents({...task,context:[plan([])]}).selected,[]);
});

test('unrecognized, duplicate, or malformed control is rejected before activation',()=>{
  for(const context of [
    [plan(['audit'])],[plan(['gitContext','gitContext'])],[plan([]),plan([])],
    ['TASK_COMPONENTS_JSON={bad'],['TASK_COMPONENTS_JSON={"version":1,"components":[],"code":"x"}'],
  ]) assert.throws(()=>selectTaskComponents({context}),{code:'PI_TASK_COMPONENTS_INVALID'});
});

test('component choice remains part of the protected request identity',()=>{
  const request=ids=>({access:'workspace-write',task:{role:'worker',objective:'change a',context:[plan(ids)]}});
  assert.equal(requestDigest('dispatch_subagent',request(['gitContext'])),requestDigest('dispatch_subagent',request(['gitContext'])));
  assert.notEqual(requestDigest('dispatch_subagent',request(['gitContext'])),requestDigest('dispatch_subagent',request(['projectMemory'])));
});

test('only selected instances start and all instances are disposed in reverse order',async()=>{
  const events=[];
  const result=await withTaskComponents(['gitContext','projectMemory'],definitions(events),async scope=>{
    assert.equal(scope.get('gitContext').name,'git');assert.equal(scope.get('projectMemory').name,'memory');
    return 'done';
  });
  assert.equal(result,'done');
  assert.deepEqual(events,['git-open','memory-open','memory-close','git-close']);
  events.length=0;
  await withTaskComponents(['gitContext'],definitions(events),async()=>{});
  assert.deepEqual(events,['git-open','git-close']);
  events.length=0;
  await withTaskComponents([],definitions(events),async()=>{});
  assert.deepEqual(events,[]);
});

test('failure, cancellation and failed initialization wait for owned cleanup',async()=>{
  const events=[];
  await assert.rejects(withTaskComponents(['gitContext'],definitions(events),async()=>{throw Error('aborted');}),/aborted/);
  assert.deepEqual(events,['git-open','git-close']);
  const controller=new AbortController();
  const pending=withTaskComponents(['gitContext'],definitions(events),async()=>await new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true})));
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending,/cancelled/);
  assert.deepEqual(events.slice(-2),['git-open','git-close']);
  const partial=[...definitions(events),{id:'broken',create:()=>{}}];
  await assert.rejects(withTaskComponents(['broken'],partial,async()=>{}),{code:'PI_TASK_COMPONENTS_INVALID'});
  const failDefs=[{id:'gitContext',create:({defer})=>{defer(async()=>events.push('partial-close'));throw Error('init failed');}}];
  await assert.rejects(withTaskComponents(['gitContext'],failDefs,async()=>{}),/Module initialization failed/);
  assert.equal(events.at(-1),'partial-close');
  const disposeFails=[{id:'gitContext',create:({defer})=>{defer(()=>{throw Error('cleanup');});return {};}}];
  await assert.rejects(withTaskComponents(['gitContext'],disposeFails,async()=>{}),/Module cleanup failed/);
});

test('overlapping tasks own separate lifetimes',async()=>{
  const events=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=withTaskComponents(['projectMemory'],definitions(events),async()=>{await gate;});
  await withTaskComponents(['projectMemory'],definitions(events),async()=>{});
  assert.deepEqual(events,['memory-open','memory-open','memory-close']);
  release();await first;
  assert.deepEqual(events,['memory-open','memory-open','memory-close','memory-close']);
});
