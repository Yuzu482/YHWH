import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectMaintenanceBaseline} from '../scripts/maintenance-baseline.mjs';
const cli=fileURLToPath(new URL('../scripts/maintenance-baseline.mjs',import.meta.url));
function fixture(t){
  const base=mkdtempSync(join(tmpdir(),'yhwh-baseline-')),root=join(base,'repo');mkdirSync(root);
  const git=(...args)=>{const r=spawnSync('git',['-c','safe.directory='+root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.autocrlf=false',...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init');writeFileSync(join(root,'a.txt'),'baseline\n');writeFileSync(join(root,'.gitignore'),'ignored/\n');git('add','.');git('commit','--no-gpg-sign','-m','fixture');
  const commit=git('rev-parse','HEAD');t.after(()=>rmSync(base,{recursive:true,force:true}));
  const run=(args=[],env=process.env)=>spawnSync(process.execPath,[cli,...args],{cwd:base,env,encoding:'utf8',windowsHide:true,timeout:15000});
  return {base,root,commit,git,run,args:['--source-root',root,'--expected-commit',commit]};
}
test('Windows short source roots report native paths and retain clean and dirty checks',{skip:process.platform!=='win32'},t=>{
  const {base,root,commit,git,run}=fixture(t);
  const short=cwd=>{const r=spawnSync('cmd.exe',['/d','/c','for %I in (.) do @echo %~sI'],{cwd,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const shortRoot=short(root);if(!shortRoot.includes('~')){t.skip('Host volume does not provide an 8.3 short path');return;}
  const linked=join(base,'linked');git('worktree','add','--detach',linked,commit);const before=readFileSync(join(root,'.git','index'));
  for(const source of [shortRoot,short(linked)]){const r=run(['--source-root',source,'--expected-commit',commit]);assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).sourceRoot,realpathSync.native(source));}
  writeFileSync(join(root,'a.txt'),'dirty\n');const dirty=run(['--source-root',shortRoot,'--expected-commit',commit]);assert.equal(dirty.status,1);assert.equal(JSON.parse(dirty.stdout).code,'BASELINE_DIRTY');assert.deepEqual(readFileSync(join(root,'.git','index')),before);
});

test('real CLI accepts exact clean commit and linked detached source without modifying index',t=>{
  const {base,root,commit,git,run,args}=fixture(t),before=readFileSync(join(root,'.git','index')),names=readdirSync(base);
  const result=run(args);assert.equal(result.status,0,result.stderr);const facts=JSON.parse(result.stdout);assert.equal(facts.ok,true);assert.equal(facts.head,commit);assert.equal(facts.readOnly,true);assert.match(facts.gitVersion,/^git version /);
  assert.deepEqual(readFileSync(join(root,'.git','index')),before);assert.deepEqual(readdirSync(base),names);
  const linked=join(base,'detached');git('worktree','add','--detach',linked,commit);assert.equal(inspectMaintenanceBaseline({sourceRoot:linked,expectedCommit:commit}).ok,true);
});
for(const mode of ['tracked','staged','untracked'])test('baseline rejects '+mode+' dirt without changing it',t=>{
  const {root,git,run,args}=fixture(t);writeFileSync(join(root,mode==='untracked'?'new.txt':'a.txt'),'dirty\n');if(mode==='staged')git('add','a.txt');
  const before=git('status','--porcelain=v1'),index=readFileSync(join(root,'.git','index'));
  const result=run(args);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'BASELINE_DIRTY');assert.deepEqual(readFileSync(join(root,'.git','index')),index);assert.equal(git('status','--porcelain=v1'),before);
});
test('wrong HEAD, subdirectory, nonrepo and ignored-file policy are explicit',t=>{
  const {base,root,commit,run,args}=fixture(t);let result=run(['--source-root',root,'--expected-commit','0'.repeat(40)]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'BASELINE_COMMIT_MISMATCH');
  const sub=join(root,'ignored');mkdirSync(sub);writeFileSync(join(sub,'private.tmp'),'ignored fixture');assert.equal(run(args).status,0);
  result=run(['--source-root',sub,'--expected-commit',commit]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'SOURCE_ROOT_REQUIRED');
  result=run(['--source-root',base,'--expected-commit',commit]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'SOURCE_ROOT_REQUIRED');
});
test('unknown/missing/malformed arguments exit2 and leave no residual files',t=>{
  const {base,run,args}=fixture(t),before=readdirSync(base);
  for(const input of [[],['--unknown'],['--source-root','relative','--expected-commit','x'],[...args,'positional'],['--source-root',base,'--expected-commit','HEAD']]){const result=run(input);assert.equal(result.status,2);assert.match(result.stderr,/Usage:/);}
  assert.deepEqual(readdirSync(base),before);
});
test('missing Git and corrupt marker fail closed; inherited Git variables never redirect index or source',t=>{
  const {base,root,commit,run,args}=fixture(t),env={...process.env,GIT_DIR:join(base,'bogus'),GIT_WORK_TREE:base,GIT_INDEX_FILE:join(base,'unwanted-index')};
  assert.equal(run(args,env).status,0);assert.equal(existsSync(env.GIT_INDEX_FILE),false);
  const missing=run(args,{...env,PATH:join(base,'empty-path')});assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).code,'BASELINE_INSPECTION_FAILED');assert.match(missing.stdout,/Git unavailable/);
  const corrupt=join(base,'corrupt');mkdirSync(corrupt);writeFileSync(join(corrupt,'.git'),'not a gitdir\n');const before=readdirSync(corrupt);
  const result=run(['--source-root',corrupt,'--expected-commit',commit]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'BASELINE_INSPECTION_FAILED');assert.deepEqual(readdirSync(corrupt),before);
});
test('same-size changes never run repository clean filters during baseline inspection',t=>{
  const {root,git,run}=fixture(t),script=join(root,'.git','fixture-filter.cjs'),marker=join(root,'filter-executed');
  writeFileSync(script,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'fixture');process.stdout.write(fs.readFileSync(0));`);
  git('config','filter.fixture.clean','"'+process.execPath.replaceAll('\\','/')+'" "'+script.replaceAll('\\','/')+'"');
  git('config','filter.fixture.required','true');writeFileSync(join(root,'.gitattributes'),'a.txt filter=fixture\n');git('add','.gitattributes','a.txt');git('commit','--no-gpg-sign','-m','filter fixture');rmSync(marker,{force:true});
  const commit=git('rev-parse','HEAD');writeFileSync(join(root,'a.txt'),'changed!\n');
  const result=run(['--source-root',root,'--expected-commit',commit]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'BASELINE_DIRTY');assert.equal(existsSync(marker),false,'status must not execute configured clean helper');
});
test('gitlinks are refused before status can inspect child repositories',t=>{
  const {root,git,run,commit}=fixture(t);git('update-index','--add','--cacheinfo','160000,'+commit+',child');
  const result=run(['--source-root',root,'--expected-commit',commit]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).code,'BASELINE_SUBMODULE_UNSUPPORTED');assert.equal(existsSync(join(root,'child')),false);
});
