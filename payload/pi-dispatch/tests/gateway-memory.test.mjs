import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {createProjectMemoryContext} from '../scripts/project-memory-context.mjs';
import {projectMemory} from '../scripts/project-memory.mjs';
import {closeProjectMemoryIndexCache} from '../scripts/project-memory-index.mjs';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {createTaskMonitor} from '../extensions/task-monitor.js';
import {listenHttpFixture} from './http-fixture.mjs';
import {roleValue} from './contract-fixtures.mjs';

const token='gateway-memory-fixture-0123456789';
const parse=r=>JSON.parse(r.content[0].text);
function fixture(t,{memory=true}={}){
 const root=mkdtempSync(join(tmpdir(),'yhwh-gateway-memory-'));t.after(()=>{closeProjectMemoryIndexCache();rmSync(root,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8'});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(root,'source.md'),'architecture design facts');git('add','source.md');git('commit','-qm','fixture');
 if(memory)mkdirSync(join(root,'.yhwh','memory'),{recursive:true});return {root,git};
}
async function knowledge(root,id,title,body='Verified architecture reference',paths=['source.md']){
 const snap=await projectMemory({cwd:root,action:'snapshot',paths});
 const meta={schemaVersion:1,id,kind:'architecture',status:'accepted',title,tags:['architecture'],sources:snap.sources.map(({path,sha256})=>({path,sha256})),sourceCommit:snap.sourceCommit,reviewedAt:'2026-09-20'};
 writeFileSync(join(root,'.yhwh','memory',`${id}.md`),`---\n${JSON.stringify(meta)}\n---\n${body}\n`);
}

test('actual MCP worker dispatch injects fresh scoped memory into a clone only',async t=>{
 const {root,git}=fixture(t);await knowledge(root,'architecture','Architecture 架构','Architecture decisions are documented.');
 writeFileSync(join(root,'git-reference.md'),'baseline evidence');git('add','git-reference.md');git('commit','-qm','add Git reference');writeFileSync(join(root,'git-reference.md'),'changed evidence');
 const incoming={role:'worker',objective:'请解释架构 architecture',context:['original context'],readScope:['source.md','git-reference.md'],acceptance:['Report']};
 const original=structuredClone(incoming),captured=[];
 const options={host:'127.0.0.1',port:0,roots:[root],token,requestLedgerDir:join(root,'.ledger'),sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5},dispatchFn:async(request,_signal,task)=>{captured.push(task);return {ok:true,provider:request.provider,model:request.model,text:`KETHER_RESULT_JSON=${JSON.stringify(roleValue(task.role))}`};}};
 const {app,runtime}=createGatewayApp(options),server=await listenHttpFixture(app),client=new Client({name:'gateway-memory-test',version:'1'});
 try{
  const headers=new Headers();headers.set('Authorization',['Bearer',token].join(' '));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers}}));
  const response=parse(await client.callTool({name:'dispatch_subagent',arguments:{cwd:root,provider:'openai-codex',model:'gpt-6-luna',access:'read',resourceProfile:'small',task:incoming}}));
  assert.equal(response.ok,true);assert.deepEqual(incoming,original);assert.equal(captured.length,1);
  const injected=captured[0].context.slice(1).join('\n');assert.match(injected,/UNTRUSTED GIT REFERENCE DATA/);assert.match(injected,/git-reference\.md/);assert.match(injected,/UNTRUSTED PROJECT MEMORY REFERENCE DATA/);assert.match(injected,/"status":"accepted"/);assert.match(injected,/"freshness":"fresh"/);
  assert.equal(existsSync(join(root,'.yhwh','memory-index','index.json')),true);
 }finally{await client.close();await runtime.shutdown({graceMs:50,abortWaitMs:50}).catch(()=>{});await new Promise(resolve=>server.close(resolve));}
});

test('injects scoped Git evidence without a memory directory and preserves original context',async t=>{
 const {root}=fixture(t,{memory:false});writeFileSync(join(root,'source.md'),'changed evidence');
 const memory=createProjectMemoryContext({roots:[root]}),original=['original context','entry two'],task={role:'worker',objective:'Inspect this change',context:original,readScope:['source.md'],writeScope:[]};
 try{const injected=await memory.inject({cwd:root,task,access:'workspace-write',operation:'dispatch_subagent'});assert.deepEqual(injected.context.slice(0,2),original);assert.ok(injected.context.slice(2).join('\n').includes('UNTRUSTED GIT REFERENCE DATA'));assert.ok(!existsSync(join(root,'.yhwh','memory')));assert.ok(Buffer.byteLength(injected.context.join('\n'),'utf8')<=8192);assert.ok(injected.context.every(entry=>entry.length<=4000));
  const full={...task,context:Array.from({length:64},(_,i)=>`original ${i}`)};assert.equal(await memory.inject({cwd:root,task:full,access:'read'}),full);
 }finally{memory.close();}
});

