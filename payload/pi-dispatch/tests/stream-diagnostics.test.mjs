import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {createJsonOutputCollector,stripPatch} from '../scripts/wsl-sandbox.mjs';
import {LIFECYCLE_PREFIX} from '../scripts/pi-single-shot-lifecycle.mjs';

const line=value=>`${JSON.stringify(value)}\n`;

test('lifecycle metadata cannot hide patch failure or evade output budget',()=>{
  const t=createExecutionTimeline(),c=createJsonOutputCollector(10000,{onLifecycle:v=>t.lifecycle(v)});
  const frame=LIFECYCLE_PREFIX+line({v:1,n:1,event:'main_return',ms:10});
  c.feed('stderr','PI_PATCH_INVALID_BYTES\n');for(const part of frame)c.feed('stderr',part);
  c.feed('stderr',LIFECYCLE_PREFIX+'forged');const result=c.close();
  assert.equal(stripPatch('',result.stderr).failure,'PI_PATCH_INVALID_BYTES');assert.equal(t.snapshot().lifecycle.length,1);
  const overflow=createJsonOutputCollector(30);overflow.feed('stderr',LIFECYCLE_PREFIX+'x'.repeat(100));assert.equal(overflow.close().failure,'output-limit');
  const before=createExecutionTimeline().snapshot();assert.equal(Object.hasOwn(before,'lifecycle'),false);
});

test('separates thinking and text and counts tool outcomes',()=>{
  let tick=0;
  const t=createExecutionTimeline({now:()=>++tick});
  t.feed(line({type:'agent_start'}));
  t.feed(line({type:'message_update',assistantMessageEvent:{type:'thinking_delta',thinking:'hidden'}}));
  t.feed(line({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'visible'}}));
  t.feed(line({type:'tool_execution_start',toolName:'one'}));
  t.feed(line({type:'tool_execution_end',toolName:'one',isError:true,result:'private'}));
  t.feed(line({type:'tool_execution_start',toolName:'two'}));
  t.feed(line({type:'tool_execution_end',toolName:'two',isError:false,result:'private'}));
  assert.deepEqual(t.snapshot().stream,{thinkingDeltas:1,textDeltas:1,toolStarts:2,toolEnds:2,toolErrors:1,firstTextMs:3,lastEventMs:7,lastEventType:'tool_execution_end'});
});

test('keeps only sanitized, immutable metadata',()=>{
  let tick=0;
  const t=createExecutionTimeline({now:()=>++tick});
  t.feed(line({type:'message_update',assistantMessageEvent:{type:'thinking_delta',thinking:'TOP_SECRET'},arguments:{payload:'TOP_SECRET'}}));
  t.feed(line({type:'untrusted_event_name',toolName:'TOP_SECRET',result:'TOP_SECRET'}));
  const before=t.snapshot();
  const after=t.snapshot();
  assert.notEqual(before.stream,after.stream);
  before.stream.thinkingDeltas=99;
  assert.equal(t.snapshot().stream.thinkingDeltas,1);
  assert.equal(JSON.stringify(t.snapshot()).includes('TOP_SECRET'),false);
  assert.equal(t.snapshot().stream.lastEventType,'message_update');
});

test('handles split chunks and retains counts through close and cleanup',()=>{
  let tick=0;const progress=[];
  const t=createExecutionTimeline({now:()=>++tick,onProgress:s=>progress.push(s)});
  const chunk=line({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'answer'}});
  t.feed(chunk.slice(0,-2));
  t.feed(chunk.slice(-2));
  t.feed(line({type:'tool_execution_start',toolName:'tool'}));
  t.feed(line({type:'tool_execution_end',isError:true}));
  t.close();t.cleaned(17);
  const snapshot=t.snapshot();
  assert.equal(snapshot.stream.textDeltas,1);
  assert.equal(snapshot.stream.toolEnds,1);
  assert.equal(snapshot.stream.toolErrors,1);
  assert.equal(progress[progress.length-1].stream.toolErrors,1);
  assert.equal(snapshot.cleanupMs,17);
});

test('uses nonempty assistant text and leaves unfinished generation null',()=>{
  let tick=0;const t=createExecutionTimeline({now:()=>++tick});
  t.feed(line({type:'agent_start'}));
  t.feed(line({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}]}}));
  const snapshot=t.snapshot();
  assert.equal(snapshot.stream.firstTextMs,2);
  assert.equal(snapshot.generationMs,null);
  assert.equal(snapshot.processTailMs,null);
});


test('tool spans use bounded unique IDs, overlap-safe union and no private names',()=>{
 let tick=0;const t=createExecutionTimeline({now:()=>tick});
 t.event({type:'text_delta'});tick=1;t.event({type:'tool_start',callId:'a',name:'read'});tick=2;t.event({type:'tool_start',callId:'b',name:'secret / argument'});tick=4;t.event({type:'tool_end',callId:'a',name:'read'});tick=5;t.event({type:'tool_end',callId:'b',name:'secret / argument'});tick=6;t.event({type:'end'});
 const s=t.snapshot();assert.equal(s.toolTiming.sumMs,6);assert.equal(s.toolTiming.wallMs,4);assert.equal(s.toolTiming.nonToolGenerationMs,2);assert.equal(JSON.stringify(s).includes('secret'),false);s.toolTiming.byName.read.sumMs=999;assert.equal(t.snapshot().toolTiming.byName.read.sumMs,3);
});
test('ambiguous, unfinished, reversed and overflowed tool intervals never manufacture durations',()=>{
 for(const kind of ['missing','duplicate','unfinished','reverse','overflow']){
 let tick=0;const t=createExecutionTimeline({now:()=>tick++});t.event({type:'tool_start',callId:kind==='missing'?undefined:'a',name:'read'});
 if(kind==='duplicate')t.event({type:'tool_start',callId:'a',name:'read'});
 if(kind==='reverse')tick=-10;
 if(kind==='overflow')for(let i=0;i<130;i++)t.event({type:'tool_start',callId:'extra'+i,name:'read'});
 if(kind!=='unfinished')t.event({type:'tool_end',callId:'a',name:'read'});
 const s=t.snapshot();assert.equal(s.toolTiming.complete,false,kind);assert.equal(s.toolTiming.sumMs,null,kind);assert.ok(s.toolTiming.retainedSpans<=128);
 }
});
