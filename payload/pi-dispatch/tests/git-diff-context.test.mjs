import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {collectGitDiffContext} from '../scripts/git-diff-context.mjs';

function fixture(t,{commit=true}={}){
 const root=mkdtempSync(join(tmpdir(),'yhwh-git-context-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root}`,...args],{cwd:root,encoding:'utf8'});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 if(commit){writeFileSync(join(root,'base.txt'),'baseline\n');git('add','base.txt');git('commit','-qm','baseline');}
 return {root,git};
}

test('collects categorized scoped diffs and inventory-only untracked paths',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'base.txt'),'staged change\n');git('add','base.txt');writeFileSync(join(root,'base.txt'),'unstaged change\n');
 mkdirSync(join(root,'sub'));writeFileSync(join(root,'sub','new.txt'),'must not be included as content');writeFileSync(join(root,'inventory.txt'),'inventory contents are private');
 const result=await collectGitDiffContext({cwd:join(root,'sub','..'),roots:[root],readScope:['base.txt','inventory.txt'],writeScope:[],maxBytes:8192,maxEntries:10});
 assert.ok(result.contexts.some(x=>x.includes('category=staged')&&x.includes('base.txt')&&x.includes('HEAD ')));
 assert.ok(result.contexts.some(x=>x.includes('category=unstaged')&&x.includes('base.txt')));
 assert.ok(result.contexts.some(x=>x.includes('category=untracked inventory')&&x.includes('inventory.txt')));
 assert.ok(!result.contexts.join('').includes('inventory contents are private'));assert.ok(!result.contexts.some(x=>x.includes('must not be included')));
});

test('leading dash is literal; bracket paths and index-mode symlinks are excluded',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'-leading.txt'),'before\n');mkdirSync(join(root,'scope'));writeFileSync(join(root,'scope','glob[1].txt'),'before\n');
 git('add','-A');git('commit','-qm','literal names');
 const linkBlob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:root,input:'base.txt',encoding:'utf8'}).trim();
 git('update-index','--add','--cacheinfo',`120000,${linkBlob},link.txt`);git('commit','-qm','index-mode symlink');
 const changedLinkBlob=execFileSync('git',['hash-object','-w','--stdin'],{cwd:root,input:'another-target',encoding:'utf8'}).trim();git('update-index','--cacheinfo',`120000,${changedLinkBlob},link.txt`);
 writeFileSync(join(root,'-leading.txt'),'after dash\n');writeFileSync(join(root,'scope','glob[1].txt'),'after glob\n');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['-leading.txt','scope/**','link.txt'],writeScope:[]});
 assert.ok(result.contexts.some(x=>x.includes('path=-leading.txt')));assert.ok(!result.contexts.some(x=>x.includes('glob[1].txt')));assert.ok(!result.contexts.some(x=>x.includes('path=link.txt')));
});

test('real symlinks are excluded when the platform permits their creation',async t=>{
 const {root,git}=fixture(t);try{symlinkSync('base.txt',join(root,'real-link.txt'));}catch(error){if(['EPERM','ENOTSUP'].includes(error.code)){t.skip(`symlink creation unavailable: ${error.code}`);return;}throw error;}
 git('add','real-link.txt');git('commit','-qm','symlink');
 const nextTarget=execFileSync('git',['hash-object','-w','--stdin'],{cwd:root,input:'other-target',encoding:'utf8'}).trim();git('update-index','--cacheinfo',`120000,${nextTarget},real-link.txt`);
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt','real-link.txt']});assert.ok(!result.contexts.some(x=>x.includes('path=real-link.txt')));
});

test('tracked regular deletions are readable as scoped evidence',async t=>{
 const {root}=fixture(t);unlinkSync(join(root,'base.txt'));
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt']});
 assert.ok(result.contexts.some(x=>x.includes('category=unstaged')&&x.includes('path=base.txt')&&x.includes('deleted file')));
});

test('subdirectory scopes cannot disclose siblings and unborn/non-Git state is explicit',async t=>{
 const {root}=fixture(t);mkdirSync(join(root,'sub'));writeFileSync(join(root,'secret.txt'),'outside');
 const scoped=await collectGitDiffContext({cwd:join(root,'sub'),roots:[root],readScope:['secret.txt'],writeScope:[]});assert.ok(scoped.contexts.every(x=>!x.includes('secret.txt')));
 const unborn=fixture(t,{commit:false});const result=await collectGitDiffContext({cwd:unborn.root,roots:[unborn.root],readScope:[],writeScope:[]});assert.ok(result.contexts.some(x=>x.includes('HEAD unavailable')));
 const outside=await collectGitDiffContext({cwd:tmpdir(),roots:[root],readScope:['base.txt']});assert.ok(outside.contexts.some(x=>x.includes('Git context unavailable')));
});

test('patch prefixes fit UTF-8 byte and entry budgets while preserving markers and summary',async t=>{
 const {root,git}=fixture(t);const synthetic=['pass','word','=', 'ultra','secret','value'].join('');writeFileSync(join(root,'base.txt'),`baseline\npassword=${synthetic}\n${'秘密'.repeat(5000)}`);git('add','base.txt');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt'],maxBytes:700,maxEntries:4});
 assert.ok(result.contexts.length<=4);assert.ok(result.contexts.every(x=>x.length<=4000&&!x.includes('\0')));assert.ok(Buffer.byteLength(result.contexts.join('\n'),'utf8')<=700);
 assert.ok(result.contexts.some(x=>x.includes('UNTRUSTED GIT REFERENCE DATA')));assert.ok(result.contexts.some(x=>x.includes('category=staged')&&x.includes('path=base.txt')&&x.includes('truncated=true')));
 assert.ok(!result.contexts.join('').includes(`password=${synthetic}`));
});

test('omission summary survives a single entry slot',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'base.txt'),'changed evidence\n');writeFileSync(join(root,'second.txt'),'new evidence\n');git('add','base.txt','second.txt');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt','second.txt'],maxBytes:8192,maxEntries:1});
 assert.equal(result.contexts.length,1);assert.match(result.contexts[0],/category=availability; status=omitted/);
});

test('remaining-byte clipping marks a small patch truncated',async t=>{
 const {root}=fixture(t);writeFileSync(join(root,'base.txt'),'a small changed patch'.repeat(30)+'\n');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt'],maxBytes:650,maxEntries:4});
 const diff=result.contexts.find(x=>x.includes('category=unstaged'));
 assert.ok(diff);assert.match(diff,/truncated=true/);assert.ok(diff.includes('[truncated]'));
});

test('zero output bounds do no work',async()=>{
 const result=await collectGitDiffContext({cwd:'/',roots:[],readScope:['anything'],maxBytes:0,maxEntries:0});assert.deepEqual(result,{contexts:[],omitted:false});
});

test('external diff and textconv are disabled',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'.gitattributes'),'*.txt diff=blocked\n');writeFileSync(join(root,'base.txt'),'changed raw text\n');git('add','base.txt','.gitattributes');git('commit','-qm','attributes');
 writeFileSync(join(root,'base.txt'),'new raw text\n');git('config','diff.blocked.textconv','false');git('config','diff.blocked.command','false');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt']});assert.ok(result.contexts.some(x=>x.includes('new raw text')));
});
