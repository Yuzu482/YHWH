import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyArtifact, normalizeSandboxPatch, describeSandboxFiles, runArtifactGit, relativePatchFiles } from '../scripts/artifact-apply.mjs';
import { createWriteScopeLockManager } from '../extensions/write-scope-locks.js';
import { validateSandboxPatch, stripPatch } from '../scripts/wsl-sandbox.mjs';
import { trustedPatchProof, createGatewayApp } from '../scripts/gateway.mjs';
import { checkPatchBytes } from '../scripts/patch-policy.mjs';
import { classifyPatchTier } from '../scripts/workflow-tier-gate.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { roleValue } from './contract-fixtures.mjs';
import { listenHttpFixture } from './http-fixture.mjs';

const hash = text => createHash('sha256').update(text,'utf8').digest('hex');
function gnuDiff(baseline,workspace) {
  let executable='diff';
  if (process.platform === 'win32') {
    const candidates=(process.env.PATH ?? '').split(delimiter).flatMap(p=>[join(p,'diff.exe'),join(p,'../usr/bin/diff.exe')]);
    executable=candidates.find(p=>existsSync(p));
    assert.ok(executable,'Git for Windows must supply GNU diff for real sandbox fixtures');
  }
  try {return execFileSync(executable,['-ruN',baseline,workspace],{encoding:'utf8'});}
  catch (error) {if(error.status===1)return error.stdout;throw error;}
}
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pi-artifact-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:dir});
  execFileSync('git',['config','core.autocrlf','false'],{cwd:dir});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','add','-A'],{cwd:dir});
  return dir;
}
function rawAndDelivered(cwd,path='docs/with space.txt') {
  const job='123e4567-e89b-42d3-a456-426614174000';
  const before=`/var/lib/pi-kether/jobs/${job}/baseline/${path}`;
  const after=`/var/lib/pi-kether/jobs/${job}/workspace/${path}`;
  const raw=`--- "${before}"\n+++ "${after}"\n@@ -1 +1 @@\n-old\n+new\n`;
  const patch=normalizeSandboxPatch(raw,job,[path]);
  return {job,patch};
}
function pendingFor(cwd,patch,files=['docs/with space.txt'],overrides={}) {
  const requestId='artifact-test-1',artifactSha256=hash(patch);
  const proof={ok:true,requestId,jobId:'123e4567-e89b-42d3-a456-426614174000',format:'relative-a-b-v1',changedFiles:files,patchSha256:artifactSha256,scopeSha256:hash('tree:docs')};
  const response={patch,patchValidation:proof,patchSha256:artifactSha256,patchBytes:Buffer.byteLength(patch),secretLikeContent:false,trustedWriteScope:['docs/**']};
  const pending={requestId,artifactSha256,workspace:cwd};
  return {requestId,ledger:{getHostArtifact:()=>({pending,originalResult:response}),getEffectiveResult:()=>({state:'awaiting-host-verification'})},response,...overrides};
}

test('normalizes sandbox headers and applies an actual Git patch in a repository with spaces',async t=>{
  const cwd=fixture(t); mkdirSync(join(cwd,'docs')); writeFileSync(join(cwd,'docs/with space.txt'),'old\n');
  const {patch}=rawAndDelivered(cwd); const artifact=pendingFor(cwd,patch);
  let calls=[];
  const outside=fixture(t);mkdirSync(join(outside,'docs'));writeFileSync(join(outside,'docs/with space.txt'),'old\n');
  execFileSync('git',['config','core.worktree',outside],{cwd});
  const oldWorkTree=process.env.GIT_WORK_TREE;process.env.GIT_WORK_TREE=outside;
  let result;
  try {result=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:{tryAcquire:()=>({token:'x'}),release:()=>{}},spawnFn:(...args)=>{calls.push(args[1]);assert.equal(args[2].env.GIT_WORK_TREE,undefined);return spawn(...args);}});}
  finally {if(oldWorkTree===undefined)delete process.env.GIT_WORK_TREE;else process.env.GIT_WORK_TREE=oldWorkTree;}
  assert.equal(result.ok,true); assert.deepEqual(calls,[['apply','--check'],['apply']]);
  assert.equal(readFileSync(join(cwd,'docs/with space.txt'),'utf8'),'new\n');
  assert.equal(readFileSync(join(outside,'docs/with space.txt'),'utf8'),'old\n');
});

