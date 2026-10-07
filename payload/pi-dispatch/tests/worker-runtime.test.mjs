import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeEvent } from '../scripts/worker-runtime/types.mjs';
import { createPiNormalizer, eventsFrom, normalizePiEvent, normalizePiEvents } from '../scripts/worker-runtime/pi/normalize.mjs';
import {resolveRuntime,RUNTIMES} from '../scripts/worker-runtime/index.mjs';
import {summarizeRuntimeResult} from '../scripts/worker-runtime/summarize.mjs';
import {dispatch,validateRequest} from '../scripts/dispatch.mjs';
import {runProcess} from '../scripts/headless-host.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {accountToolErrors} from '../extensions/tool-error-recovery.js';
import {accountRuntimeToolErrors} from '../scripts/worker-runtime/summarize.mjs';
import {PROVIDER_POLICY} from '../scripts/provider-policy.mjs';
import {API_PROVIDERS} from '../scripts/controlled-provider.mjs';

test('validates normalized event types and known field types without replacing the object', () => {
  const event = { type: 'text_delta', delta: 'hello', bytes: 5 };
  assert.equal(validateRuntimeEvent(event), event);
  for (const invalid of [null, [], {}, { type: 'unknown' }, { type: 'text_delta', delta: 1 },
    { type: 'text_delta', bytes: Infinity }, { type: 'tool_end', isError: 'no' },
    { type: 'message_end', content: 3 }, { type: 'result_submission', kind: 'other' }]) {
    assert.throws(() => validateRuntimeEvent(invalid), TypeError);
  }
  assert.equal(validateRuntimeEvent({ type: 'message_end', content: [{ type: 'text', text: 'ok' }] }).type, 'message_end');
});

test('normalizes Pi event variants while preserving legacy metadata and hiding thinking text', () => {
  assert.deepEqual(normalizePiEvent({ type: 'agent_start' }), [{ type: 'start', sourceType: 'agent_start' }]);
  assert.deepEqual(normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '中文🙂' } }),
    [{ type: 'text_delta', sourceType: 'message_update', delta: '中文🙂' }]);
  assert.deepEqual(normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', thinking: 'secret' } }),
    [{ type: 'thinking_delta', sourceType: 'message_update' }]);
  assert.deepEqual(normalizePiEvent({ type: 'message_end', message: { role: 'assistant', content: 'answer', usage: { total: 2 } } }),
    [{ type: 'message_end', sourceType: 'message_end', role: 'assistant', content: 'answer', usage: { total: 2 } }]);
  assert.deepEqual(normalizePiEvent({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'edit', args: { path: 'a\\b' } }),
    [{ type: 'tool_start', sourceType: 'tool_execution_start', callId: 'c', name: 'edit', path: 'a\\b' }]);
  assert.deepEqual(normalizePiEvent({ type: 'unrecognized' }), []);
  assert.throws(() => normalizePiEvent(null), TypeError);
  assert.deepEqual(eventsFrom('{bad}\r\n{"type":"agent_end"}\n'), [{ type: 'agent_end' }]);
  assert.deepEqual(normalizePiEvents([{ type: 'agent_start' }, { type: 'unrecognized' }]), [{ type: 'start', sourceType: 'agent_start' }]);
});

test('emits submission and constrained rejection metadata without copying arbitrary tool output', () => {
  const end = { type: 'tool_execution_end', toolName: 'yhwh_submit_result', result: { details: { type: 'kether_result_rejection', code: 'RESULT_ROLE_SCHEMA_INVALID' } }, resultText: 'private' };
  assert.deepEqual(normalizePiEvent(end), [
    { type: 'tool_end', sourceType: 'tool_execution_end', name: 'yhwh_submit_result' },
    { type: 'result_submission', kind: 'role-schema-rejection', validRejection: true },
  ]);
  const malformedRejection = normalizePiEvent({ type: 'tool_execution_end', toolName: 'yhwh_submit_result', details: { type: 'kether_result_rejection', code: 'wrong', extra: true } });
  assert.equal(malformedRejection[1].kind, 'role-schema-rejection');
  assert.equal(malformedRejection[1].validRejection, false);
  assert.deepEqual(normalizePiEvent({ type: 'tool_execution_end', toolName: 'yhwh_submit_result', details: { arbitrary: 'private' } })[1],
    { type: 'result_submission', kind: 'submission', validRejection: false });
});

