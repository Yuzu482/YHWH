import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {EditorBridge,validateConfig,configPath,registerEditor} from '../pi-extensions/editor-common/runtime.mjs';
import unity,{compileOperation,UnityBridge} from '../pi-extensions/unity/index.mjs';
import blender from '../pi-extensions/blender/index.mjs';
const fixture=resolve('tests/fixtures/editor-mcp.mjs');
function setup(options={}){
 const dir=mkdtempSync(join(tmpdir(),'pi-editors-'));
 const path=join(dir,'config.json');
 const config={version:1,enabled:true,allowWrites:true,timeoutMs:1500,maxOutputBytes:8192,transport:{type:'stdio',command:process.execPath,args:[fixture,join(dir,'counter')],cwd:process.cwd()},tools:{fixture_read:'read',fixture_write:'write',fixture_slow:'read',fixture_big:'read'},...options};
 writeFileSync(path,JSON.stringify(config));
 return {dir,path,config,bridge:new EditorBridge('blender',{path,stateDir:dir}),cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
test('independent names and config environment overrides',()=>{
 const names=[];const commands=[];const api={registerTool:t=>names.push(t.name),registerCommand:n=>commands.push(n)};
 unity(api);blender(api);
 assert.equal(new Set(names).size,6);assert.deepEqual(commands,['pi-unity','pi-blender']);
 assert.equal(configPath('unity',{PI_UNITY_CONFIG:resolve('unity.json')}),resolve('unity.json'));
 assert.notEqual(configPath('unity',{}),configPath('blender',{}));
});
test('reject remote endpoints, URL secrets, shells and reclassified writes',()=>{
 const s=setup();try{
  for(const url of ['http://example.com/mcp','http://localhost/mcp','http://127.0.0.1/mcp?token=x','http://user:pass@127.0.0.1/mcp'])assert.throws(()=>validateConfig({...s.config,transport:{type:'http',url}}));
  assert.throws(()=>validateConfig({...s.config,transport:{...s.config.transport,command:resolve('cmd.exe')}}));
  assert.throws(()=>validateConfig({...s.config,tools:{Unity_RunCommand:'read'}}));
 }finally{s.cleanup();}
});
test('unknown and disabled write tools fail before connecting',async()=>{
 const s=setup({allowWrites:false});try{
  await assert.rejects(s.bridge.invoke('call',{tool:'not_allowed',args:{}}),/allowlist/);
  await assert.rejects(s.bridge.invoke('call',{tool:'fixture_write',args:{},requestId:'one'}),/disabled/);
  assert.equal(existsSync(join(s.dir,'counter')),false);
 }finally{s.cleanup();}
});
test('real stdio MCP catalog/read and write ledger replay/conflict',async()=>{
 const s=setup();try{
  assert.equal((await s.bridge.invoke('status')).status,'connected');
  assert.equal((await s.bridge.invoke('call',{tool:'fixture_read',args:{}})).ok,true);
  const input={tool:'fixture_write',args:{value:'a'},requestId:'stable-write'};
  const a=await s.bridge.invoke('call',input);assert.equal(a.idempotency,'executed');
  const b=await new EditorBridge('blender',{path:s.path,stateDir:s.dir}).invoke('call',input);assert.equal(b.idempotency,'replayed');
  assert.equal(readFileSync(join(s.dir,'counter'),'utf8'),'1');
  await assert.rejects(s.bridge.invoke('call',{...input,args:{value:'b'}}),/reused|different|conflict/);
 }finally{s.cleanup();}
});
test('schema failure, cancellation, timeout and output bounds reject',async()=>{
 const s=setup();try{
  await assert.rejects(s.bridge.invoke('call',{tool:'fixture_read',args:{unexpected:1}}));
  const c=new AbortController();c.abort();await assert.rejects(s.bridge.invoke('status',{},c.signal),/cancelled/);
  const start=Date.now();await assert.rejects(s.bridge.invoke('call',{tool:'fixture_slow',args:{}}));assert.ok(Date.now()-start<7000);
  await assert.rejects(s.bridge.invoke('call',{tool:'fixture_big',args:{}}));
 }finally{s.cleanup();}
});
test('Unity accepts only typed operations, quotes text and confines assets',()=>{
 const c={transport:{cwd:process.cwd()},assetRoot:'Assets/PiGenerated'};
 const created=compileOperation('unity_create_object',{name:'x"; System.IO.File.Delete("x"); //',primitive:'Cube'},c);
 assert.match(created.args.Code,/@"x""; System.IO.File.Delete\(""x""\); \/\/"/);
 assert.throws(()=>compileOperation('Unity_RunCommand',{Code:'anything'},c));
 assert.throws(()=>compileOperation('unity_create_object',{name:'x',primitive:'Cube',Code:'injected'},c));
 assert.throws(()=>compileOperation('unity_save_prefab',{objectId:'1',fileName:'../outside'},c));
 assert.throws(()=>compileOperation('unity_create_material',{fileName:'ok',color:[1,1,1,1]},{...c,assetRoot:'Assets/../escape'}));
 assert.match(compileOperation('unity_save_prefab',{objectId:'1',fileName:'ok'},c).args.Code,/ReparsePoint/);
});
