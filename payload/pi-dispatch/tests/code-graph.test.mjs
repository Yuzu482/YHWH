// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync,linkSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseSource} from '../scripts/code-graph-parser.mjs';
import {codeGraph,refreshCodeGraph} from '../scripts/code-graph.mjs';
import {createGatewayRuntime} from '../scripts/gateway.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const cli=fileURLToPath(new URL('../scripts/code-graph.mjs',import.meta.url));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'yhwh-code-graph-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,'-c','core.autocrlf=false',...args],{cwd:root,encoding:'utf8',windowsHide:true});
  const put=(path,source)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),source);};
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  put('.gitignore','ignored.js\n.yhwh/code-graph/*.tmp\n.yhwh/code-graph/*.lock\n');
  put('base.js','export class Base { run() {} }\n');
  put('use.js',"import {Base} from './base.js';\nexport class Use extends Base { run(){ helper(); } }\n");
  put('app.js',"import './use.js';\n");git('add','.');git('commit','-qm','fixture');
  return {root,git,put,index:join(root,'.yhwh/code-graph/index.json'),refresh:args=>refreshCodeGraph({cwd:root,...args}),query:args=>codeGraph({cwd:root,...args})};
}

test('AST evidence handles JS/TS/Python and excludes comments, strings and argument secrets',async()=>{
  const js=await parseSource('a.js',`// class Fake { run() { secret(); } }\nconst text="class Fake {}";\nexport class Real extends Base {run(){ helper('private-value'); }}\nconst fn=()=> new Real();`);
  assert.deepEqual(js.symbols.map(s=>s.name),['Real','run','fn']);assert.equal(js.mentions.filter(m=>m.kind==='base').length,1);
  assert.doesNotMatch(JSON.stringify(js),/Fake|secret|private-value/);
  assert.equal(js.mentions.find(m=>m.name==='helper').line,3);
  const ts=await parseSource('a.ts',"import type {Base} from './base'; interface Shape extends Base {} class A implements Shape { run():void {} }");
  assert.equal(ts.status,'parsed');assert.ok(ts.symbols.some(s=>s.kind==='type'&&s.name==='Shape'));
  const tsx=await parseSource('a.tsx','export function View(){ return <div/>; }');assert.equal(tsx.symbols[0].name,'View');
  const py=await parseSource('a.py','from .base import Base\nimport os as system\nclass Child(Base):\n def run(self):\n  helper("secret")\n');
  assert.deepEqual(py.symbols.map(s=>s.qualified),['Child','Child.run']);assert.deepEqual(py.imports.map(i=>i.specifier),['.base','os']);
  assert.equal(py.mentions.find(m=>m.kind==='call').line,5);assert.doesNotMatch(JSON.stringify(py),/secret/);
  assert.equal((await parseSource('bad.py','class :\n')).status,'parse-error');
});

