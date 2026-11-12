import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {inspectRepository,changesSince} from '../scripts/lsp-change-detector.mjs';
import {assessLsp,acceptLsp,issueOneTimeLsp,consumeOneTimeLsp} from '../scripts/lsp-approval-state.mjs';

const tempRoot=fs.realpathSync(tmpdir()),base=fs.mkdtempSync(path.join(tempRoot,'pi-lsp-approval-state-'));
test.after(()=>{const actual=fs.realpathSync(base),relative=path.relative(tempRoot,actual);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('unsafe fixture cleanup');fs.rmSync(actual,{recursive:true,force:true})});
const repo=path.join(base,'repo'),stateDir=path.join(base,'state');fs.mkdirSync(repo);execFileSync('git',['init','-q',repo],{stdio:'pipe'});
const file=path.join(repo,'main.js'),lines=Array.from({length:2100},(_,i)=>`const v${i}=${i};`);fs.writeFileSync(file,lines.join('\n')+'\n');execFileSync('git',['-C',repo,'add','main.js'],{stdio:'pipe'});
const input={cwd:repo,file,roots:[repo],stateDir};

test('first confirmation persists, while small changes remain below the cumulative threshold',()=>{
  const first=assessLsp(input);assert.equal(first.reason,'first');assert.equal(fs.existsSync(stateDir),false);assert.equal(assessLsp(input).reason,'first');
  assert.equal(acceptLsp(input,first).ok,true);assert.equal(assessLsp(input).allowed,true);
  const small=[...lines];small[2]='const v2=999;';fs.writeFileSync(file,small.join('\n')+'\n');const current=assessLsp(input);assert.equal(current.allowed,true);assert.equal(current.changedLines,2);
  const state=fs.readFileSync(path.join(stateDir,first.repoHash+'.json'),'utf8');assert(!state.includes('const v'));
});
test('major changes and changes during confirmation fail closed',()=>{
  const big=lines.map((x,i)=>i<1001?`const changed${i}=1;`:x);fs.writeFileSync(file,big.join('\n')+'\n');const request=assessLsp(input);assert.equal(request.allowed,false);assert.equal(request.reason,'lines');
  fs.appendFileSync(file,'late change\n');assert.throws(()=>acceptLsp(input,request),/repository_changed_during_confirmation/);assert.equal(assessLsp(input).allowed,false);
  const fresh=assessLsp(input);assert.equal(acceptLsp(input,fresh).ok,true);assert.equal(assessLsp(input).allowed,true);
});
test('50 changed files trigger confirmation, including untracked files',()=>{
  const before=inspectRepository(repo,[repo],null,file);for(let i=0;i<50;i++)fs.writeFileSync(path.join(repo,`new-${i}.js`),'x\n');const after=inspectRepository(repo,[repo],before.data,file);const result=changesSince(before.data,after.data,{fileLimit:50,lineLimit:2000,tempDir:stateDir});assert.equal(result.reason,'files');assert.equal(result.changedFiles,50);
});
test('one-time fallback binds the operation and cannot be replayed',()=>{
  const request={...input,requestId:'fixture-1',method:'symbols'},challenge={nonce:'a'.repeat(64),expiresAt:Date.now()+30000};assert.equal(issueOneTimeLsp(request,challenge).ok,true);assert.equal(consumeOneTimeLsp({...request,method:'hover'},challenge.nonce).ok,false);assert.equal(consumeOneTimeLsp(request,challenge.nonce).ok,true);assert.equal(consumeOneTimeLsp(request,challenge.nonce).ok,false);
});
test('non-Git workspaces are monitored and paths outside the allowed root are rejected',()=>{
  const dir=path.join(base,'plain');fs.mkdirSync(dir);const item=path.join(dir,'index.js');fs.writeFileSync(item,'one\n');const old=inspectRepository(dir,[dir],null,item);fs.writeFileSync(item,'two\n');const next=inspectRepository(dir,[dir],old.data,item);assert.equal(changesSince(old.data,next.data,{tempDir:stateDir}).changedLines,2);assert.throws(()=>inspectRepository(repo,[dir]),/outside_allowed_root/);
});
test('hard-linked files fail closed before fingerprinting',()=>{const link=path.join(repo,'hardlink.js');fs.linkSync(file,link);assert.throws(()=>inspectRepository(repo,[repo],null,file),/unsafe_repository_file/);fs.unlinkSync(link)});
test('ignored source files remain visible to change detection',()=>{const dir=path.join(base,'ignored');fs.mkdirSync(dir);execFileSync('git',['init','-q',dir],{stdio:'pipe'});fs.writeFileSync(path.join(dir,'.gitignore'),'ignored.js\n');const item=path.join(dir,'ignored.js');fs.writeFileSync(item,'one\n');const before=inspectRepository(dir,[dir],null,item);fs.writeFileSync(item,'two\n');const after=inspectRepository(dir,[dir],before.data,item);assert.equal(changesSince(before.data,after.data,{tempDir:stateDir}).changedLines,2)});