test('stream parser handles split Unicode, bounds discarded lines, and closes/disposes idempotently', () => {
  const seen = [];
  const parser = createPiNormalizer({ onEvent: event => seen.push(event), retainEvents: false, maxBufferCharacters: 256, flushAtClose: false });
  const json = `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '🙂中文' } })}\n`;
  parser.feed(json.slice(0, json.indexOf('🙂') + 1));
  parser.feed(json.slice(json.indexOf('🙂') + 1));
  parser.feed(`${'x'.repeat(300)}\n${JSON.stringify({ type: 'agent_end' })}\n`);
  parser.feed('{"type":"agent_start"}');
  assert.deepEqual(seen.map(event => event.type), ['text_delta', 'end']);
  assert.deepEqual(parser.events(), []);
  parser.close(); parser.close();
  parser.feed(`${JSON.stringify({ type: 'agent_start' })}\n`);
  assert.equal(seen.length, 2);
  parser.dispose(); parser.dispose();
  assert.deepEqual(parser.events(), []);

  const retained = createPiNormalizer();
  retained.feed(`${JSON.stringify({ type: 'agent_start' })}\n`);
  retained.close(); retained.close();
  assert.deepEqual(retained.events(), [{ type: 'start', sourceType: 'agent_start' }]);
  retained.dispose();
  assert.deepEqual(retained.events(), []);
});

test('runtime registry is fixed, rejects unknown providers and cannot be selected by request fields',()=>{
  assert.ok(Object.isFrozen(RUNTIMES));assert.ok(Object.isFrozen(RUNTIMES.pi));assert.ok(Object.isFrozen(RUNTIMES.pi.capabilities));
  assert.equal(resolveRuntime({provider:'openai-codex'}).id,'pi');assert.equal(resolveRuntime({provider:'claude-code-cli'}).id,'claude-code-cli');
  for(const provider of [undefined,'unknown','toString','__proto__'])assert.throws(()=>resolveRuntime({provider}));
  assert.throws(()=>validateRequest({target:'model',cwd:process.cwd(),provider:'openai-codex',model:'gpt-6-luna',prompt:'fixture',runtime:'fake'}),/Unknown request key/);
});

