import test from 'node:test';
import assert from 'node:assert/strict';
import {redactSensitiveText} from '../extensions/audit-log.js';
import {validateUnifiedPatch} from '../extensions/write-scope-guard.js';
import guard from '../extensions/read-scope-guard.js';
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
