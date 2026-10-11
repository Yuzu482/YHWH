import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {safeFlags,buildPiArgs} from '../scripts/worker-runtime/pi/args.mjs';
import {isSingleShotArgs,pinnedSdkMatches,createLifecycle,finishSingleShot,drainStream,observeSocketClose,createLifecycleFilter,LIFECYCLE_PREFIX} from '../scripts/pi-single-shot-lifecycle.mjs';
const args=[...safeFlags,'--print','--mode','json','--no-session','--provider','openai-codex','--model','gpt-6-luna','--thinking','medium','--no-tools'];
const sink=()=>new Writable({write(c,e,cb){cb();}});
const idle=()=>{const s=createLifecycle({emit:()=>{}});for(const n of ['agent_start','agent_end','agent_settled','session_shutdown'])s.event(n);return s;};

test('only canonical single-shot arguments qualify; corrupt or absent SDK always falls back',()=>{
  assert.equal(isSingleShotArgs(args),true);
  for(const extra of [['--print'],['--mode=json'],['--resume','x'],['x'],['--'],['--extension','/workspace/malicious.js']])assert.equal(isSingleShotArgs([...args,...extra]),false);
  assert.equal(isSingleShotArgs(args.map(v=>v==='openai-codex'?'anthropic':v)),false);
  assert.equal(pinnedSdkMatches(()=>Buffer.from('changed')),false);
  assert.equal(pinnedSdkMatches(()=>{throw Error('absent');}),false);
  assert.equal(isSingleShotArgs(buildPiArgs({rolePresetId:'Chesed',provider:'openai-codex',model:'gpt-6-luna',thinking:'medium',access:'workspace-write'},'wsl2',false,true,true)),true);
});

test('main, tools and shutdown must finish before a forced exit',async()=>{
  const s=idle(),exits=[];let release;
  const pending=new Promise(r=>{release=r;});
  const p=finishSingleShot(()=>pending,s,{policy:'bounded-exit',stdout:sink(),stderr:sink(),exit:c=>exits.push(c),getExitCode:()=>7});
  await delay(15);assert.deepEqual(exits,[]);release();await p;assert.deepEqual(exits,[7]);
  for(const type of ['pending-tool','missing-shutdown','unbalanced']){
    const state=createLifecycle({emit:()=>{}});state.event('agent_start');state.event('agent_end');state.event('agent_settled');
    if(type!=='missing-shutdown')state.event('session_shutdown');
    if(type==='pending-tool')state.event('tool_execution_start',{toolCallId:'check-1'});
    if(type==='unbalanced')state.event('tool_execution_end',{toolCallId:'unknown'});
    const out=[];await finishSingleShot(async()=>{},state,{policy:'bounded-exit',stdout:sink(),stderr:sink(),exit:c=>out.push(c)});assert.deepEqual(out,[]);
    if(type==='pending-tool'){state.event('tool_execution_end',{toolCallId:'check-1'});assert.equal(state.idle(),true);}
  }
});

test('close observer preserves constructor, prototype and original return/throw',()=>{
  class WS extends EventTarget{close(value){if(value==='bad')throw Error('original');return value;}}
  const marks=[],restore=observeSocketClose({mark:e=>marks.push(e)},WS),ws=new WS();
  assert.equal(ws.constructor,WS);assert.ok(ws instanceof WS);assert.equal(ws.close(4),4);ws.dispatchEvent(new Event('close'));assert.deepEqual(marks,['socket_close_requested','socket_closed']);assert.throws(()=>ws.close('bad'),/original/);restore();
});

test('drain distinguishes EPIPE and timeout and main rejection cannot exit successfully',async()=>{
  await assert.rejects(drainStream(new Writable({write(c,e,cb){cb(Object.assign(Error('private'),{code:'EPIPE'}));}})),{code:'epipe'});
  await assert.rejects(drainStream(new Writable({write(){}}),{timeoutMs:10}),{code:'timeout'});
  const old=process.exitCode,exits=[];
  try{await finishSingleShot(async()=>{throw Error('secret');},idle(),{policy:'bounded-exit',stdout:sink(),stderr:sink(),exit:c=>exits.push(c)});assert.deepEqual(exits,[2]);}finally{process.exitCode=old;}
});

test('reserved diagnostic frames are split-safe and bounded, never replace real terminal failures',()=>{
  const events=[],output=[],f=createLifecycleFilter({onEvent:e=>events.push(e),onOutput:s=>output.push(s)});
  const trace=LIFECYCLE_PREFIX+JSON.stringify({v:1,n:1,event:'main_return',ms:10})+'\n';
  for(const c of ('PI_PATCH_INVALID\n'+trace+trace+LIFECYCLE_PREFIX+'x'.repeat(8000)+'\n'+LIFECYCLE_PREFIX+'{bad}'))f.feed(c);
  f.close();assert.equal(events.length,1);assert.equal(output.join(''),'PI_PATCH_INVALID\n');
});

test('slow pipe readers receive >1MiB on BOTH streams before bounded exit despite residual timer',async()=>{
  const url=new URL('../scripts/pi-single-shot-lifecycle.mjs',import.meta.url).href;
  const script=`import {createLifecycle,finishSingleShot} from ${JSON.stringify(url)};const s=createLifecycle({emit:()=>{}});for(const n of ['agent_start','agent_end','agent_settled','session_shutdown'])s.event(n);setTimeout(()=>{},3000);await finishSingleShot(async()=>{process.stdout.write('a'.repeat(1200000));process.stderr.write('b'.repeat(1200000));},s,{policy:'bounded-exit'});`;
  const t=Date.now(),child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let out=0,err=0;
  child.stdout.pause();child.stderr.pause();await delay(60);
  child.stdout.on('data',b=>{out+=b.length;child.stdout.pause();setTimeout(()=>child.stdout.resume(),1);});child.stderr.on('data',b=>{err+=b.length;child.stderr.pause();setTimeout(()=>child.stderr.resume(),1);});child.stdout.resume();child.stderr.resume();
  const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});assert.equal(code,0);assert.equal(out,1200000);assert.equal(err,1200000);assert.ok(Date.now()-t<2800);
});
