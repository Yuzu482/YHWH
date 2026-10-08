import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {projectMemory} from '../scripts/project-memory.mjs';
import {refreshProjectMemoryIndex,closeProjectMemoryIndexCache,projectMemoryIndexCacheForTests} from '../scripts/project-memory-index.mjs';

test('private index refreshes on disk and a separate process searches canonical Markdown truth',async t=>{
 const root=mkdtempSync(join(tmpdir(),'yhwh-memory-index-'));t.after(()=>{closeProjectMemoryIndexCache();rmSync(root,{recursive:true,force:true});});
 const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8'});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(root,'source.md'),'tracked truth');git('add','source.md');git('commit','-qm','fixture');
 mkdirSync(join(root,'.yhwh','memory'),{recursive:true});
 const snapshot=await projectMemory({cwd:root,action:'snapshot',paths:['source.md']});
 const {sources}=snapshot;
 const generatedDummy=randomBytes(24).toString('hex');
 const meta={schemaVersion:1,id:'architecture',kind:'architecture',status:'accepted',title:'中文 Architecture',tags:['design'],sources:sources.map(({path,sha256})=>({path,sha256})),sourceCommit:snapshot.sourceCommit,reviewedAt:'2026-09-20'};
 const fixtureBody=JSON.stringify(Object.fromEntries([['api_key',generatedDummy]]));
 writeFileSync(join(root,'.yhwh','memory','architecture.md'),`---\n${JSON.stringify(meta)}\n---\nPrimary knowledge record ${fixtureBody}\n`);
 const refreshed=await refreshProjectMemoryIndex({cwd:root});assert.equal(refreshed.written,true);
 const index=join(root,'.yhwh','memory-index','index.json');assert.equal(existsSync(index),true);assert.equal(readFileSync(index,'utf8').includes(generatedDummy),false);assert.match(readFileSync(index,'utf8'),/REDACTED/);
 const cli=fileURLToPath(new URL('../scripts/project-memory.mjs',import.meta.url));
 const out=execFileSync(process.execPath,[cli,JSON.stringify({cwd:root,action:'search',query:'Architecture'})],{encoding:'utf8'});
 assert.equal(JSON.parse(out).entries[0].id,'architecture');
 const before=readFileSync(index);await projectMemory({cwd:root,action:'search',query:'中文'});assert.deepEqual(readFileSync(index),before);
 const stat=await import('node:fs/promises');const mtime=(await stat.stat(index)).mtimeMs;
 assert.equal((await refreshProjectMemoryIndex({cwd:root})).written,false);assert.equal((await stat.stat(index)).mtimeMs,mtime);
 writeFileSync(index,JSON.stringify({version:1,root,entries:[{id:'forged',file:'.yhwh/memory/forged.md',revision:'0'.repeat(64)}]}));
 assert.equal((await projectMemory({cwd:root,action:'search',query:'forged',includeInactive:true})).matches,0);
 assert.equal((await refreshProjectMemoryIndex({cwd:root})).written,true);
 const good=readFileSync(index);writeFileSync(join(root,'.yhwh','memory-index','refresh.lock'),'owned elsewhere');
 await assert.rejects(refreshProjectMemoryIndex({cwd:root}),/locked/);assert.deepEqual(readFileSync(index),good);
});

test('private cache enforces byte budget, TTL, LRU and project isolation',()=>{
 let now=0;const cache=projectMemoryIndexCacheForTests({cacheBytes:8,globalBytes:12,ttlMs:10,now:()=>now});
 cache.set('a','12345678');cache.set('oversized','123456789');assert.equal(cache.get('a'),'12345678');assert.equal(cache.get('oversized'),null);
 cache.set('b','abcdefgh');cache.set('c','ijklmnop');assert.equal(cache.get('a'),null);assert.equal(cache.get('c'),'ijklmnop');
 now=11;assert.equal(cache.get('c'),null);
 cache.set('expired','expired');now=22;cache.pruneExpired();assert.equal(cache.size,0);cache.clear();assert.equal(cache.size,0);
});
