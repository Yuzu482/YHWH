import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {collectGitDiffContext} from '../scripts/git-diff-context.mjs';
import {addGitDiffTaskContext} from '../scripts/git-diff-task-context.mjs';

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
 const {root}=fixture(t);mkdirSync(join(root,'sub'));writeFileSync(join(root,'outside-evidence.txt'),'outside sibling evidence');
 const scoped=await collectGitDiffContext({cwd:join(root,'sub'),roots:[root],readScope:['outside-evidence.txt'],writeScope:[]});assert.ok(scoped.contexts.every(x=>!x.includes('outside-evidence.txt')));
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

test('porcelain status classifies staged-only, unstaged-only, and overlap accurately',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'staged.txt'),'initial\n');writeFileSync(join(root,'unstaged.txt'),'initial\n');writeFileSync(join(root,'overlap.txt'),'initial\n');git('add','-A');git('commit','-qm','three files');
 writeFileSync(join(root,'staged.txt'),'staged-only change\n');git('add','staged.txt');
 writeFileSync(join(root,'unstaged.txt'),'unstaged-only change\n');
 writeFileSync(join(root,'overlap.txt'),'staged version\n');git('add','overlap.txt');writeFileSync(join(root,'overlap.txt'),'unstaged version\n');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['staged.txt','unstaged.txt','overlap.txt']});
 const paths=category=>result.contexts.filter(value=>value.includes(`category=${category}`)).map(value=>value.match(/path=([^\n;]+)(?=; truncated=)/)?.[1]).filter(Boolean);
 assert.ok(paths('staged').includes('staged.txt'));assert.ok(!paths('unstaged').includes('staged.txt'));
 assert.ok(paths('unstaged').includes('unstaged.txt'));assert.ok(!paths('staged').includes('unstaged.txt'));
 assert.ok(paths('staged').includes('overlap.txt'));assert.ok(paths('unstaged').includes('overlap.txt'));
 assert.ok(!result.contexts.some(value=>value.includes('(no textual patch available)')));
});

test('rejected candidates do not consume the eight emitted-patch budget',async t=>{
 const {root,git}=fixture(t);const scope=[];
 for(let i=0;i<20;i++){const path=`a-rejected-${String(i).padStart(2,'0')}.txt`;writeFileSync(join(root,path),'x'.repeat(270000));scope.push(path);}
 for(let i=0;i<8;i++){const path=`z-valid-${i}.txt`;writeFileSync(join(root,path),'before\n');scope.push(path);}
 git('add','-A');git('commit','-qm','candidate baseline');
 for(let i=0;i<20;i++)writeFileSync(join(root,`a-rejected-${String(i).padStart(2,'0')}.txt`),'x'.repeat(270001));
 for(let i=0;i<8;i++)writeFileSync(join(root,`z-valid-${i}.txt`),`after ${i}\n`);
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:scope});
 const patches=result.contexts.filter(value=>/category=unstaged; path=/.test(value));
 assert.equal(patches.length,8);for(let i=0;i<8;i++)assert.ok(patches.some(value=>value.includes(`path=z-valid-${i}.txt`)));
 assert.ok(result.omitted);
});

test('dirty-scope overlap emits staged and unstaged evidence and consecutive calls observe fresh edits',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'base.txt'),'staged\n');git('add','base.txt');writeFileSync(join(root,'base.txt'),'unstaged\n');
 const first=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt']});
 assert.ok(first.contexts.some(value=>value.includes('category=staged')&&value.includes('path=base.txt')));
 assert.ok(first.contexts.some(value=>value.includes('category=unstaged')&&value.includes('path=base.txt')));
 writeFileSync(join(root,'base.txt'),'fresh next call\n');
 const second=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt']});assert.ok(second.contexts.join('').includes('fresh next call'));
});

test('many rejected oversized candidates remain bounded and preserve explicit omission',async t=>{
 const {root,git}=fixture(t);const scope=[];
 for(let i=0;i<24;i++){const name=`large-${i}.txt`;writeFileSync(join(root,name),'x'.repeat(262145));scope.push(name);}
 git('add','-A');const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:scope});
 assert.equal(result.omitted,true);assert.ok(result.contexts.some(value=>value.includes('category=availability; status=omitted')));
 assert.ok(result.contexts.every(value=>Buffer.byteLength(value,'utf8')<=8192));
});

