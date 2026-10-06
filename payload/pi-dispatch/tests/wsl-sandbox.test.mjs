import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {readFileSync} from 'node:fs';
import {validateFixtureScope,validateKetherTask} from '../extensions/kether-envelope.js';
import { cleanupWslJob, validateSandboxPatch, wslSandboxArgs, buildSandboxScopeManifest, createJsonOutputCollector, stripPatch } from '../scripts/wsl-sandbox.mjs';
import { summarize } from '../scripts/dispatch.mjs';
import { createHash } from 'node:crypto';

test('bounded collection preserves genuine submission and same-path edit recovery through noisy split events',()=>{
  const canonicalText='KETHER_RESULT_JSON={"status":"completed"}', collector=createJsonOutputCollector(2048);
  const events=[{type:'agent_start'},...Array(600).fill({type:'message_update',partial:'x'.repeat(200)}),
    ...[true,false].flatMap((isError,i)=>[{type:'tool_execution_start',toolCallId:String(i),toolName:'edit',args:{path:'a.js'}},{type:'tool_execution_end',toolCallId:String(i),toolName:'edit',isError}]),
    {type:'tool_execution_end',toolName:'yhwh_submit_result',result:{details:{type:'kether_result_submission',canonicalText}}},
    {type:'message_end',message:{role:'assistant',provider:'openai-codex',model:'gpt-6-luna',stopReason:'stop',content:[{type:'text',text:'done'}]}},{type:'agent_end',messages:['x'.repeat(1200)]}];
  const wire=events.map(JSON.stringify).join('\n')+'\n';
  for(let i=0;i<wire.length;i+=37)collector.feed('stdout',wire.slice(i,i+37));
  const captured=collector.close(), result=summarize({...captured,exitCode:0},{provider:'openai-codex',model:'gpt-6-luna',resultSubmissionRequired:true});
  assert.equal(captured.failure,null);assert.ok(Buffer.byteLength(captured.stdout)<2048);assert.equal(result.ok,true);assert.equal(result.recoveredErrors,1);assert.deepEqual(result.resultSubmission,{ok:true,canonicalText});
});

test('collector bounds retained, wire and frame output and keeps independently verified patch bytes',()=>{
  for(const chunks of [['x'.repeat(129)],['a\n'.repeat(65)],[JSON.stringify({type:'message_update'})+'\n',' '.repeat(6*1024*1024+2048)]]){
    const c=createJsonOutputCollector(128);for(const s of chunks)c.feed('stdout',s);assert.equal(c.close().failure,'output-limit');
  }
  const patch='--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+ok\n', patchSha256=createHash('sha256').update(patch).digest('hex');
  const meta={ok:true,patchPolicy:'issued-credential-v1',secretLikeContent:false,patchBytes:Buffer.byteLength(patch),patchSha256};
  const frame='\nPI_SANDBOX_PATCH_B64='+Buffer.from(patch).toString('base64')+'\nPI_SANDBOX_PATCH_META='+JSON.stringify(meta), c=createJsonOutputCollector(128);
  for(let i=0;i<frame.length;i+=7)c.feed('stdout',frame.slice(i,i+7));
  assert.equal(c.failed(),null);assert.equal(stripPatch(c.close().stdout).patch,patch);
  const huge=createJsonOutputCollector(128);huge.feed('stdout','PI_SANDBOX_PATCH_B64=\n');huge.feed('stdout','x'.repeat(6*1024*1024));assert.equal(huge.close().failure,'output-limit');
});

test('WSL patch proof binds real scoped diff headers to the host job and fails closed', () => {
  const job = '11111111-1111-4111-8111-111111111111';
  const patch = `--- /var/lib/pi-kether/jobs/${job}/baseline/a.js\n+++ /var/lib/pi-kether/jobs/${job}/workspace/a.js\n@@ -0,0 +1 @@\n+ok\n`;
  const args = { job, requestId: 'host-request', writeScope: ['a.js'], access: 'workspace-write' };
  const valid = validateSandboxPatch(patch, args);
  assert.equal(valid.patchValidation.ok, true);
  assert.deepEqual(valid.patchValidation.changedFiles, ['a.js']);
  assert.equal(valid.patchValidation.requestId, 'host-request');
  assert.equal(valid.patchValidation.jobId, job);
  assert.equal(validateSandboxPatch('', args).patchValidation, undefined);
  for (const bad of [
    patch.replaceAll(job, '22222222-2222-4222-8222-222222222222'),
    patch.replaceAll('/a.js', '/outside.js'),
    'not a unified diff',
  ]) {
    const result = validateSandboxPatch(bad, args);
    assert.equal(result.patchValidation.ok, false);
    assert.equal(result.failure, 'sandbox-patch-validation-failed');
  }
  assert.equal(validateSandboxPatch(patch, { ...args, writeScope: ['other.js'] }).failure, 'sandbox-patch-validation-failed');
});

