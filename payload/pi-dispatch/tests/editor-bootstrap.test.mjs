import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

test('real wrapper forks child, passes prompt and inherited FD separately from bounded editor IPC',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-editor-pipe-'));
 copyFileSync(resolve('scripts/editor-pi-bootstrap.mjs'),join(dir,'editor-pi-bootstrap.mjs'));
 copyFileSync(resolve('scripts/editor-rpc.mjs'),join(dir,'editor-rpc.mjs'));
 copyFileSync(resolve('extensions/editor-proxy.js'),join(dir,'editor-proxy.mjs'));
 writeFileSync(join(dir,'secure-pi-bootstrap.mjs'),`import {readFileSync} from 'node:fs';
 import editorProxy from './editor-proxy.mjs';
 const credential=readFileSync(3,'utf8');if(credential!=='fixture-only')process.exit(3);
 let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
 if(prompt!=='fixture prompt')process.exit(4);
 process.stdout.write('{"type":"ready"}\\n');
 let tool,end;editorProxy({registerTool:t=>{tool=t;},on:(event,handler)=>{if(event==='agent_end')end=handler;}});
 const results=await Promise.all([tool.execute('',{operationId:'read-scene'}),tool.execute('',{operationId:'read-scene'})]);
 if(!results.every(r=>r.details.ok))process.exit(5);
 end();process.stdout.write('{"type":"done"}\\n');
 `);
 const child=spawn(process.execPath,[join(dir,'editor-pi-bootstrap.mjs')],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe','pipe']});
 let out='',err='',buffer='',answered=false;
 child.stdout.setEncoding('utf8').on('data',chunk=>{out+=chunk;buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.startsWith('PI_EDITOR_RPC=')){const m=JSON.parse(line.slice(14));assert.ok([1,2].includes(m.id));assert.equal(m.operationId,'read-scene');answered=true;child.stdin.write(JSON.stringify({id:m.id,result:{ok:true}})+'\n');}}});
 child.stderr.on('data',b=>{err+=b;});child.stdin.on('error',()=>{});
 child.stdio[3].end('fixture-only');child.stdin.write(JSON.stringify({prompt:'fixture prompt'})+'\n');
 const timer=setTimeout(()=>child.kill(),8000);
 try{const code=await new Promise((done,reject)=>{child.on('close',done);child.on('error',reject);});assert.equal(code,0,err);assert.equal(answered,true);assert.match(out,/"type":"done"/);assert.doesNotMatch(out,/fixture-only/);}finally{clearTimeout(timer);child.kill();rmSync(dir,{recursive:true,force:true});}
});
