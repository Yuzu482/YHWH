import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authorizeEditors,createEditorBroker} from '../scripts/editor-authorization.mjs';
import {createEditorRpc,EDITOR_FRAME} from '../scripts/editor-rpc.mjs';
import {buildPiArgs} from '../scripts/dispatch.mjs';
import {compileOperation} from '../pi-extensions/unity/index.mjs';
const context={requestId:'task-one',parentRunId:'run-one',provider:'openai-codex',role:'Chesed',ledgerEnabled:true};
const makeGrant=(write=false)=>({version:1,expiresAt:new Date(Date.now()+60000).toISOString(),operations:[{id:'one',editor:'blender',tool:write?'blender_create_object':'blender_scene_info',args:write?{name:'Authorized',primitive:'cube'}:{},...(write?{scene:{name:'Scene',path:''}}:{})}]});
const config={enabled:true,allowWrites:true,tools:{blender_scene_info:'read',blender_create_object:'write'}};
function fixture(grant=makeGrant(),overrides={}){
 const stateDir=mkdtempSync(join(tmpdir(),'editor-grant-'));let calls=[];const records=[];
 const broker=createEditorBroker(grant,{...context,stateDir,configReader:()=>config,audit:{record:r=>records.push(r)},bridgeFactory:()=>({invoke:async(...args)=>{calls.push(args);return {ok:true,result:{content:[]}};}}),...overrides});
 return {broker,stateDir,calls,records,async close(){await broker.close();rmSync(stateDir,{recursive:true,force:true});}};
}
test('only trusted exact bounded grants and admitted roles',()=>{
 assert.ok(authorizeEditors(makeGrant(),context));
 for(const change of [{provider:'pi-claude-code-provider'},{role:'Geburah'},{ledgerEnabled:false},{parentRunId:null},{requestId:null}])assert.throws(()=>authorizeEditors(makeGrant(),{...context,...change}));
 const bad=[{...makeGrant(),expiresAt:new Date(0).toISOString()},{...makeGrant(),expiresAt:new Date(Date.now()+901000).toISOString()},{...makeGrant(),extra:true}];
 for(const v of bad)assert.throws(()=>authorizeEditors(v,context));
 const g=makeGrant();g.operations.push({...g.operations[0]});assert.throws(()=>authorizeEditors(g,context));
 const w=makeGrant(true);delete w.operations[0].scene;assert.throws(()=>authorizeEditors(w,context));
 assert.throws(()=>authorizeEditors(makeGrant(true),{...context,role:'Malkuth'}));
 const arbitrary=makeGrant();arbitrary.operations[0].tool='Unity_RunCommand';assert.throws(()=>authorizeEditors(arbitrary,context));
});
test('worker cannot replace args, mint operation IDs or cross the closed channel',async()=>{
 const f=fixture();try{
  await assert.rejects(f.broker.invoke({operationId:'other'}),/DENIED/);
  await assert.rejects(f.broker.invoke({operationId:'one',args:{name:'evil'}}),/INVALID/);
  assert.equal((await f.broker.invoke({operationId:'one'})).ok,true);
  await f.broker.invoke({operationId:'one'});assert.equal(f.calls.length,1);
  await f.broker.close();await assert.rejects(f.broker.invoke({operationId:'one'}),/REVOKED/);
  assert.equal(f.records.filter(r=>r.operation==='editor_operation').length,1);assert.doesNotMatch(JSON.stringify(f.records),/Authorized|token|args/);
 }finally{await f.close();}
});
test('writes receive exact fixed args and scene; successful writes clear fence',async()=>{
 const f=fixture(makeGrant(true));try{
  await f.broker.invoke({operationId:'one'});assert.deepEqual(f.calls[0][1].args,{name:'Authorized',primitive:'cube',_piScene:{name:'Scene',path:''}});
  assert.match(f.calls[0][1].requestId,/^editor-[a-f0-9]{64}$/);
  assert.equal(existsSync(join(f.stateDir,'blender','gateway-write-fence.json')),false);
 }finally{await f.close();}
});
test('uncertain write fences survive broker restart and block new writes',async()=>{
 const f=fixture(makeGrant(true),{bridgeFactory:()=>({invoke:async()=>{throw Object.assign(Error(),{code:'EDITOR_RESULT_UNCERTAIN'});}})});
 try{
  assert.equal((await f.broker.invoke({operationId:'one'})).uncertain,true);
  assert.equal(f.broker.report().ok,false);
  const second=createEditorBroker(makeGrant(true),{...context,requestId:'other',stateDir:f.stateDir,configReader:()=>config,bridgeFactory:()=>{throw Error('must not connect');}});
  assert.equal((await second.invoke({operationId:'one'})).code,'EDITOR_RECONCILIATION_REQUIRED');await second.close();
  assert.match(readFileSync(join(f.stateDir,'blender','gateway-write-fence.json'),'utf8'),/task-one/);
 }finally{await f.close();}
});
test('expiry, cancellation and config changes revoke authority',async()=>{
 let now=Date.now(),changed=false;const controller=new AbortController();
 const f=fixture(makeGrant(),{now:()=>now,signal:controller.signal,configReader:()=>({...config,allowWrites:!changed})});
 try{changed=true;await assert.rejects(f.broker.invoke({operationId:'one'}),/CONFIG_CHANGED/);changed=false;now+=70000;await assert.rejects(f.broker.invoke({operationId:'one'}),/REVOKED/);controller.abort();assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('stdio RPC splits, bounds and validates frames; responses never enter model stdout',async()=>{
 const responses=[],output=[],failures=[];const f=fixture();
 const rpc=createEditorRpc({broker:f.broker,send:x=>responses.push(JSON.parse(x)),onOutput:x=>output.push(x),onFailure:x=>failures.push(x)});
 try{
  rpc.feed('{"type":"message"}\nPI_ED');rpc.feed('ITOR_RPC={"id":1,"operationId":"one"}\n');
  await new Promise(r=>setImmediate(r));assert.equal(responses[0].result.ok,true);assert.deepEqual(output,['{"type":"message"}\n']);
  rpc.feed(EDITOR_FRAME+'{"id":2,"operationId":"one","args":{}}\n');assert.equal(failures.length,1);
  assert.equal(f.calls.length,1);
 }finally{await rpc.close();await f.close();}
});
test('editor-only task has no filesystem tools; ordinary tasks keep no-tools',()=>{
 const request={provider:'openai-codex',model:'gpt-5.6-luna',access:'none'};
 const args=buildPiArgs(request,'wsl2',true);assert.equal(args[args.indexOf('--tools')+1],'pi_editor_execute');assert.ok(!args.includes('--no-tools'));
 assert.ok(buildPiArgs(request,'wsl2').includes('--no-tools'));
 assert.throws(()=>buildPiArgs({...request,provider:'pi-claude-code-provider'},'wsl2',true));
});
test('Unity scene precondition executes inside the same typed command',()=>{
 const r=compileOperation('unity_create_object',{name:'Bound',primitive:'Cube',_piScene:{name:'Sample',path:'Assets/Sample.unity'}},{transport:{cwd:process.cwd()}});
 assert.match(r.args.Code,/Authorized Unity scene changed/);assert.ok(r.args.Code.indexOf('Authorized Unity scene changed')<r.args.Code.indexOf('GameObject.CreatePrimitive'));
});
