import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {collectGitDiffContext} from '../scripts/git-diff-context.mjs';

test('root aliases match physical approved roots; invalid roots neither grant nor shadow valid roots',async t=>{
 const outer=mkdtempSync(join(tmpdir(),'yhwh-git-alias-'));t.after(()=>rmSync(outer,{recursive:true,force:true}));
 const root=join(outer,'repository'),alias=join(outer,'alias');mkdirSync(root);
 const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8'});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(root,'source.txt'),'baseline\n');git('add','source.txt');git('commit','-qm','baseline');
 writeFileSync(join(root,'source.txt'),'changed\n');
 try{symlinkSync(root,alias,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','ENOTSUP','EACCES'].includes(error.code)){t.skip(`directory alias creation unavailable: ${error.code}`);return;}throw error;}
 assert.notEqual(alias,realpathSync(alias));assert.equal(realpathSync(alias),realpathSync(root));
 const collect=roots=>collectGitDiffContext({cwd:alias,roots,readScope:['source.txt'],writeScope:[]});
 const accepted=await collect([alias]);assert.ok(accepted.contexts.some(x=>x.includes('category=unstaged')&&x.includes('path=source.txt')));
 const denied=await collect([join(outer,'missing')]);assert.ok(!denied.contexts.some(x=>x.includes('category=unstaged')));
 const recovered=await collect([join(outer,'missing'),root]);assert.ok(recovered.contexts.some(x=>x.includes('category=unstaged')&&x.includes('path=source.txt')));
});
