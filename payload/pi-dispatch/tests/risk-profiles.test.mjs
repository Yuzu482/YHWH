import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRiskProfileResolver,inspectGitWorktree,readOnlyGit} from '../scripts/risk-profiles.mjs';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function fixture(t) {
  const base=mkdtempSync(join(tmpdir(),'yhwh-risk-')),main=join(base,'main'),linked=join(base,'linked');mkdirSync(main);
  const git=(cwd,...args)=>{const r=spawnSync('git',['-c','safe.directory='+cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.autocrlf=false',...args],{cwd,encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(main,'init');writeFileSync(join(main,'a.txt'),'baseline\n');git(main,'add','a.txt');git(main,'commit','--no-gpg-sign','-m','fixture');git(main,'worktree','add','--detach',linked,'HEAD');mkdirSync(join(linked,'nested'));
  t.after(()=>rmSync(base,{recursive:true,force:true}));return {base,main,linked,git};
}
const critical=cwd=>({cwd,riskProfile:'critical'});
const unresolved=e=>e.code==='PI_RISK_PROFILE_UNRESOLVED';

test('critical follows registered main, detached worktree and nested cwd; clone and prefix sibling stay standard',t=>{
  const {base,main,linked,git}=fixture(t),clone=join(base,'clone'),sibling=main+'-sibling';
  git(base,'clone','--no-hardlinks',main,clone);mkdirSync(sibling);
  const profile=createRiskProfileResolver([critical(main)]),before=readFileSync(join(main,'.git','index'));
  for(const cwd of [main,linked,join(linked,'nested')])assert.equal(profile(cwd),'critical');
  for(const cwd of [clone,sibling])assert.equal(profile(cwd),'standard');
  assert.deepEqual(readFileSync(join(main,'.git','index')),before,'inspection does not refresh index');
});
test('same-repository critical floor beats an explicit downgrade; unrelated longest ancestor is preserved',t=>{
  const {base,main,linked}=fixture(t),other=join(base,'other'),inner=join(other,'inner');mkdirSync(inner,{recursive:true});
  const profile=createRiskProfileResolver([critical(main),{cwd:linked,riskProfile:'personal'},{cwd:other,riskProfile:'personal'},{cwd:inner,riskProfile:'standard'}]);
  assert.equal(profile(linked),'critical');assert.equal(profile(join(linked,'nested')),'critical');assert.equal(profile(other),'personal');assert.equal(profile(inner),'standard');
});
test('non-root critical entry remains path-local and does not spill to registered worktree peers',t=>{
  const {main,linked}=fixture(t),sub=join(main,'only-here');mkdirSync(sub);
  const profile=createRiskProfileResolver([critical(sub)]);
  assert.equal(profile(sub),'critical');assert.equal(profile(main),'standard');assert.equal(profile(linked),'standard');
});
test('plain critical directories still use path boundaries without Git',t=>{
  const {base}=fixture(t),plain=join(base,'plain');mkdirSync(join(plain,'child'),{recursive:true});mkdirSync(plain+'-sibling');
  const profile=createRiskProfileResolver([critical(plain)]);assert.equal(profile(join(plain,'child')),'critical');assert.equal(profile(plain+'-sibling'),'standard');
});
test('copying a real linked .git marker does not create a registered worktree',t=>{
  const {base,main,linked}=fixture(t),spoof=join(base,'spoof');mkdirSync(spoof);writeFileSync(join(spoof,'.git'),readFileSync(join(linked,'.git')));
  assert.throws(()=>createRiskProfileResolver([critical(main)])(spoof),unresolved);
});
test('invalid registration, corrupt marker and disappearance of configured repository fail closed',t=>{
  const {main,linked}=fixture(t),profile=createRiskProfileResolver([critical(main)]);
  const admin=readFileSync(join(linked,'.git'),'utf8').trim().slice(8),back=join(admin,'gitdir'),saved=readFileSync(back);
  writeFileSync(back,join(main,'unregistered','.git')+'\n');assert.throws(()=>profile(linked),unresolved);writeFileSync(back,saved);
  const marker=readFileSync(join(linked,'.git'));writeFileSync(join(linked,'.git'),'broken\n',{flag:'r+'});assert.throws(()=>profile(linked),unresolved);writeFileSync(join(linked,'.git'),marker,{flag:'r+'});
  renameSync(join(main,'.git'),join(main,'.git.saved'));try{assert.throws(()=>profile(linked),unresolved);}finally{renameSync(join(main,'.git.saved'),join(main,'.git'));}
  assert.equal(profile(linked),'critical');
});
test('Git environment redirection cannot rebind identity; missing Git never downgrades',t=>{
  const {base,main,linked}=fixture(t),profile=createRiskProfileResolver([critical(main)]),keys=['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','PATH'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    Object.assign(process.env,{GIT_DIR:join(base,'nonexistent'),GIT_WORK_TREE:base,GIT_INDEX_FILE:join(base,'unwanted-index')});assert.equal(profile(linked),'critical');
    process.env.PATH=join(base,'empty-path');assert.throws(()=>profile(linked),unresolved);
  } finally {for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
test('physical aliases retain registered identity',t=>{
  const {base,main,linked}=fixture(t),alias=join(base,'alias');
  try{symlinkSync(linked,alias,process.platform==='win32'?'junction':'dir');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Host cannot create a real path alias');return;}throw e;}
  assert.equal(createRiskProfileResolver([critical(main)])(alias),'critical');assert.equal(inspectGitWorktree(alias).root,inspectGitWorktree(linked).root);
});
test('real Git output overflow and exhausted deadlines cannot produce partial successful evidence',t=>{
  const {main,git}=fixture(t);writeFileSync(join(main,'large.txt'),'x'.repeat(2*1048576));git(main,'add','large.txt');git(main,'commit','--no-gpg-sign','-m','large output fixture');
  assert.throws(()=>readOnlyGit(main,['show','HEAD:large.txt']),unresolved);
  assert.throws(()=>readOnlyGit(main,['--version'],{deadline:Date.now()-1}),unresolved);
});
test('real gateway rejects linked T0 before dispatch and retains configured allowed roots',async t=>{
  const {base,main,linked}=fixture(t),token='fixture-token-012345678901234567890123';let dispatched=0;
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[main,linked],riskProfiles:[critical(main)],token,
    requestLedgerDir:join(base,'ledger'),sandboxStatus:{ok:true,backend:'wsl2-bwrap',hostMountVisible:false,windowsInterop:false,bubblewrap:true,pi:true,resourceLimits:true},
    dispatchFn:async()=>{dispatched++;throw Error('No model may run in admission test');}});
  const http=await listenHttpFixture(app),client=new Client({name:'critical-worktree-test',version:'1.0.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const request={cwd:linked,requestId:'critical-worktree-admission',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',tier:'T0',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},task:{role:'Chesed',objective:'Admission fixture',acceptance:['No model starts'],readScope:['a.txt'],writeScope:['a.txt']}};
    const refused=await client.callTool({name:'dispatch_subagent',arguments:request});assert.equal(refused.isError,true);assert.match(JSON.stringify(refused),/T0.*(?:minimum|profile)|WORKFLOW_TIER_INVALID/i);
    const outside=await client.callTool({name:'dispatch_subagent',arguments:{...request,cwd:base,requestId:'outside-admission'}});assert.equal(outside.isError,true);assert.match(JSON.stringify(outside),/outside.*roots/i);assert.equal(dispatched,0);
  } finally {await client.close();const shutdown=await runtime.shutdown();await new Promise(r=>http.close(r));assert.equal(shutdown.disposed,true);}
});