const reviewTask={role:'Geburah',objective:'Review synthetic fixture only',acceptance:['fixture review'],reviewPacket:{version:1,stage:'post-change',requirements:{status:'provided',content:['synthetic requirements']},changes:{status:'provided',content:['synthetic change']},context:{status:'provided',content:['synthetic context']},verification:{status:'provided',content:['synthetic passed check']}}};
const reviewRequest={target:'model',provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',thinking:'medium',timeoutSeconds:30,reviewTier:'T1'};
test('a trusted fake runtime completes dispatch using normalized events and no Pi event format or process',async()=>{
  const trace=[],fake={prepare(_request,_task,ctx){trace.push('prepare');assert.equal(ctx.resultFormat,'json');return [{type:'message_end',role:'assistant',provider:'claude-code-cli',model:'claude-sonnet-5',content:[{type:'text',text:'fake normalized response'}],stopReason:'stop'},{type:'end'}];},async run(events){trace.push('run');events.forEach(validateRuntimeEvent);return {exitCode:0,failure:null,stderr:'',events};},summarize(raw,request){trace.push('summarize');return summarizeRuntimeResult(raw,request,raw.events);}};
  const result=await dispatch({...reviewRequest},undefined,structuredClone(reviewTask),{runtimeResolver:()=>fake,claudeReviewerRunner:()=>{throw Error('must not run CLI');},claudeCliEntryResolver:()=>{throw Error('must not resolve CLI');}});
  assert.equal(result.ok,true);assert.equal(result.text,'fake normalized response');assert.deepEqual(trace,['prepare','run','summarize']);
});
test('review permissions and material gates still run before a trusted runtime can execute',async()=>{
  let resolutions=0;const runtimeResolver=()=>{resolutions++;throw Error('must not resolve');};
  await assert.rejects(()=>dispatch({...reviewRequest,access:'read'},undefined,structuredClone(reviewTask),{runtimeResolver}));
  const missing=structuredClone(reviewTask);missing.reviewPacket.requirements={status:'missing',content:[],reason:'fixture missing'};
  await assert.rejects(()=>dispatch({...reviewRequest},undefined,missing,{runtimeResolver}));assert.equal(resolutions,0);
});
test('Claude adapter keeps sparse legacy output, launch callback, no-tools transport and failure projection',async()=>{
  for(const response of [{status:'completed',text:'fixture',usage:{input_tokens:2},modelExecutionStarted:true},{status:'failed',reason:'PI_AUTH_EXPIRED',modelExecutionStarted:false},{status:'failed',reason:'PI_QUOTA_LIMITED',resetTime:'fixture-reset',modelExecutionStarted:true},{status:'failed'}]){
    let observed;const callback=()=>{};const actual=await dispatch({...reviewRequest},undefined,structuredClone(reviewTask),{claudeCliEntryResolver:()=>'/synthetic/claude.js',onModelStart:callback,claudeReviewerRunner:async args=>{observed=args;return response;}});
    const expected={target:'model',requestedProvider:'claude-code-cli',requestedModel:'claude-sonnet-5',provider:'claude-code-cli',model:'claude-sonnet-5',ok:response.status==='completed',...(response.text!==undefined?{text:response.text}:{}),usage:response.usage??null,modelExecutionStarted:response.modelExecutionStarted===true,toolsUsed:[],toolErrors:0,runtime:'host-cli',osSandbox:'none',...(response.status!=='completed'?{failureCode:response.reason,failure:response.reason??'Claude Code CLI failed'}:{}),...(response.resetTime?{resetTime:response.resetTime}:{})};
    assert.deepEqual(actual,expected);assert.equal(observed.timeoutMs,30000);assert.equal(observed.thinking,'medium');assert.equal(observed.onModelStart,callback);assert.ok(observed.resultSchema);assert.ok(observed.packet.includes('TASK_PACKET_JSON='));assert.equal(observed.cliScript,'/synthetic/claude.js');
  }
});
test('normalizer rejects invalid limits and never retains private thinking or arbitrary tool output',()=>{
  for(const maxBufferCharacters of [0,-1,Infinity,1.5])assert.throws(()=>createPiNormalizer({maxBufferCharacters}));
  const n=createPiNormalizer();n.feed(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',thinking:'private-thinking'}})+'\n');n.feed(JSON.stringify({type:'tool_execution_end',toolName:'read',result:{content:'private-tool-output'},args:{extra:'private-extra'}})+'\n');n.close();assert.doesNotMatch(JSON.stringify(n.events()),/private-thinking|private-tool-output|private-extra/);n.dispose();
});

test('retained event and byte limits fail visibly rather than returning a truncated completion',()=>{
  for(const options of [{maxRetainedEvents:1},{maxRetainedBytes:1}]){
    const n=createPiNormalizer(options);n.feed('{"type":"agent_start"}\n{"type":"agent_end"}\n');n.close();assert.throws(()=>n.events(),/RUNTIME_EVENT_LIMIT_EXCEEDED/);n.dispose();assert.deepEqual(n.events(),[]);
  }
  const stream=createPiNormalizer({retainEvents:false,maxRetainedEvents:1,maxRetainedBytes:1});for(let i=0;i<10000;i++)stream.feed('{"type":"agent_start"}\n');stream.close();assert.deepEqual(stream.events(),[]);
});

test('models CLI preserves the real child argument list and doctor entry without model execution',async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-models-fixture-'));
  t.after(()=>{assert.equal(path.dirname(temp),os.tmpdir());fs.rmSync(temp,{recursive:true,force:true});});
  const entry=path.join(temp,'pi-fixture.mjs');
  fs.writeFileSync(entry,"console.log(JSON.stringify(process.argv.slice(2)));\n");
  const cli=fileURLToPath(new URL('../scripts/dispatch.mjs',import.meta.url));
  const expected=['--offline','--no-approve','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--no-extensions','--list-models'];
  for(const command of ['models','doctor']){
    const actual=await runProcess(process.execPath,[cli,command],{cwd:temp,env:{...process.env,PI_DISPATCH_PI_ENTRY:entry},input:'',timeoutMs:15000,maxOutputBytes:1024*1024});
    assert.equal(actual.failure??null,null);assert.equal(actual.exitCode,0,actual.stdout+actual.stderr);
    const result=JSON.parse(actual.stdout);assert.equal(result.ok,true);
    assert.deepEqual(JSON.parse(command==='models'?result.models:result.piVersion),command==='models'?expected:['--version']);
  }
});

test('every currently admitted policy/API provider resolves to its existing runtime',()=>{
  for(const provider of new Set([...Object.keys(PROVIDER_POLICY),...API_PROVIDERS]))assert.equal(resolveRuntime({provider}).id,provider==='claude-code-cli'?'claude-code-cli':'pi',provider);
});

test('normalized tool recovery matches the original counter for deterministic malformed/order/path streams',()=>{
  let seed=0x81317;const next=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const ids=['a','b','',null,undefined,3],names=['edit','write','read','bash','yhwh_submit_result'],paths=['a.js','a\\b.js','a/b.js','../outside.js',null,3],flags=[true,false,undefined,'true'];
  for(let i=0;i<500;i++){
    const events=[];
    for(let j=0,count=1+next(16);j<count;j++)events.push({type:next(2)?'tool_execution_start':'tool_execution_end',toolCallId:ids[next(ids.length)],toolName:names[next(names.length)],args:next(2)?{path:paths[next(paths.length)]}:{otherPath:'a.js'},isError:flags[next(flags.length)]});
    assert.deepEqual(accountRuntimeToolErrors(normalizePiEvents(events)),accountToolErrors(events),'deterministic stream '+i);
  }
});
