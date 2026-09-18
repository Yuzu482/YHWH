import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {exportResult} from '../extensions/result-export.js';
import {createTaskMonitor} from '../extensions/task-monitor.js';

test('stream timings survive split JSON chunks and distinguish missing response',()=>{
  let time=100;const progress=[];const t=createExecutionTimeline({now:()=>time,onProgress:value=>progress.push(value)});
  time=120;t.feed('{"type":"agent_');t.feed('start"}\n');
  time=150;t.feed('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta"}}\n');
  time=210;t.feed('{"type":"agent_end"}\n');time=220;t.close();t.cleaned(12);
  assert.deepEqual(t.snapshot(),{startupMs:20,timeToFirstResponseMs:50,firstResponseSource:'stream-delta',generationMs:60,processMs:120,processTailMs:10,cleanupMs:12});
  const silent=createExecutionTimeline({now:()=>time});silent.close();assert.equal(silent.snapshot().timeToFirstResponseMs,null);
  assert.ok(progress.length>=4);
});
test('full result pagination redacts before splitting and reconstructs valid JSON with stable digest',()=>{
  const result={ok:true,text:'第一行\nBearer hidden-token\n'+ 'result '.repeat(80),structuredResult:{password:'hidden-password',result:'useful',evidence:['full evidence']},refreshToken:{nested:'hidden-refresh'}};
  let json='',offset=0,hash;
  do{const page=exportResult(result,{offset,limit:17});json+=page.resultJsonChunk;offset=page.nextOffset;hash=page.sha256;}while(offset!==null);
  assert.doesNotMatch(json,/hidden-token|hidden-password|hidden-refresh/);
  assert.equal(JSON.parse(json).structuredResult.result,'useful');
  assert.equal(createHash('sha256').update(json).digest('hex'),hash);
  assert.throws(()=>exportResult(result,{offset:99999}),/offset/);
});
test('monitor full result distinguishes running, terminal failure and unknown IDs',async()=>{
  const monitor=createTaskMonitor({gatewayInstanceId:'test-gateway'});let release;
  monitor.submit({requestId:'read-1',task:{role:'reviewer'}},async(_signal,running,_waiting,progress)=>{
    running();progress({startupMs:5});await new Promise(resolve=>{release=resolve;});
    return {response:{ok:false,error:'Bearer private',structuredResult:{result:'actual reviewer findings',evidence:['checked source']}}};
  });
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(monitor.getResult('read-1').ready,false);assert.equal(monitor.get('read-1').phaseTimings.startupMs,5);
  release();await new Promise(resolve=>setImmediate(resolve));
  const final=monitor.getResult('read-1');assert.equal(final.ready,true);assert.equal(final.state,'failed');assert.equal(final.result.structuredResult.result,'actual reviewer findings');
  assert.doesNotMatch(JSON.stringify(final),/Bearer private/);assert.equal(monitor.getResult('missing').code,'RESULT_NOT_FOUND');
});
