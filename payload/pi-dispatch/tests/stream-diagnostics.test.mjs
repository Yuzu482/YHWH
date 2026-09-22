import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionTimeline} from '../extensions/execution-timeline.js';

const line=value=>`${JSON.stringify(value)}\n`;

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
