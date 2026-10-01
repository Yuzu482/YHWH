import test from 'node:test';
import assert from 'node:assert/strict';
import {redactSensitiveText} from '../extensions/audit-log.js';
import {validateUnifiedPatch} from '../extensions/write-scope-guard.js';
import guard from '../extensions/read-scope-guard.js';
import writeGuard from '../extensions/write-scope-guard.js';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('JSON credential strings including escaped values are redacted',()=>{
  const secret='DUMMY_AUTH_VALUE_ONLY';
  for(const key of ['api_key','refresh_token','password']) assert.ok(!redactSensitiveText(JSON.stringify({[key]:secret})).includes(secret));
});
test('a valid text patch cannot hide unrelated binary changes',()=>{
  const good='--- /base/allowed.txt\tdate\n+++ /work/allowed.txt\tdate\n@@ -1 +1 @@\n-a\n+b\n';
  assert.throws(()=>validateUnifiedPatch(good+'Binary files /base/outside.bin and /work/outside.bin differ\n',['allowed.txt'],'/base','/work'),/Unverifiable/);
});
test('read tools cannot address home credentials or parent directories',async()=>{
  let handler; guard({on(n,fn){handler=fn;}});
  for (const path of ['../auth.json','/home/pi-sandbox/agent/auth.json']) assert.equal((await handler({toolName:'read',input:{path}},{cwd:process.cwd()})).block,true);
  assert.equal((await handler({toolName:'bash',input:{command:'id'}},{cwd:process.cwd()})).block,true);
});
test('write tool independently rejects fixture paths without relying on a readonly mount',async()=>{
  const root=mkdtempSync(join(tmpdir(),'yhwh-fixture-guard-'));const previous=process.env.PI_WRITE_SCOPE_FILE;
  try {
    mkdirSync(join(root,'samples'));writeFileSync(join(root,'samples','input.txt'),'fixture');
    process.env.PI_WRITE_SCOPE_FILE=join(root,'scope.json');writeFileSync(process.env.PI_WRITE_SCOPE_FILE,JSON.stringify(['new/file.mjs']));
    let handler;writeGuard({on(_name,fn){handler=fn;}});
    for(const toolName of ['write','edit','code_rewrite']) {
      assert.equal((await handler({toolName,input:{path:'samples/input.txt',dry_run:false}},{cwd:root})).block,true);
    }
    assert.equal(await handler({toolName:'write',input:{path:'new/file.mjs'}},{cwd:root}),undefined);
    assert.equal((await handler({toolName:'write',input:{path:'../escaped'}},{cwd:root})).block,true);
  } finally {if(previous===undefined)delete process.env.PI_WRITE_SCOPE_FILE;else process.env.PI_WRITE_SCOPE_FILE=previous;rmSync(root,{recursive:true,force:true});}
});