test('persistent refresh, no-op reuse, cross-process reads, reverse dependency impact and pagination',async t=>{
  const f=fixture(t);const before=f.git('status','--porcelain=v1');const first=await f.refresh();
  assert.equal(first.parsed,3);assert.equal(first.written,true);assert.equal(first.modelCalls,0);
  const bytes=readFileSync(f.index),stamp=statSync(f.index).mtimeMs;
  const second=await f.refresh();assert.equal(second.parsed,0);assert.equal(second.reused,3);assert.equal(second.written,false);
  assert.deepEqual(readFileSync(f.index),bytes);assert.equal(statSync(f.index).mtimeMs,stamp);
  assert.equal(before,'');assert.match(f.git('status','--porcelain=v1'),/\?\? \.yhwh\//);
  const status=JSON.parse(execFileSync(process.execPath,[cli,JSON.stringify({cwd:f.root,action:'status'})],{encoding:'utf8',windowsHide:true}));assert.equal(status.stale,false);
  const impact=await f.query({action:'impact',id:'base.js'});assert.deepEqual(impact.items.map(i=>i.path),['use.js','app.js']);
  assert.equal((await f.query({action:'impact',id:'base.js',depth:1})).truncatedDepth,true);
  const search=await f.query({action:'search',query:'',limit:2});assert.equal(search.items.length,2);assert.equal(search.nextOffset,2);
  const related=await f.query({action:'neighbors',id:'use.js',direction:'outgoing'});assert.ok(related.items.some(e=>e.to==='base.js'&&e.resolution==='relative-path'));
  const call=(await f.query({action:'search',query:'helper'})).items[0];assert.equal(call.kind,'call-mention');
  assert.equal((await f.query({action:'neighbors',id:call.id})).items[0].resolution,'unresolved');
});

test('working changes invalidate queries; incremental update deletes obsolete declarations and edges',async t=>{
  const f=fixture(t);await f.refresh();
  f.put('use.js','export function replacement() {}\n');
  assert.equal((await f.query({action:'neighbors',id:'use.js'})).status,'stale');
  assert.ok((await f.query({action:'neighbors',id:'use.js',allowStale:true})).items.some(e=>e.to==='base.js'));
  const updated=await f.refresh();assert.equal(updated.parsed,1);assert.equal(updated.reused,2);
  assert.deepEqual((await f.query({action:'impact',id:'base.js'})).items,[]);
  assert.equal((await f.query({action:'search',query:'Use'})).items.filter(n=>n.kind==='class').length,0);
  rmSync(join(f.root,'base.js'));const missing=await f.refresh();assert.deepEqual(missing.changes.deleted,['base.js']);
  assert.equal((await f.query({action:'search',query:'Base'})).total,0);
});

test('rename, newly staged files and branch changes relink unchanged importer facts',async t=>{
  const f=fixture(t);await f.refresh();
  f.git('mv','base.js','renamed.js');const result=await f.refresh();assert.equal(result.parsed,1);
  assert.deepEqual(result.changes.deleted,['base.js']);assert.deepEqual(result.changes.added,['renamed.js']);
  const unresolved=await f.query({action:'neighbors',id:'use.js',direction:'outgoing'});assert.ok(unresolved.items.some(e=>e.resolution==='unresolved'));
  f.put('base.js','export class Base {}');f.git('add','base.js');await f.refresh();
  assert.deepEqual((await f.query({action:'impact',id:'base.js'})).items.map(x=>x.path),['use.js','app.js']);
  f.git('reset','--hard','-q','HEAD');assert.equal((await f.query({action:'status'})).stale,true);await f.refresh();
  f.git('checkout','-qb','other');f.put('use.js','export class Other {}');f.git('add','use.js');f.git('commit','-qm','branch');
  assert.deepEqual((await f.query({action:'status'})).changes.changed,['use.js']);
});

test('ambiguous imports, configuration aliases and Python absolute modules remain unresolved',async t=>{
  const f=fixture(t);f.put('base.ts','export class Base {}');f.put('alias.js',"import './base'; import '@/base'; import './missing.js';");
  f.put('pkg/__init__.py','');f.put('pkg/base.py','class Base: pass');f.put('pkg/use.py','from .base import Base\nimport pkg.base\nfrom ...base import Base\n');f.git('add','.');await f.refresh();
  const js=await f.query({action:'neighbors',id:'alias.js'});assert.deepEqual(js.items.map(e=>e.resolution),['ambiguous','unresolved','unresolved']);
  const py=await f.query({action:'neighbors',id:'pkg/use.py'});assert.deepEqual(py.items.map(e=>e.resolution),['relative-path','unresolved','unresolved']);
});

test('parser version changes force rebuild; broken source is reported without retaining old facts',async t=>{
  const f=fixture(t);await f.refresh();const old=JSON.parse(readFileSync(f.index));old.parserVersion='older';writeFileSync(f.index,JSON.stringify(old));
  assert.equal((await f.query({action:'status'})).stale,true);assert.equal((await f.refresh()).parsed,3);
  f.put('use.js','class {');const result=await f.refresh();assert.deepEqual(result.parseErrors,['use.js']);
  assert.equal((await f.query({action:'search',query:'Use'})).items.filter(n=>n.kind==='class').length,0);
});

test('lock and revision conflicts preserve previous bytes; malformed or linked index is refused',async t=>{
  const f=fixture(t);await f.refresh();const original=readFileSync(f.index);
  f.put('.yhwh/code-graph/refresh.lock','another owner');await assert.rejects(f.refresh(),/locked/);assert.deepEqual(readFileSync(f.index),original);
  rmSync(join(f.root,'.yhwh/code-graph/refresh.lock'));await assert.rejects(f.refresh({expectedRevision:'0'.repeat(64)}),/revision conflict/);
  assert.deepEqual(readFileSync(f.index),original);assert.equal(existsSync(join(f.root,'.yhwh/code-graph/refresh.lock')),false);
  writeFileSync(f.index,'{"unexpected":"secret text"}');await assert.rejects(f.query({action:'status'}),/Invalid code graph/);await assert.rejects(f.refresh(),/Invalid code graph/);
  writeFileSync(f.index,original);linkSync(f.index,join(f.root,'linked-index'));await assert.rejects(f.refresh(),/non-hardlinked/);
});

test('tracked ignored/secret files and unsupported languages are excluded; untracked code is not indexed',async t=>{
  const f=fixture(t);for(const path of ['ignored.js','.env.js','secrets.js','untracked.js','something.cs'])f.put(path,'class Fake {}');
  f.git('add','-f','ignored.js','.env.js','secrets.js','something.cs');const result=await f.refresh();
  assert.equal(result.files,3);assert.equal(result.unsupported['.cs'],1);assert.ok(result.excluded.some(e=>e.path==='ignored.js'));
  assert.doesNotMatch(readFileSync(f.index,'utf8'),/Fake|secret|untracked/);
});

test('unsafe source links, unsafe output directory, oversized/binary source fail closed',async t=>{
  const f=fixture(t);await f.refresh();const old=readFileSync(f.index);f.put('binary.py','\u0000');f.git('add','binary.py');
  await assert.rejects(f.refresh(),/Binary/);assert.deepEqual(readFileSync(f.index),old);
  f.put('binary.py','x'.repeat(1048577));await assert.rejects(f.refresh(),/size limit/);f.git('rm','-f','binary.py');
  linkSync(join(f.root,'base.js'),join(f.root,'hard.js'));f.git('add','hard.js');await assert.rejects(f.refresh(),/non-hardlinked/);
  f.git('rm','-f','hard.js');
  const outside=mkdtempSync(join(tmpdir(),'yhwh-graph-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  rmSync(join(f.root,'.yhwh/code-graph'),{recursive:true});symlinkSync(outside,join(f.root,'.yhwh/code-graph'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.refresh(),/Symlink/);assert.equal(existsSync(join(outside,'index.json')),false);
});

test('read API rejects write actions and request overruns; graph CLI has a bounded opt-in watch',async t=>{
  const f=fixture(t);
  for(const input of [{action:'refresh'},{action:'watch'},{limit:101},{offset:-1},{depth:9},{extra:true}])await assert.rejects(f.query(input));
  const result=execFileSync(process.execPath,[cli,JSON.stringify({cwd:f.root,action:'watch',durationSeconds:1,intervalSeconds:2})],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(JSON.parse(result.trim()).action,'refresh');assert.equal(existsSync(join(f.root,'.yhwh/code-graph/refresh.lock')),false);
});

test('MCP code graph is allowed-root confined, read-only, lifecycle admitted, and uses no model',async t=>{
  const f=fixture(t);await f.refresh();let models=0;
  const runtime=createGatewayRuntime({roots:[f.root],sandboxStatus:{ok:false},dispatchFn:async()=>{models++;throw new Error('No model expected');}});
  const server=runtime.makeServer(),client=new Client({name:'graph-test',version:'1.0'}),[a,b]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const output=await client.callTool({name:'code_graph',arguments:{cwd:f.root,action:'impact',id:'base.js'}});
    assert.equal(output.isError,false);assert.equal(JSON.parse(output.content[0].text).items.length,2);
    assert.equal((await client.callTool({name:'code_graph',arguments:{cwd:f.root,action:'refresh'}})).isError,true);
    assert.equal((await client.callTool({name:'code_graph',arguments:{cwd:tmpdir()}})).isError,true);
    assert.equal(models,0);await runtime.shutdown();assert.equal((await client.callTool({name:'code_graph',arguments:{cwd:f.root}})).isError,true);
  } finally {await client.close();await server.close();await runtime.shutdown();}
});

test('concurrent refreshers serialize with a lock and source drift preserves the prior graph',async t=>{
  const f=fixture(t);await f.refresh();
  const results=await Promise.allSettled([f.refresh(),f.refresh()]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/locked/);
  const original=readFileSync(f.index);let sequence=0;
  const timer=setInterval(()=>f.put('use.js',`export function change${++sequence}() {}\n`),50);
  try {await assert.rejects(f.refresh(),/Sources changed|File changed/);} finally {clearInterval(timer);}
  assert.ok(sequence>1);assert.deepEqual(readFileSync(f.index),original);
  assert.equal(existsSync(join(f.root,'.yhwh/code-graph/refresh.lock')),false);
});