test('artifact Git skips poisoned global/system configuration and inherited Git overrides',async t=>{
  const cwd=fixture(t);mkdirSync(join(cwd,'docs'));writeFileSync(join(cwd,'docs/with space.txt'),'old\n');
  const home=join(cwd,'fake-home'),xdg=join(home,'xdg');mkdirSync(join(xdg,'git'),{recursive:true});
  const poison=join(home,'system.config');
  for(const file of [join(home,'.gitconfig'),join(xdg,'git/config'),poison])writeFileSync(file,'[invalid config without closing bracket\n');
  assert.throws(()=>execFileSync('git',['config','--file',poison,'--list'],{cwd,stdio:'pipe'}),/Command failed/);
  const inherited={GIT_CONFIG_GLOBAL:poison,GIT_CONFIG_SYSTEM:poison,GIT_CONFIG_COUNT:'10',GIT_CONFIG_KEY_9:'core.worktree',GIT_CONFIG_VALUE_9:home,GIT_DIR:home};
  const saved=Object.fromEntries(Object.keys(inherited).map(key=>[key,process.env[key]]));
  let calls=0,result;
  try {
    Object.assign(process.env,inherited);
    const {patch}=rawAndDelivered(cwd),artifact=pendingFor(cwd,patch);
    result=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:{tryAcquire:()=>({}),release:()=>{}},spawnFn:(exe,args,options)=>{
      calls++;assert.equal(exe,'git');assert.equal(options.shell,false);assert.equal(options.env.GIT_CONFIG_GLOBAL,'/dev/null');assert.equal(options.env.GIT_CONFIG_NOSYSTEM,'1');
      assert.equal(options.env.GIT_CONFIG_SYSTEM,undefined);assert.equal(options.env.GIT_DIR,undefined);assert.equal(options.env.GIT_CONFIG_KEY_9,undefined);assert.equal(options.env.GIT_CONFIG_VALUE_9,undefined);
      assert.equal(options.env.GIT_CONFIG_COUNT,'3');assert.equal(options.env.GIT_CONFIG_KEY_0,'core.fsmonitor');assert.equal(options.env.GIT_CONFIG_VALUE_0,'false');
      assert.equal(options.env.GIT_CONFIG_KEY_1,'core.hooksPath');assert.equal(options.env.GIT_CONFIG_VALUE_1,process.platform==='win32'?'NUL':'/dev/null');
      assert.equal(options.env.GIT_CONFIG_KEY_2,'safe.directory');assert.equal(options.env.GIT_CONFIG_VALUE_2,cwd);
      // A malformed config would fail real Git if any global/system source were read.
      return spawn(exe,args,{...options,env:{...options.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:xdg,GIT_CONFIG_SYSTEM:poison}});
    }});
  } finally {for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls,2);assert.equal(readFileSync(join(cwd,'docs/with space.txt'),'utf8'),'new\n');
});

test('Git check failure leaves every workspace file untouched and does not run apply',async t=>{
  const cwd=fixture(t); mkdirSync(join(cwd,'docs')); writeFileSync(join(cwd,'docs/with space.txt'),'conflict\n'); writeFileSync(join(cwd,'docs/other.txt'),'untouched\n');
  const patch=`--- a/docs/with space.txt\n+++ b/docs/with space.txt\n@@ -1 +1 @@\n-old\n+new\n--- a/docs/other.txt\n+++ b/docs/other.txt\n@@ -1 +1 @@\n-untouched\n+changed\n`;
  const artifact=pendingFor(cwd,patch,['docs/with space.txt','docs/other.txt']); let calls=0;
  const result=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:{tryAcquire:()=>({}),release:()=>{}},spawnFn:(...args)=>{calls++;return spawn(...args);}});
  assert.equal(result.ok,false); assert.equal(calls,1); assert.equal(readFileSync(join(cwd,'docs/other.txt'),'utf8'),'untouched\n');
});

