// Opt-in isolated Blender test. Never attaches to a user's open scene.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import {EditorBridge} from '../pi-extensions/editor-common/runtime.mjs';
const executable=process.env.PI_BLENDER_EXE;
if(!executable)throw new Error('Set PI_BLENDER_EXE to the native Blender executable');
const dir=mkdtempSync(join(tmpdir(),'pi-blender-live-'));
const port=await new Promise((done,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p));});});
const tokenFile=join(dir,'token');writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
const tools={blender_scene_info:'read',blender_create_object:'write',blender_set_transform:'write',blender_delete_object:'write',blender_set_material:'write',blender_save_copy:'write',blender_export_glb:'write'};
writeFileSync(join(dir,'server.json'),JSON.stringify({version:1,port,tokenFile,assetRoot:dir,allowWrites:true}));
const config=join(dir,'client.json');writeFileSync(config,JSON.stringify({version:1,enabled:true,allowWrites:true,timeoutMs:30000,transport:{type:'http',url:`http://127.0.0.1:${port}/mcp`,tokenFile},tools}));
const child=spawn(executable,['--background','--factory-startup','--python',resolve('tests/blender-bridge.live.py')],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,PI_EDITOR_TEST_ROOT:dir,PI_EDITOR_ADDON:resolve('pi-extensions/blender/addon/pi_blender_bridge.py')}});
let stdout='';child.stdout.on('data',b=>{stdout=(stdout+b).slice(-16000);});child.stderr.resume();
const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));
const checks=[];
try{
 await new Promise((resolve,reject)=>{const started=Date.now();const t=setInterval(()=>{if(stdout.includes('PI_BLENDER_READY')){clearInterval(t);resolve();}else if(child.exitCode!==null||Date.now()-started>20000){clearInterval(t);reject(new Error('Blender did not become ready'));}},100);});
 const bridge=new EditorBridge('blender',{path:config,stateDir:dir});
 assert.equal((await bridge.invoke('status')).status,'connected');checks.push('MCP initialize and tools/list');
 const unauthorized=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',body:'{}'});assert.equal(unauthorized.status,403);checks.push('unauthenticated request rejected');
 async function call(tool,args,id){const r=await bridge.invoke('call',{tool,args,requestId:id});assert.equal(r.ok,true,JSON.stringify(r));return r;}
 const before=await call('blender_scene_info',{});const info=JSON.parse(before.result.content[0].text);assert.equal(info.file,'');checks.push('isolated factory scene verified');
 const wrongScene=await bridge.invoke('call',{tool:'blender_create_object',args:{name:'PiWrongScene',primitive:'cube',_piScene:{name:'NotTheAuthorizedScene',path:''}},requestId:'scene-denied'});
 assert.equal(wrongScene.ok,false);
 const unchanged=JSON.parse((await call('blender_scene_info',{})).result.content[0].text);assert.equal(unchanged.objectCount,info.objectCount);checks.push('scene mismatch rejected before mutation');
 await call('blender_create_object',{name:'PiLiveCube',primitive:'cube',_piScene:{name:info.scene,path:info.file}},'create-one');
 await call('blender_set_transform',{name:'PiLiveCube',position:[1,2,3],rotation:[0,45,0],scale:[1,2,1]},'transform-one');
 await call('blender_set_material',{name:'PiLiveCube',materialName:'PiLiveMaterial',color:[0.2,0.5,0.8,1]},'material-one');checks.push('create, transform, material');
 const replay=await call('blender_create_object',{name:'PiLiveCube',primitive:'cube',_piScene:{name:info.scene,path:info.file}},'create-one');assert.equal(replay.idempotency,'replayed');checks.push('write replay without duplicate object');
 const scene=JSON.parse((await call('blender_scene_info',{})).result.content[0].text);assert.deepEqual(scene.objects.find(o=>o.name==='PiLiveCube').position,[1,2,3]);
 await call('blender_save_copy',{fileName:'test.blend'},'save-one');assert.ok(statSync(join(dir,'test.blend')).size>0);checks.push('save .blend copy');
 await call('blender_export_glb',{fileName:'test.glb'},'export-one');assert.ok(statSync(join(dir,'test.glb')).size>0);checks.push('export GLB');
 const outside=await bridge.invoke('call',{tool:'blender_save_copy',args:{fileName:'../outside.blend'},requestId:'reject-outside'});assert.equal(outside.ok,false);checks.push('path traversal rejected');
 const overwrite=await bridge.invoke('call',{tool:'blender_save_copy',args:{fileName:'test.blend'},requestId:'reject-overwrite'});assert.equal(overwrite.ok,false);checks.push('overwrite rejected');
 await call('blender_delete_object',{name:'PiLiveCube'},'delete-one');checks.push('delete');
 console.log(JSON.stringify({ok:true,checks,artifacts:dir},null,2));
}finally{
 writeFileSync(join(dir,'stop'),'stop');
 let killTimer;await Promise.race([exited,new Promise(resolve=>{killTimer=setTimeout(()=>{child.kill();resolve();},5000);})]);clearTimeout(killTimer);
}