test('WSL task and health launches use a native cwd without changing scoped arguments', () => {
  for(const command of ['run','--probe','--cleanup-orphans']) {
    const tail=['/usr/local/libexec/pi-kether-sandbox',command,'scoped file with spaces'];
    assert.deepEqual(wslSandboxArgs('test-distro',tail),['-d','test-distro','-u','root','--cd','/','--',...tail]);
    assert.equal(tail.length,3);
  }
});

test('Node caller sends fixtures separately from readonly source and writable paths', () => {
  const input={readScope:['src/**'],writeScope:['new/file.js'],fixtureScope:['samples/**']};
  assert.deepEqual(JSON.parse(Buffer.from(buildSandboxScopeManifest(input),'base64').toString('utf8')),{read:['src/**'],write:['new/file.js'],fixtures:['samples/**']});
  assert.throws(()=>buildSandboxScopeManifest({...input,fixtureScope:null}));
  assert.throws(()=>buildSandboxScopeManifest({...input,fixtureScope:['new/**']}));
});
test('fixture overlap uses the normalized write tree and every final verify includes the fixture manifest',()=>{
  assert.throws(()=>validateKetherTask({role:'Chesed',objective:'test',writeScope:['a/** '],fixtureScope:['a/input']}),/overlaps/);
  assert.throws(()=>validateFixtureScope(['a/input'],['a/** ']),/overlaps/);
  const script=readFileSync(new URL('../sandbox/pi-kether-sandbox',import.meta.url),'utf8');
  const calls=script.split('\n').filter(line=>line.includes('snapshot-scope.py --verify'));
  assert.equal(calls.length,1);
  assert.ok(calls.every(line=>line.includes('--manifest "$jobdir/scopes.json"')));
  assert.ok(script.indexOf('"${workspace_bind[@]}"')<script.indexOf('"${fixture_bind[@]}"'));
});
test('fixture path grammar obeys the shared cross-language vectors and UTF-16 bounds', () => {
  const vectors=JSON.parse(readFileSync(new URL('./fixture-scope-vectors.json',import.meta.url),'utf8'));
  for(const {values,writes,accepted} of vectors) {
    if(accepted)assert.doesNotThrow(()=>validateFixtureScope(values,writes));else assert.throws(()=>validateFixtureScope(values,writes));
  }
  assert.doesNotThrow(()=>validateFixtureScope(['😀'.repeat(2000)]));
  assert.throws(()=>validateFixtureScope(['😀'.repeat(2001)]));
});

test('WSL accepts the global 900-second timeout while preserving fixed profile quotas',()=>{
 const script=readFileSync(new URL('../sandbox/pi-kether-sandbox',import.meta.url),'utf8');
 assert.match(script,/small\) memory_bytes=1073741824; cpu_quota=50000; cpu_period=100000; pids_max=64; max_output_bytes=1048576; max_run_seconds=900/);
 assert.match(script,/standard\) memory_bytes=3221225472; cpu_quota=100000; cpu_period=100000; pids_max=128; max_output_bytes=4194304; max_run_seconds=900/);
 assert.match(script,/timeout_seconds >= 1 && timeout_seconds <= max_run_seconds/);
});

test('WSL cleanup cannot inherit a transient Windows-drive mount as cwd', async () => {
  let invocation;
  await cleanupWslJob('test-distro','00000000-0000-0000-0000-000000000000',{
    spawnFn:(...args)=>{invocation=args;return fakeSpawn(0)();}
  });
  assert.equal(invocation[0],'wsl.exe');
  assert.deepEqual(invocation[1].slice(0,7),['-d','test-distro','-u','root','--cd','/','--']);
  assert.equal(invocation[2].shell,false);
});

function fakeSpawn(exitCode, stderr = '') {
  return () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => child.stderr;
    child.kill = () => {};
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', exitCode);
    });
    return child;
  };
}

test('WSL cleanup waits for and exposes successful confirmation', async () => {
  const result = await cleanupWslJob('test-distro', '00000000-0000-0000-0000-000000000000', { spawnFn: fakeSpawn(0) });
  assert.deepEqual(result, { ok: true, exitCode: 0, error: undefined, stderr: '' });
});

test('WSL cleanup exposes failures and bounded stderr', async () => {
  const result = await cleanupWslJob('test-distro', '00000000-0000-0000-0000-000000000000', { spawnFn: fakeSpawn(9, 'cgroup remains') });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 9);
  assert.equal(result.error, 'cleanup exited 9');
  assert.equal(result.stderr, 'cgroup remains');
});