test('normalizes absolute diff records at different root depths and preserves hunk header-like lines',async t=>{
  const job='123e4567-e89b-42d3-a456-426614174000';
  for(const depth of [1,3,6]){
    const cwd=fixture(t), parents=join(cwd,...Array(depth).fill('deep'));
    const baseline=join(parents,'baseline').replaceAll('\\','/'),workspace=join(parents,'workspace').replaceAll('\\','/');
    for (const root of [cwd,baseline,workspace]) mkdirSync(join(root,'docs'),{recursive:true});
    const before='old\n-- header-like\n++ header-like\n',after='new\n-- changed-header\n++ changed-header\n';
    for (const root of [cwd,baseline]) writeFileSync(join(root,'docs/with space.txt'),before);
    writeFileSync(join(workspace,'docs/with space.txt'),after);
    const raw=gnuDiff(baseline,workspace);
    const normalized=normalizeSandboxPatch(raw,job,['docs/with space.txt'],{baseline,workspace},describeSandboxFiles(raw,{baseline,workspace}));
    assert.match(normalized,/a\/docs\/with space\.txt/);
    assert.doesNotMatch(normalized,/diff -ruN/);
    execFileSync('git',['apply','--check'],{cwd,input:normalized,encoding:'utf8'});
    execFileSync('git',['apply'],{cwd,input:normalized,encoding:'utf8'});
    assert.equal(readFileSync(join(cwd,'docs/with space.txt'),'utf8'),after);
  }
});

test('rejects malformed relative prefixes, mismatched pending state and busy locks before Git',async t=>{
  const cwd=fixture(t); mkdirSync(join(cwd,'docs')); writeFileSync(join(cwd,'docs/with space.txt'),'old\n');
  const {patch}=rawAndDelivered(cwd), artifact=pendingFor(cwd,patch); let calls=0;
  const common={requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],spawnFn:()=>{calls++;throw Error('unexpected')}};
  const malformed=patch.replace('a/docs/','../docs/');
  const bad=pendingFor(cwd,malformed); assert.equal((await applyArtifact({...common,ledger:bad.ledger})).code,'artifact_path_unsafe');
  artifact.ledger.getEffectiveResult=()=>({state:'completed'});
  assert.equal((await applyArtifact(common)).code,'artifact_not_pending');
  artifact.ledger.getEffectiveResult=()=>({state:'awaiting-host-verification'});
  assert.equal((await applyArtifact({...common,writeLocks:{tryAcquire:()=>null,release:()=>{}}})).code,'write_scope_busy');
  assert.equal(calls,0);
});

test('real Git applies new and deleted files and duplicate replay is rejected',async t=>{
  const cwd=fixture(t); mkdirSync(join(cwd,'docs')); writeFileSync(join(cwd,'docs/old.txt'),'old\n');
  const job='123e4567-e89b-42d3-a456-426614174000';
  const raw=`--- /var/lib/pi-kether/jobs/${job}/baseline/docs/old.txt\n+++ /var/lib/pi-kether/jobs/${job}/workspace/docs/old.txt\n@@ -1 +0,0 @@\n-old\n--- /var/lib/pi-kether/jobs/${job}/baseline/docs/new.txt\n+++ /var/lib/pi-kether/jobs/${job}/workspace/docs/new.txt\n@@ -0,0 +1 @@\n+new\n`;
  const patch=normalizeSandboxPatch(raw,job,['docs/old.txt','docs/new.txt'],{},[{path:'docs/old.txt',before:true,after:false},{path:'docs/new.txt',before:false,after:true}]);
  const artifact=pendingFor(cwd,patch,['docs/old.txt','docs/new.txt']);
  const locks={tryAcquire:()=>({}),release:()=>{}};
  assert.equal((await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:locks})).ok,true);
  assert.equal(readFileSync(join(cwd,'docs/new.txt'),'utf8'),'new\n');
  assert.equal(existsSync(join(cwd,'docs/old.txt')),false);
  assert.equal((await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:locks})).ok,false);
});