test('task adapter applies role/access/scope gates, budgets additions, and preserves caller task',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'base.txt'),'changed\n');git('add','base.txt');
 const original={role:'Chesed',objective:'keep caller task',context:Array.from({length:63},(_,i)=>`caller-${i}`),readScope:['base.txt']};
 const result=await addGitDiffTaskContext({cwd:root,roots:[root],task:original,access:'read',operation:'dispatch_subagent'});
 assert.notEqual(result,original);assert.equal(result.context.length,64);assert.equal(result.context[0],'caller-0');assert.ok(result.context[63].includes('UNTRUSTED GIT REFERENCE DATA'));assert.equal(original.context.length,63);
 for(const options of [{access:'none'},{operation:'probe_model'},{task:{...original,role:'Geburah'}},{task:{role:'Chesed',objective:'no scope'}}]){
  const unchanged=options.task??original;assert.equal(await addGitDiffTaskContext({cwd:root,roots:[root],task:unchanged,access:options.access??'read',operation:options.operation??'dispatch_subagent'}),unchanged);
 }
 const huge={role:'worker',objective:'budget',context:['c'.repeat(4000)],readScope:['base.txt']};const bounded=await addGitDiffTaskContext({cwd:root,roots:[root],task:huge,access:'workspace-write',operation:'dispatch_subagent'});
 assert.ok(Buffer.byteLength(bounded.context.join('\n'),'utf8')<=8192);assert.equal(huge.context.length,1);
 const full={...original,context:Array.from({length:64},(_,i)=>`exact-${i}`)};assert.equal(await addGitDiffTaskContext({cwd:root,roots:[root],task:full,access:'read',operation:'dispatch_subagent'}),full);
 const exactBytes={...original,context:['x'.repeat(8191)]};assert.equal(await addGitDiffTaskContext({cwd:root,roots:[root],task:exactBytes,access:'read',operation:'dispatch_subagent'}),exactBytes);
});

test('benchmark CLI validates options and succeeds only with equivalent evidence',async t=>{
 const script=join(process.cwd(),'scripts','benchmark-git-context.mjs'),baseline=join(process.cwd(),'scripts','git-diff-context.mjs');
 const missing=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(missing.status,2);assert.match(missing.stderr,/Usage error/);
 const unknown=spawnSync(process.execPath,[script,'--baseline',baseline,'--unknown'],{encoding:'utf8'});assert.equal(unknown.status,2);
 const corrupt=join(mkdtempSync(join(tmpdir(),'git-context-bad-baseline-')),'bad.mjs');t.after(()=>rmSync(join(corrupt,'..'),{recursive:true,force:true}));writeFileSync(corrupt,'export const nope = 1;');
 const invalid=spawnSync(process.execPath,[script,'--baseline',corrupt,'--iterations','1'],{encoding:'utf8'});assert.notEqual(invalid.status,0);
 const success=spawnSync(process.execPath,[script,'--baseline',baseline,'--iterations','1'],{encoding:'utf8',timeout:120000});assert.equal(success.status,0,success.stderr);
 const report=JSON.parse(success.stdout);assert.equal(report.node,process.version);assert.equal(report.scenarios.length,2);assert.ok(report.scenarios.every(value=>value.equivalent&&value.before.evidence.length===8&&value.after.evidence.length===8));
});

test('external diff and textconv are disabled',async t=>{
 const {root,git}=fixture(t);writeFileSync(join(root,'.gitattributes'),'*.txt diff=blocked\n');writeFileSync(join(root,'base.txt'),'changed raw text\n');git('add','base.txt','.gitattributes');git('commit','-qm','attributes');
 writeFileSync(join(root,'base.txt'),'new raw text\n');git('config','diff.blocked.textconv','false');git('config','diff.blocked.command','false');
 const result=await collectGitDiffContext({cwd:root,roots:[root],readScope:['base.txt']});assert.ok(result.contexts.some(x=>x.includes('new raw text')));
});
