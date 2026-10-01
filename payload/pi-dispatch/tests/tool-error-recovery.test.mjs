import test from 'node:test';
import assert from 'node:assert/strict';
import { accountToolErrors } from '../extensions/tool-error-recovery.js';

const start = (id, toolName, path) => ({ type: 'tool_execution_start', toolCallId: id, toolName, args: { path, content: 'private-secret' } });
const end = (id, toolName, isError) => ({ type: 'tool_execution_end', toolCallId: id, toolName, isError });

test('later successful edit of same normalized target recovers a failed edit', () => {
  const events = [start('1','edit','src\\a.js'),end('1','edit',true),start('2','edit','src/a.js'),end('2','edit',false)];
  assert.deepEqual(accountToolErrors(events), { total: 1, recoveredErrors: 1, unrecoveredErrors: 0, fileToolErrors:1, unrecoveredFileToolErrors:0 });
});

test('unrelated path, different semantics, and earlier success do not recover', () => {
  for (const events of [
    [start('1','edit','a.js'),end('1','edit',true),start('2','edit','b.js'),end('2','edit',false)],
    [start('1','edit','a.js'),end('1','edit',true),start('2','write','a.js'),end('2','write',false)],
    [start('2','edit','a.js'),end('2','edit',false),start('1','edit','a.js'),end('1','edit',true)],
    [start('1','edit','a.js'),start('2','edit','a.js'),end('1','edit',true),end('2','edit',false)],
  ]) assert.deepEqual(accountToolErrors(events), { total: 1, recoveredErrors: 0, unrecoveredErrors: 1, fileToolErrors:1, unrecoveredFileToolErrors:1 });
});

test('missing, duplicate, mismatched, and invalid target pairing fail closed', () => {
  for (const events of [
    [end('1','edit',true)],
    [start('1','edit','a.js'),end('1','edit',true),start('2','edit','a.js'),{...end('2','edit',false),isError:undefined}],
    [end('1','edit',true),start('1','edit','a.js'),start('2','edit','a.js'),end('2','edit',false)],
    [start('1','edit','a.js'),start('1','edit','a.js'),end('1','edit',true),start('2','edit','a.js'),end('2','edit',false)],
    [start('1','read','a.js'),end('1','edit',true),start('2','edit','a.js'),end('2','edit',false)],
    [start('1','edit','../a.js'),end('1','edit',true),start('2','edit','../a.js'),end('2','edit',false)],
  ]) {
    const result=accountToolErrors(events);
    assert.equal(result.total,1);assert.equal(result.recoveredErrors,0);assert.equal(result.unrecoveredErrors,1);
    assert.ok(result.fileToolErrors===0||result.fileToolErrors===1);
    assert.equal(result.unrecoveredFileToolErrors,result.fileToolErrors);
  }
});

test('only file read/edit/write semantics qualify; scope denial can be recovered only by later real proof gate', () => {
  const deniedAttempt = [start('1','edit','outside.js'),end('1','edit',true)];
  assert.deepEqual(accountToolErrors(deniedAttempt), { total: 1, recoveredErrors: 0, unrecoveredErrors: 1, fileToolErrors:1, unrecoveredFileToolErrors:1 });
  // A blocked attempt is not itself success: gateway artifact recovery requires independently validated completed result and patch.
  assert.equal(accountToolErrors([...deniedAttempt, start('2','write','inside.js'),end('2','write',false)]).unrecoveredErrors, 1);
});

test('audit accounting inputs never include tool arguments or target paths', () => {
  const counts = accountToolErrors([start('1','edit','private/secret.js'),end('1','edit',true)]);
  assert.deepEqual(counts, { total: 1, recoveredErrors: 0, unrecoveredErrors: 1, fileToolErrors:1, unrecoveredFileToolErrors:1 });
  assert.doesNotMatch(JSON.stringify(counts), /private|secret/);
});