test('rejects an untrusted hash and hard-linked target before starting Git',async t=>{
  const cwd=fixture(t); mkdirSync(join(cwd,'docs')); writeFileSync(join(cwd,'docs/with space.txt'),'old\n');
  const {patch}=rawAndDelivered(cwd); const artifact=pendingFor(cwd,patch); artifact.response.patchSha256='0'.repeat(64);
  let called=false;
  const result=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:{tryAcquire:()=>({}),release:()=>{}},spawnFn:()=>{called=true;throw Error('unexpected')}});
  assert.equal(result.code,'artifact_hash_mismatch'); assert.equal(called,false);
  const other=join(cwd,'outside.txt');linkSync(join(cwd,'docs/with space.txt'),other);
  artifact.response.patchSha256=hash(patch); artifact.response.patchValidation.patchSha256=hash(patch);
  const unsafe=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:{tryAcquire:()=>({}),release:()=>{}},spawnFn:()=>{called=true;throw Error('unexpected')}});
  assert.equal(unsafe.code,'artifact_path_unsafe'); assert.equal(called,false);
});

test('real producer distinguishes delete/create from truncation even with epoch source mtime',async t=>{
  const cwd=fixture(t),baseline=join(cwd,'baseline').replaceAll('\\','/'),workspace=join(cwd,'workspace').replaceAll('\\','/');
  for(const root of [cwd,baseline,workspace])mkdirSync(join(root,'docs'),{recursive:true});
  for(const root of [cwd,baseline]) {
    writeFileSync(join(root,'docs/delete.txt'),'gone\n');
    writeFileSync(join(root,'docs/empty.txt'),'truncate\n');
    utimesSync(join(root,'docs/empty.txt'),0,0);
  }
  writeFileSync(join(workspace,'docs/empty.txt'),'');writeFileSync(join(workspace,'docs/new.txt'),'added\n');
  const raw=gnuDiff(baseline,workspace),states=describeSandboxFiles(raw,{baseline,workspace});
  assert.deepEqual(states.map(s=>[s.path,s.before,s.after]),[['docs/delete.txt',true,false],['docs/empty.txt',true,true],['docs/new.txt',false,true]]);
  const rawFile=join(cwd,'changes.patch');writeFileSync(rawFile,raw);
  const produced=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/patch-policy.mjs',import.meta.url)),rawFile,baseline,workspace],{input:'unit-issued-token',encoding:'utf8'}));
  assert.deepEqual(produced.fileStates,states);
  const captured=stripPatch(`\nPI_SANDBOX_PATCH_B64=${Buffer.from(raw).toString('base64')}\nPI_SANDBOX_PATCH_META=${JSON.stringify(produced)}\n`);
  assert.deepEqual(captured.fileStates,states);
  const patch=normalizeSandboxPatch(raw,'123e4567-e89b-42d3-a456-426614174000',states.map(s=>s.path),{baseline,workspace},states);
  assert.match(patch,/\+\+\+ \/dev\/null/); assert.match(patch,/--- \/dev\/null/);
  const artifact=pendingFor(cwd,patch,states.map(s=>s.path));
  const locks=createWriteScopeLockManager(join(cwd,'locks'));
  assert.equal((await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:locks})).ok,true);
  assert.equal(existsSync(join(cwd,'docs/delete.txt')),false);
  assert.equal(readFileSync(join(cwd,'docs/empty.txt'),'utf8'),'');
  assert.equal(readFileSync(join(cwd,'docs/new.txt'),'utf8'),'added\n');
  assert.throws(()=>normalizeSandboxPatch(raw,'123e4567-e89b-42d3-a456-426614174000',states.map(s=>s.path),{baseline,workspace}),/existence proof/);
});

