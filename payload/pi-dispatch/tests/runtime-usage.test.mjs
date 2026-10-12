import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeUsage,aggregateExecutionUsage} from '../extensions/runtime-usage.js';
import {summarizeUsage} from '../extensions/audit-log.js';
const message=usage=>({type:'message_end',sourceType:'message_end',role:'assistant',usage});
test('Pi and Claude components agree; reasoning is a subset and explicit total wins',()=>{
  assert.deepEqual(normalizeUsage({input:10,output:5,cacheRead:2,cacheWrite:1}),normalizeUsage({input_tokens:10,output_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:1}));
  assert.equal(normalizeUsage({input:10,output:5,cacheRead:2,cacheWrite:1}).totalTokens,18);
  const u=normalizeUsage({input_tokens:10,output_tokens:5,totalTokens:17,output_tokens_details:{thinking_tokens:3}});assert.equal(u.totalTokens,17);assert.equal(u.reasoningTokens,3);
  assert.equal(normalizeUsage({input:10,output:5}).totalTokens,null);
  assert.equal(summarizeUsage({input:10,output:5,cacheRead:2}).totalTokens,17);
});
test('usage counts each completed assistant message once, excludes delta/end lists and retains source',()=>{
  const u={input:10,output:5,cacheRead:2,cacheWrite:1};const events=[message(u),message(u),{type:'message_end',sourceType:'agent_end',role:'assistant',usage:u},{type:'text_delta',usage:u}];
  const first=aggregateExecutionUsage(events);assert.equal(first.execution.totalTokens,36);assert.equal(first.execution.expectedMessages,2);assert.equal(first.execution.complete,true);
  assert.deepEqual(first,aggregateExecutionUsage(events));assert.deepEqual(u,{input:10,output:5,cacheRead:2,cacheWrite:1});assert.equal(first.costUnavailable,true);
});
test('missing, invalid, partial, zero and unsafe totals remain truthful',()=>{
  const zero={input:0,output:0,cacheRead:0,cacheWrite:0};assert.equal(aggregateExecutionUsage([message(zero)]).execution.totalTokens,0);
  for(const missing of [undefined,{}, {input:-1,output:Infinity},{input:1.5}]){const u=aggregateExecutionUsage([message(zero),message(missing)]);assert.equal(u.execution.complete,false);assert.equal(u.execution.totalTokens,null);assert.equal(u.execution.observedMessages,1);assert.equal(summarizeUsage(u).available,false);}
  assert.equal(normalizeUsage({input:Number.MAX_SAFE_INTEGER,output:1,cacheRead:0,cacheWrite:0}).totalTokens,null);
});
