import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {resolveRepository} from '../scripts/lsp-change-detector.mjs';
import {assessLsp,acceptLsp} from '../scripts/lsp-approval-state.mjs';

test('Git fixture root resolves to its explicitly allowed directory',()=>{
 const temp=fs.realpathSync(tmpdir()),base=fs.mkdtempSync(path.join(temp,'pi-lsp-git-path-'));
 try{
  const repo=path.join(base,'repo'),file=path.join(repo,'sample.js');fs.mkdirSync(repo);
  execFileSync('git',['init','-q',repo],{stdio:'pipe'});fs.writeFileSync(file,'export const fixture=1;\n');
  const env={};for(const k of ['PATH','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','TEMP','TMP'])if(process.env[k]!==undefined)env[k]=process.env[k];
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'});
  const raw=execFileSync('git',['--no-pager','-C',repo,'-c','core.fsmonitor=false','rev-parse','--show-toplevel'],{env,encoding:'utf8',timeout:12000}).trim();
  const actual=fs.realpathSync.native(raw),expected=fs.realpathSync.native(repo),relative=path.relative(expected,actual);
  const context=JSON.stringify({fixture:repo,expected,raw,actual,relative,gitDirExists:fs.existsSync(path.join(repo,'.git')),gitEnvironmentKeys:Object.keys(process.env).filter(k=>/^GIT_/i.test(k)).sort()});
  assert.equal(relative,'',context);
  assert.equal(path.relative(expected,resolveRepository(repo,[repo],file)),'',context);
 }finally{
  const actual=fs.realpathSync(base),relative=path.relative(temp,actual);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('unsafe fixture cleanup');
  fs.rmSync(actual,{recursive:true,force:true});
 }
});

test('Windows short and long paths share confirmation without widening the allowed root',{skip:process.platform!=='win32'},t=>{
 const temp=fs.realpathSync.native(tmpdir()),base=fs.mkdtempSync(path.join(temp,'pi-short-alias-fixture-'));
 try{
  const repo=path.join(base,'repository-with-long-name'),stateDir=path.join(base,'state');fs.mkdirSync(repo);
  const file=path.join(repo,'sample.js');fs.writeFileSync(file,'export const fixture=1;\n');
  execFileSync('git',['init','-q',repo],{stdio:'pipe'});
  if(/[%!&|<>^"]/u.test(repo)){t.skip('temporary path contains shell metacharacters');return}
  const command=process.env.ComSpec||'C:\\Windows\\System32\\cmd.exe';
  const short=execFileSync(command,['/d','/c',`for %I in ("${repo}") do @echo %~sI`],{encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:10000}).trim();
  if(!short||short.toLowerCase()===repo.toLowerCase()){t.skip('8.3 short aliases are unavailable');return}
  assert.equal(path.relative(fs.realpathSync.native(repo),fs.realpathSync.native(short)),'');
  const first={cwd:short,file:path.join(short,'sample.js'),roots:[short],stateDir};
  const challenge=assessLsp(first);assert.equal(challenge.reason,'first');assert.equal(acceptLsp(first,challenge).ok,true);
  const second=assessLsp({cwd:repo,file,roots:[repo],stateDir});assert.equal(second.allowed,true);assert.equal(second.repoHash,challenge.repoHash);
  const outside=path.join(base,'outside');fs.mkdirSync(outside);assert.throws(()=>resolveRepository(outside,[short]),/outside_allowed_root/);
 }finally{
  const actual=fs.realpathSync.native(base),relative=path.relative(temp,actual);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('unsafe fixture cleanup');
  fs.rmSync(actual,{recursive:true,force:true});
 }
});