test('quoted Unicode paths, raw proof, multi-file legacy scope hashes and tier counts agree',t=>{
  const job='123e4567-e89b-42d3-a456-426614174000',files=['docs/with space.txt','docs/中文.txt'];
  const patch=files.map(p=>`--- "/var/lib/pi-kether/jobs/${job}/baseline/${p}"\t2026-10-07 00:00:00 +0000\n+++ "/var/lib/pi-kether/jobs/${job}/workspace/${p}"\t2026-10-07 00:00:01 +0000\n@@ -1 +1 @@\n-old\n+new\n`).join('');
  const proof=validateSandboxPatch(patch,{job,requestId:'quoted-proof',access:'workspace-write',writeScope:files,fileStates:files.map(path=>({path,before:true,after:true}))});
  assert.equal(proof.patchValidation.ok,true); assert.deepEqual(relativePatchFiles(proof.patch),files.sort());
  assert.equal(proof.patchValidation.scopeSha256,hash(files.map(p=>`file:${p}`).sort().join('\\n')));
  assert.equal(trustedPatchProof(proof,'quoted-proof',files),true);
  const declaration={publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false};
  assert.equal(classifyPatchTier(proof.patch,declaration,'standard',files).files,2);
});

test('LF and Windows CRLF repositories retain their configured file bytes with default Git apply',t=>{
  for(const crlf of [false,true]) {
    const cwd=fixture(t);mkdirSync(join(cwd,'docs'));
    execFileSync('git',['config','core.autocrlf',String(crlf)],{cwd});
    writeFileSync(join(cwd,'docs/with space.txt'),crlf?'old\r\n':'old\n');
    const {patch}=rawAndDelivered(cwd);
    execFileSync('git',['apply','--check'],{cwd,input:patch});execFileSync('git',['apply'],{cwd,input:patch});
    assert.deepEqual(readFileSync(join(cwd,'docs/with space.txt')),Buffer.from(crlf?'new\r\n':'new\n'));
  }
});

test('Git errors are unchanged, conflicting files untouched and durable locks released',async t=>{
  const cwd=fixture(t);mkdirSync(join(cwd,'docs'));writeFileSync(join(cwd,'docs/with space.txt'),'conflict\n');
  const {patch}=rawAndDelivered(cwd),artifact=pendingFor(cwd,patch),locks=createWriteScopeLockManager(join(cwd,'locks'));
  const expected=await runArtifactGit({cwd,args:['apply','--check'],patch});
  const result=await applyArtifact({requestId:artifact.requestId,ledger:artifact.ledger,roots:[cwd],writeLocks:locks});
  assert.equal(result.exitCode,expected.exitCode);assert.equal(result.stderr,expected.stderr);assert.equal(result.stdout,expected.stdout);
  assert.equal(readFileSync(join(cwd,'docs/with space.txt'),'utf8'),'conflict\n');
  const next=locks.tryAcquire({requestId:'next',cwd,writeScope:['docs/**'],timeoutSeconds:1});assert.ok(next);locks.release(next);
});

test('real process timeout/output/launch failure are bounded and resolve only after close',async t=>{
  const cwd=fixture(t);const scripts={timeout:'setInterval(()=>{},1000)',output:'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'};
  for(const [mode,source]of Object.entries(scripts)) {
    const file=join(cwd,`${mode}.cjs`);writeFileSync(file,source);let child,closed=false;
    const result=await runArtifactGit({cwd,args:['apply','--check'],patch:'',timeoutMs:500,outputLimit:1024,
      spawnFn:(_exe,args,opts)=>{assert.deepEqual(args,['apply','--check']);child=spawn(process.execPath,[file],opts);child.on('close',()=>{closed=true;});return child;}});
    assert.equal(closed,true);assert.equal(result.ok,false);
    assert.equal(result.error.code,mode==='timeout'?'ETIMEDOUT':'EOUTPUTLIMIT');
    assert.ok(Buffer.byteLength(result.stdout)<=1024);assert.equal(result.timedOut,mode==='timeout');
    assert.throws(()=>process.kill(child.pid,0));rmSync(file);assert.equal(existsSync(file),false);
  }
  const missing=await runArtifactGit({cwd,args:['apply'],patch:'',spawnFn:(_exe,args,opts)=>spawn(join(cwd,'missing-git'),args,opts)});
  assert.equal(missing.ok,false);assert.equal(missing.error.code,'ENOENT');
  assert.throws(()=>runArtifactGit({cwd,args:['status'],patch:''}),/unsupported/);
});

