import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectMemory} from '../scripts/project-memory.mjs';
import {createGatewayRuntime} from '../scripts/gateway.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'yhwh-knowledge-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,'-c','core.autocrlf=false',...args],{cwd:root,encoding:'utf8',windowsHide:true});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(root,'source.md'),'# Architecture\nPrimary owns acceptance.\n');
  writeFileSync(join(root,'.gitignore'),'.env\nignored.md\n');git('add','source.md','.gitignore');git('commit','-qm','fixture');
  mkdirSync(join(root,'.yhwh','memory'),{recursive:true});
  const call=args=>projectMemory({cwd:root,...args});
  async function entry(id='architecture',status='accepted',body='主代理架构。 Primary retains acceptance.',paths=['source.md']) {
    const snapshot=await call({action:'snapshot',paths});assert.equal(snapshot.ok,true);
    const meta={schemaVersion:1,id,kind:'architecture',status,title:'主代理架构 Primary architecture',tags:['primary','架构'],
      sources:snapshot.sources.map(({path,sha256})=>({path,sha256})),sourceCommit:snapshot.sourceCommit,reviewedAt:status==='accepted'?'2026-09-20':null};
    const file=join(root,'.yhwh','memory',`${id}.md`);
    writeFileSync(file,`---\n${JSON.stringify(meta,null,2)}\n---\n${body}\n`);
    return {file,meta};
  }
  return {root,git,call,entry};
}

test('knowledge persists across reads; Chinese/English search respects lifecycle and freshness',async t=>{
  const f=fixture(t);await f.entry();await f.entry('draft-note','draft');await f.entry('old-note','deprecated');
  assert.equal((await f.call({action:'search',query:'架构'})).matches,1);
  assert.equal((await f.call({action:'search',query:'primary',includeInactive:true})).matches,3);
  const read=await projectMemory({cwd:f.root,action:'read',id:'architecture'});
  assert.equal(read.entry.usable,true);assert.match(read.entry.body,/acceptance/);assert.equal(read.modelCalls,0);
  writeFileSync(join(f.root,'source.md'),'Changed source\n');
  const review=await f.call({action:'review'});assert.equal(review.needsReview,true);
  assert.equal(review.entries[0].sources[0].state,'changed');assert.equal((await f.call({action:'search',query:'primary'})).matches,0);
  assert.equal((await f.call({action:'read',id:'architecture'})).entry.status,'accepted');
});

test('snapshot normalizes CRLF; file removal, staged removal and branch switch invalidate dependent facts',async t=>{
  const f=fixture(t);await f.entry();
  const original=readFileSync(join(f.root,'source.md'),'utf8');writeFileSync(join(f.root,'source.md'),original.replaceAll('\n','\r\n'));
  assert.equal((await f.call({action:'read',id:'architecture'})).entry.freshness,'fresh');
  rmSync(join(f.root,'source.md'));
  assert.equal((await f.call({action:'read',id:'architecture'})).entry.sources[0].state,'missing');
  f.git('add','-u');assert.equal((await f.call({action:'read',id:'architecture'})).entry.sources[0].state,'unverifiable');
  f.git('reset','--hard','-q');f.git('checkout','-qb','changed-source');writeFileSync(join(f.root,'source.md'),'Other branch\n');f.git('add','source.md');f.git('commit','-qm','other branch');
  assert.equal((await f.call({action:'read',id:'architecture'})).entry.freshness,'needs-review');
});

test('review exposes staged, unstaged, untracked and deleted memory without touching Git index',async t=>{
  const f=fixture(t);const {file}=await f.entry();f.git('add','.yhwh');f.git('commit','-qm','knowledge');
  const baseline=f.git('rev-parse','HEAD').trim();
  writeFileSync(file,readFileSync(file,'utf8').replace('retains acceptance','retains final acceptance'));f.git('add','.yhwh');
  writeFileSync(file,readFileSync(file,'utf8').replace('final acceptance','final tested acceptance'));
  await f.entry('new-note','draft');const before=f.git('status','--porcelain=v1');const indexBefore=readFileSync(join(f.root,'.git','index'));
  const review=await f.call({action:'review',baseline});
  assert.match(review.gitDiff.staged.text,/final acceptance/);assert.match(review.gitDiff.unstaged.text,/final tested/);
  assert.deepEqual(review.gitDiff.untracked,['.yhwh/memory/new-note.md']);assert.match(review.gitDiff.untrackedAdditions.text,/\+主代理/);
  assert.equal(review.gitDiff.comparison.commit,baseline);assert.equal(f.git('status','--porcelain=v1'),before);assert.deepEqual(readFileSync(join(f.root,'.git','index')),indexBefore);
  rmSync(file);assert.match((await f.call({action:'review'})).gitDiff.unstaged.text,/deleted file/);
});

