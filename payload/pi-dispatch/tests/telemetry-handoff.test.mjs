import test from 'node:test';import assert from 'node:assert/strict';
import {dispatch} from '../scripts/dispatch.mjs';
import {claudeCliRuntime} from '../scripts/worker-runtime/claude-code-cli/index.mjs';
import {createExecutionTimeline} from '../extensions/execution-timeline.js';
import {createTaskMonitor} from '../extensions/task-monitor.js';
import {buildAuditRecord} from '../extensions/audit-log.js';
import {exportResult} from '../extensions/result-export.js';
import {summarizeRuntimeResult} from '../scripts/worker-runtime/summarize.mjs';

test('Claude raw, adapter, dispatch, durable result, exported pages and audit preserve measured phases',async()=>{
  const phaseTimings={reviewer:{helpMs:1,authStatusMs:2,cliExecutionMs:3,parseMs:4,cleanupMs:5,totalMs:15,firstOutputMs:6}};
  const raw={status:'completed',modelExecutionStarted:true,text:'ok',phaseTimings,usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:1}};
  const request={target:'model',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',thinking:'medium',timeoutSeconds:30,reviewTier:'T1'};
  const task={role:'Geburah',objective:'Review synthetic fixture only',acceptance:['fixture review'],reviewPacket:{version:1,stage:'post-change',requirements:{status:'provided',content:['synthetic requirements']},changes:{status:'provided',content:['synthetic change']},context:{status:'provided',content:['synthetic context']},verification:{status:'provided',content:['synthetic passed check']}}};
  const runner=async()=>raw,context={probe:false,claudeReviewerRunner:runner,claudeCliEntryResolver:()=>'/synthetic/claude.js'};
  assert.equal(await claudeCliRuntime.run({packet:'synthetic'},{request,context}),raw);
  assert.deepEqual(claudeCliRuntime.summarize(raw,request).phaseTimings,phaseTimings);
  const result=await dispatch(request,undefined,task,{claudeReviewerRunner:runner,claudeCliEntryResolver:context.claudeCliEntryResolver});
  assert.deepEqual(result.phaseTimings,phaseTimings);
  const saved=new Map(),monitor=createTaskMonitor({gatewayInstanceId:'telemetry',maintenanceIntervalMs:0,persistResult:(id,r)=>{saved.set(id,r);return true;},loadResult:id=>saved.get(id)});
  try{monitor.submit({requestId:'telemetry',provider:request.provider,model:request.model,access:'none',task},async()=>result);await monitor.wait('telemetry');assert.deepEqual(saved.get('telemetry').result.phaseTimings,phaseTimings);assert.deepEqual(monitor.getResult('telemetry').result.phaseTimings,phaseTimings);assert.deepEqual(exportResult(result).result.phaseTimings,phaseTimings);assert.equal(buildAuditRecord({operation:'dispatch_subagent',result}).tokens.totalTokens,18);}finally{monitor.close();}
});

test('Pi timeline and multi-turn usage travel through summary/export/audit without re-counting',()=>{
  let n=0;const t=createExecutionTimeline({now:()=>n++});t.event({type:'tool_start',callId:'a',name:'read'});t.event({type:'tool_end',callId:'a',name:'read'});t.event({type:'end'});t.close();
  const usage={input:10,output:5,cacheRead:2,cacheWrite:1};const events=[1,2].map(()=>({type:'message_end',sourceType:'message_end',role:'assistant',provider:'openai-codex',model:'gpt-6-luna',usage,content:[{type:'text',text:'ok'}]}));events.push({type:'end'});
  const raw={exitCode:0,stderr:'',phaseTimings:t.snapshot()};const result={...summarizeRuntimeResult(raw,{provider:'openai-codex',model:'gpt-6-luna'},events),phaseTimings:raw.phaseTimings};
  for(let i=0;i<3;i++){const exported=exportResult(result).result;assert.equal(exported.usage.execution.totalTokens,36);assert.equal(buildAuditRecord({operation:'dispatch_subagent',result:exported}).tokens.totalTokens,36);assert.equal(exported.phaseTimings.toolTiming.wallMs,1);}
});