test('pending/hash/scope/null-path/symlink/metadata rejections launch no Git and do not mutate files',async t=>{
  const cwd=fixture(t);mkdirSync(join(cwd,'docs'));writeFileSync(join(cwd,'docs/with space.txt'),'old\n');
  const {patch}=rawAndDelivered(cwd);let calls=0;
  for(const mutate of [a=>a.response.patchBytes++,a=>a.response.patchValidation.scopeSha256='0'.repeat(64),a=>a.response.patchValidation.changedFiles=['docs/other.txt'],a=>a.response.secretLikeContent=true]) {
    const a=pendingFor(cwd,patch);mutate(a);const result=await applyArtifact({requestId:a.requestId,ledger:a.ledger,roots:[cwd],spawnFn:()=>{calls++;throw Error('unexpected');}});assert.equal(result.ok,false);
  }
  assert.throws(()=>relativePatchFiles('--- /dev/null\n+++ /dev/null\n@@ -0,0 +1 @@\n+x\n'));
  assert.throws(()=>relativePatchFiles('--- a/docs/.git/config\n+++ b/docs/.git/config\n@@ -1 +1 @@\n-x\n+y\n'));
  const outside=mkdtempSync(join(tmpdir(),'artifact-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  symlinkSync(outside,join(cwd,'docs/link'),process.platform==='win32'?'junction':'dir');
  const unsafe='--- a/docs/link/file\n+++ b/docs/link/file\n@@ -0,0 +1 @@\n+new\n',a=pendingFor(cwd,unsafe,['docs/link/file']);
  assert.equal((await applyArtifact({requestId:a.requestId,ledger:a.ledger,roots:[cwd],spawnFn:()=>{calls++;}})).code,'artifact_path_unsafe');
  assert.equal(calls,0);assert.equal(readFileSync(join(cwd,'docs/with space.txt'),'utf8'),'old\n');
});

async function withArtifactGateway(t,{cwd,dispatchFn,sandbox=true},run) {
  const token='artifact-test-only-bearer-0123456789',dir=mkdtempSync(join(tmpdir(),'artifact-ledger-'));
  const sandboxStatus=sandbox?{ok:true,backend:'wsl2-bwrap',hostMountVisible:false,windowsInterop:false,bubblewrap:true,pi:true,resourceLimits:true}:{ok:false,backend:'fixture',resourceLimits:false};
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[cwd],token,dispatchFn,sandboxStatus,requestLedgerDir:dir,schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER,pollIntervalMs:5}});
  const server=await listenHttpFixture(app),client=new Client({name:'artifact-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    await run(client,server.address().port);
  } finally {
    await client.close();await runtime.shutdown({graceMs:100,abortWaitMs:100});await new Promise(done=>server.close(done));rmSync(dir,{recursive:true,force:true});
  }
}
const parse = result => result.structuredContent ?? JSON.parse(result.content.find(c=>c.type==='text').text);
test('authenticated MCP applies a real pending create/delete artifact with only requestId; it does not attest',async t=>{
  const cwd=fixture(t),baseline=join(cwd,'baseline').replaceAll('\\','/'),workspace=join(cwd,'workspace').replaceAll('\\','/');
  for(const root of [cwd,baseline,workspace])mkdirSync(join(root,'docs'),{recursive:true});
  for(const root of [cwd,baseline])writeFileSync(join(root,'docs/delete.txt'),'gone\n');
  writeFileSync(join(workspace,'docs/new.txt'),'new\n');
  const captured=gnuDiff(baseline,workspace),fileStates=describeSandboxFiles(captured,{baseline,workspace}),files=fileStates.map(s=>s.path),job='123e4567-e89b-42d3-a456-426614174000';
  const raw=captured.replaceAll(baseline,`/var/lib/pi-kether/jobs/${job}/baseline`).replaceAll(workspace,`/var/lib/pi-kether/jobs/${job}/workspace`);
  const dispatchFn=async request=>{
    const proof=validateSandboxPatch(raw,{job,requestId:request.gatewayRequestId,access:'workspace-write',writeScope:['docs/**'],fileStates});
    const value=roleValue('Chesed');value.changedFiles=files;value.deliverable.checks=[{name:'contents',outcome:'unverified',evidence:'Host runs fixture content assertions'}];
    return {ok:true,exitCode:0,provider:request.provider,model:request.model,requestedProvider:request.provider,requestedModel:request.model,cleanup:{ok:true},sandbox:'wsl2-bwrap',...proof,patchSha256:proof.patchValidation.patchSha256,patchBytes:Buffer.byteLength(proof.patch),secretLikeContent:false,text:'KETHER_RESULT_JSON='+JSON.stringify(value)};
  };
  await withArtifactGateway(t,{cwd,dispatchFn},async(client,port)=>{
    const unauth=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
    const args={cwd,requestId:'mcp-apply-1',parentRunId:'artifact-test',provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',tier:'T0',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},task:{role:'Chesed',objective:'Fixture pending patch',readScope:['docs/**'],writeScope:['docs/**'],acceptance:['contents']}};
    const pending=parse(await client.callTool({name:'dispatch_subagent',arguments:args}));assert.equal(pending.state ?? pending.status,'awaiting-host-verification',JSON.stringify(pending));
    const missing=parse(await client.callTool({name:'apply_artifact',arguments:{requestId:'unknown'}}));assert.equal(missing.code,'artifact_not_pending');
    const extra=await client.callTool({name:'apply_artifact',arguments:{requestId:args.requestId,cwd}});assert.equal(extra.isError,true);
    assert.equal(existsSync(join(cwd,'docs/delete.txt')),true);assert.equal(existsSync(join(cwd,'docs/new.txt')),false);
    const applied=parse(await client.callTool({name:'apply_artifact',arguments:{requestId:args.requestId}}));assert.equal(applied.ok,true,JSON.stringify(applied));assert.deepEqual(applied.changedFiles,files);
    assert.equal(existsSync(join(cwd,'docs/delete.txt')),false);assert.equal(readFileSync(join(cwd,'docs/new.txt'),'utf8'),'new\n');
    const status=parse(await client.callTool({name:'get_subagent_status',arguments:{requestId:args.requestId}}));assert.equal(status.task.state,'awaiting-host-verification');
    const replay=parse(await client.callTool({name:'apply_artifact',arguments:{requestId:args.requestId}}));assert.equal(replay.ok,false);assert.notEqual(replay.exitCode,0);
    const complete=parse(await client.callTool({name:'record_host_verification',arguments:{requestId:args.requestId,artifactSha256:pending.hostVerification.artifactSha256,commands:[{checkName:'contents',command:'fixture content assertions',exitCode:0,outputSummary:'Real Git deleted old file and created exact new content; content assertions passed.'}]}}));assert.equal(complete.state,'completed');
    assert.equal(parse(await client.callTool({name:'apply_artifact',arguments:{requestId:args.requestId}})).code,'artifact_not_pending');
  });
});

test('MCP artifact apply rejects missing/extra/invalid input and unavailable write sandbox',async t=>{
  const cwd=fixture(t);await withArtifactGateway(t,{cwd,sandbox:false,dispatchFn:()=>{throw Error('must never dispatch');}},async client=>{
    for(const args of [{},{requestId:'../bad'},{requestId:'valid',command:'anything'}])assert.equal((await client.callTool({name:'apply_artifact',arguments:args})).isError,true);
    const denied=await client.callTool({name:'apply_artifact',arguments:{requestId:'valid'}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/verified workspace-write/);
  });
});