test('untracked/ignored/credential/binary/oversized sources cannot become verified facts',async t=>{
  const f=fixture(t);
  for(const name of ['untracked.md','ignored.md','.env'])writeFileSync(join(f.root,name),'test only\n');
  f.git('add','-f','ignored.md','.env');
  for(const path of ['untracked.md','ignored.md'])assert.equal((await f.call({action:'snapshot',paths:[path]})).ok,false);
  for(const path of ['.env','../outside','/outside','source.md:stream','..\\outside','.git/config','.yhwh/memory/architecture.md'])await assert.rejects(f.call({action:'snapshot',paths:[path]}));
  writeFileSync(join(f.root,'binary.md'),Buffer.from([0,1,2]));writeFileSync(join(f.root,'large.md'),'x'.repeat(1048577));f.git('add','binary.md','large.md');
  for(const path of ['binary.md','large.md'])assert.equal((await f.call({action:'snapshot',paths:[path]})).ok,false);
});

test('symlink/junction memory directories and hardlinked sources are rejected',async t=>{
  const f=fixture(t),outside=mkdtempSync(join(tmpdir(),'yhwh-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  writeFileSync(join(outside,'private.md'),'not project evidence');
  symlinkSync(outside,join(f.root,'link'),process.platform==='win32'?'junction':'dir');
  // Snapshot also requires tracking; mark a source tracked before replacing its ancestor.
  mkdirSync(join(f.root,'sub'));writeFileSync(join(f.root,'sub','private.md'),'tracked');f.git('add','sub/private.md');rmSync(join(f.root,'sub'),{recursive:true});symlinkSync(outside,join(f.root,'sub'),process.platform==='win32'?'junction':'dir');
  assert.equal((await f.call({action:'snapshot',paths:['sub/private.md']})).ok,false);
  linkSync(join(f.root,'source.md'),join(f.root,'hard.md'));f.git('add','hard.md');assert.equal((await f.call({action:'snapshot',paths:['hard.md']})).ok,false);
  rmSync(join(f.root,'.yhwh','memory'),{recursive:true});symlinkSync(outside,join(f.root,'.yhwh','memory'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.call({action:'list'}),/Symlink/);
});

test('invalid frontmatter, filename mismatch, unknown schema and oversized records are visible errors',async t=>{
  const f=fixture(t),{file,meta}=await f.entry();
  writeFileSync(file,'---\n{"password":"do-not-echo",}\n---\ntext');let result=await f.call({action:'review'});assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result.errors),/do-not-echo/);
  for(const invalid of [{...meta,id:'other'},{...meta,schemaVersion:2},{...meta,unexpected:true},{...meta,reviewedAt:null},{...meta,sources:[{path:'../secret',sha256:'0'.repeat(64)}]}]){
    writeFileSync(file,`---\n${JSON.stringify(invalid)}\n---\nbody`);assert.equal((await f.call({action:'list'})).ok,false);
  }
  writeFileSync(file,'x'.repeat(16385));assert.equal((await f.call({action:'list'})).ok,false);
  writeFileSync(join(f.root,'.yhwh','memory','other.txt'),'unmanaged');assert.equal((await f.call({action:'list'})).errors.length,2);
});

test('Git diff does not run configured external diff/textconv/fsmonitor; baseline rejects arguments',async t=>{
  const f=fixture(t);const {file}=await f.entry();f.git('add','.yhwh');f.git('commit','-qm','knowledge');
  const marker=join(f.root,'executed'),script=join(f.root,'hook.cjs');writeFileSync(script,`require('fs').writeFileSync(${JSON.stringify(marker)},'BAD');`);
  const command=`"${process.execPath.replaceAll('\\','/')}" "${script.replaceAll('\\','/')}"`;
  f.git('config','diff.external',command);f.git('config','diff.danger.textconv',command);f.git('config','core.fsmonitor',command);
  writeFileSync(join(f.root,'.gitattributes'),'.yhwh/memory/*.md diff=danger\n');writeFileSync(file,readFileSync(file,'utf8')+'Changed\n');
  await f.call({action:'review',baseline:'HEAD'});assert.equal(existsSync(marker),false);
  for(const baseline of ['--output=outside','HEAD~1','HEAD;echo unsafe'])await assert.rejects(f.call({action:'review',baseline}),/baseline/);
});

test('freshness survives reopen and concurrent edits are detected on next read; redacts common credentials',async t=>{
  const f=fixture(t);await f.entry('architecture','accepted','Architecture\napi_key: fake-secret-for-test\n');
  const first=await f.call({action:'read',id:'architecture'});assert.doesNotMatch(first.entry.body,/fake-secret/);assert.match(first.entry.body,/REDACTED/);
  writeFileSync(join(f.root,'source.md'),'new version');const next=await projectMemory({cwd:f.root,action:'read',id:'architecture'});assert.equal(next.entry.usable,false);
  assert.equal(next.entry.revision,first.entry.revision);
});

test('missing memory is empty, ignores are reported, and subdirectory/non-Git requests fail clearly',async t=>{
  const f=fixture(t);rmSync(join(f.root,'.yhwh'),{recursive:true});assert.equal((await f.call({action:'list'})).total,0);
  mkdirSync(join(f.root,'.yhwh','memory'),{recursive:true});await f.entry();writeFileSync(join(f.root,'.gitignore'),'.yhwh/\n');
  const report=await f.call({action:'review'});assert.deepEqual(report.gitDiff.ignored,['.yhwh/memory/architecture.md']);
  await assert.rejects(projectMemory({cwd:join(f.root,'.yhwh'),action:'list'}),/worktree root/);
  const noGit=mkdtempSync(join(tmpdir(),'yhwh-no-git-'));t.after(()=>rmSync(noGit,{recursive:true,force:true}));await assert.rejects(projectMemory({cwd:noGit}),/Git inspection failed/);
});

test('actual MCP session discovers read-only knowledge tool, enforces roots and never calls models',async t=>{
  const f=fixture(t);await f.entry();let modelCalls=0;
  const runtime=createGatewayRuntime({roots:[f.root],sandboxStatus:{ok:false},dispatchFn:async()=>{modelCalls++;throw new Error('Unexpected dispatch');}});
  const server=runtime.makeServer(),client=new Client({name:'memory-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(b);await client.connect(a);const available=(await client.listTools()).tools.find(t=>t.name==='project_memory');assert.equal(available.annotations.readOnlyHint,true);
    const result=await client.callTool({name:'project_memory',arguments:{cwd:f.root,action:'search',query:'架构'}});assert.equal(JSON.parse(result.content[0].text).matches,1);
    const denied=await client.callTool({name:'project_memory',arguments:{cwd:tmpdir(),action:'list'}});assert.equal(denied.isError,true);
    const writer=await client.callTool({name:'project_memory',arguments:{cwd:f.root,action:'write'}});assert.equal(writer.isError,true);
    const caps=JSON.parse((await client.callTool({name:'list_capabilities',arguments:{}})).content[0].text);assert.equal(caps.projectMemory.readOnly,true);assert.equal(modelCalls,0);
    await runtime.shutdown();const closed=await client.callTool({name:'project_memory',arguments:{cwd:f.root}});assert.equal(closed.isError,true);
  }finally{await client.close();await server.close();await runtime.shutdown();}
});

test('entry count and request bounds fail explicitly, and invalid dates cannot imply review',async t=>{
  const f=fixture(t),{file,meta}=await f.entry();
  writeFileSync(file,`---\n${JSON.stringify({...meta,reviewedAt:'2026-02-31'})}\n---\nbody`);
  assert.equal((await f.call({action:'list'})).ok,false);
  for(const input of [{limit:51},{action:'write'},{query:'x'.repeat(201)},{extra:'ignored?'}])await assert.rejects(f.call(input),/Invalid/);
  for(let i=0;i<256;i++)writeFileSync(join(f.root,'.yhwh','memory',`note-${i}.md`),'x');
  await assert.rejects(f.call({action:'review'}),/Too many files/);
});

test('space, Unicode and glob-like source names remain literal; patch truncation is explicit',async t=>{
  const f=fixture(t),name='source [1] 中文.md';writeFileSync(join(f.root,name),'literal source\n');f.git('add',name);
  await f.entry('literal','accepted','Literal source',['source [1] 中文.md']);
  assert.equal((await f.call({action:'read',id:'literal'})).entry.usable,true);
  for(let i=0;i<6;i++)await f.entry(`note-${i}`,'draft','x'.repeat(13000));
  const report=await f.call({action:'review'});assert.equal(report.gitDiff.untrackedAdditions.truncated,true);assert.ok(report.gitDiff.untrackedAdditions.text.length<=65536);
});

test('read-only CLI observes saved records in another process',async t=>{
  const f=fixture(t);await f.entry();
  const {fileURLToPath}=await import('node:url');
  const cli=fileURLToPath(new URL('../scripts/project-memory.mjs',import.meta.url));
  const output=execFileSync(process.execPath,[cli,JSON.stringify({cwd:f.root,action:'read',id:'architecture'})],{encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(output).entry.usable,true);
});