test('injection propagates prompt abort and reserves Git budget alongside memory',async t=>{
 const {root,git}=fixture(t);await knowledge(root,'architecture','Architecture','Verified architecture reference');
 writeFileSync(join(root,'dirty-a.md'),`baseline\n`);writeFileSync(join(root,'dirty-b.md'),`baseline\n`);git('add','dirty-a.md','dirty-b.md');git('commit','-qm','tracked Git evidence');
 writeFileSync(join(root,'dirty-a.md'),`changed\n${'a'.repeat(3000)}`);writeFileSync(join(root,'dirty-b.md'),`changed\n${'b'.repeat(3000)}`);
 const memory=createProjectMemoryContext({roots:[root]}),controller=new AbortController();
 try{
  controller.abort();await assert.rejects(memory.inject({cwd:root,task:{role:'worker',objective:'architecture',context:[]},access:'read',signal:controller.signal}),{name:'AbortError'});
  const context=Array.from({length:10},(_,i)=>`caller ${i} ${'x'.repeat(300)}`),task={role:'worker',objective:'architecture',context,readScope:['source.md','dirty-a.md','dirty-b.md']};
  const pendingController=new AbortController();const pending=memory.inject({cwd:root,task:{...task,context:[]},access:'read',signal:pendingController.signal});pendingController.abort();await assert.rejects(pending,{name:'AbortError'});
  const result=await memory.inject({cwd:root,task,access:'read'});assert.deepEqual(result.context.slice(0,context.length),context);
  assert.ok(result.context.some(x=>x.startsWith('UNTRUSTED PROJECT MEMORY REFERENCE DATA;')&&x.includes('"freshness":"fresh"')));
  const gitEvidence=result.context.filter(x=>x.startsWith('UNTRUSTED GIT REFERENCE DATA;'));
  assert.ok(gitEvidence.some(x=>x.includes('category=unstaged')));
  assert.ok(Buffer.byteLength(gitEvidence.join('\n'),'utf8')<=4096);
  assert.ok(Buffer.byteLength(result.context.join('\n'),'utf8')<=8192);
 }finally{memory.close();}
});

test('injection gates reviewer/probe/none, authorizes every source, handles Chinese and enforces count/byte bounds',async t=>{
 const {root,git}=fixture(t);mkdirSync(join(root,'private'),{recursive:true});writeFileSync(join(root,'private','untracked.md'),'not an authorized Git source');git('add','private/untracked.md');git('commit','-qm','include snapshot source');
 for(let i=0;i<7;i++)await knowledge(root,`architecture-${i}`,'Architecture 架构',`架构 architecture ${'知识'.repeat(800)}`);
 await knowledge(root,'unauthorized','Architecture private','架构 architecture private',['source.md','private/untracked.md']);
 const memory=createProjectMemoryContext({roots:[root]}),base={objective:'架构设计 architecture',context:[],readScope:['source.md','source.md'],writeScope:[]};
 try{
  for(const input of [{task:{...base,role:'Geburah'},access:'read'},{task:{...base,role:'worker'},access:'none'},{task:{...base,role:'worker'},access:'read',operation:'probe_model'}])assert.equal(await memory.inject({cwd:root,...input}),input.task);
  const task={...base,role:'worker'};const result=await memory.inject({cwd:root,task,access:'read',operation:'dispatch_subagent'});
  assert.equal(task.context.length,0);assert.ok(result.context.length<=5);assert.ok(result.context.every(text=>!text.includes('unauthorized')));
  assert.ok(Buffer.byteLength(result.context.join('\n'),'utf8')<=8192);assert.ok(result.context.join('\n').includes('freshness'));
  const denied=await memory.inject({cwd:root,task:{...task,readScope:['elsewhere/**']},access:'read'});assert.ok(denied.context.every(text=>!text.includes('elsewhere')&&!text.includes('source.md')&&!text.includes('architecture-')));assert.ok(!denied.context.some(text=>text.includes('UNTRUSTED PROJECT MEMORY REFERENCE DATA')));
 }finally{memory.close();}
});

test('monitor evicts RAM only after durable persistence and restores full paginated result after restart',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-monitor-ledger-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ledger=createRequestLedger(dir);const monitor=createTaskMonitor({gatewayInstanceId:'fixture-one',maxEntries:16,maxResultBytes:0,terminalTtlMs:3600000,maintenanceIntervalMs:0,persistResult:(id,value)=>ledger.saveMonitorResult(id,value),loadResult:id=>ledger.readMonitorResult(id)});
 const text='full durable monitor result '.repeat(3000);monitor.submit({requestId:'monitor-result-1',task:{role:'worker'},provider:'fixture',model:'fixture',access:'read'},async()=>({ok:true,text}));
 for(let i=0;i<100&&monitor.get('monitor-result-1')?.state!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(monitor.get('monitor-result-1').state,'completed');
 const restartedLedger=createRequestLedger(dir);const restored=createTaskMonitor({gatewayInstanceId:'fixture-two',maxEntries:16,maxResultBytes:0,maintenanceIntervalMs:0,loadResult:id=>restartedLedger.readMonitorResult(id)});
 const first=restored.getResult('monitor-result-1',{offset:0,limit:1024});assert.equal(first.ok,true);assert.equal(first.ready,true);assert.equal(first.resultJsonChunk.length,1024);
 const chunks=[first.resultJsonChunk];let page=first;while(page.nextOffset!==null){page=restored.getResult('monitor-result-1',{offset:page.nextOffset,limit:1024});assert.equal(page.sha256,first.sha256);chunks.push(page.resultJsonChunk);}
 assert.equal(JSON.parse(chunks.join('')).text,text);
 monitor.close();restored.close();
});
