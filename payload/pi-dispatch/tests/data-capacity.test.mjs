import test from 'node:test';
import assert from 'node:assert/strict';
import {DATA_CAPACITY as C,measureCapacity,assertPersistentRecord} from '../extensions/data-capacity.js';
import {assertReadableResult,exportResult} from '../extensions/result-export.js';
import {fetchCompleteResult} from '../scripts/host-handoff.mjs';
import {parsePatchHeaders} from '../scripts/artifact-apply.mjs';

test('capacity units, exact boundaries and derived page coverage stay unchanged',()=>{
  assert.deepEqual(C,{patchMaxUtf8Bytes:4194304,fullResultMaxUtf16Units:4194304,pageMaxUtf16Units:65536,pageCountMax:128,persistentRecordMaxUtf8Bytes:33554432});
  assert.ok(C.pageCountMax*C.pageMaxUtf16Units>=C.fullResultMaxUtf16Units);
  for(const unit of ['utf8-bytes','utf16-units'])for(const text of ['x','漢','😀','"\\\n']){
    const actual=unit==='utf8-bytes'?Buffer.byteLength(text):text.length;
    assert.equal(measureCapacity(text,{location:'sample',unit,limit:actual}).ok,true);
    if(actual>1)assert.equal(measureCapacity(text,{location:'sample',unit,limit:actual-1}).ok,false);
  }
  assert.throws(()=>measureCapacity('',{location:'x',unit:'tokens',limit:1}),TypeError);
  assertPersistentRecord('x'.repeat(C.persistentRecordMaxUtf8Bytes));
  assert.throws(()=>assertPersistentRecord('x'.repeat(C.persistentRecordMaxUtf8Bytes)+'\n'),e=>
    e.code==='PI_RESULT_OVERSIZED'&&e.actual===33554433&&e.limit===33554432&&e.unit==='utf8-bytes'&&e.location==='persistentRecord');
});

test('a legal maximum patch need not fit the serialized envelope; no truncation',()=>{
  const head='--- a/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+';
  const patch=head+'x'.repeat(C.patchMaxUtf8Bytes-Buffer.byteLength(head)-1)+'\n';
  assert.doesNotThrow(()=>parsePatchHeaders(patch));
  const result={patch,patchPolicy:'issued-credential-v1'};
  assert.throws(()=>assertReadableResult(result),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.actual>C.fullResultMaxUtf16Units);
  const page=exportResult(result,{limit:65536});assert.equal(page.totalLength,JSON.stringify(result).length);
  assert.equal(result.patch,patch); // Generic recovery still exports the full archive.
  assert.throws(()=>parsePatchHeaders(patch+'x'),/invalid patch text/);
});

test('exact complete-result boundary roundtrips real JSON transport including split surrogates',async()=>{
  const value={padding:''};value.padding='x'.repeat(C.fullResultMaxUtf16Units-JSON.stringify(value).length);
  assert.equal(assertReadableResult(value).actual,C.fullResultMaxUtf16Units);
  let calls=0;
  const read=async(_name,{offset,limit})=>{calls++;return JSON.parse(JSON.stringify({structuredContent:{ok:true,ready:true,requestId:'boundary',...exportResult(value,{offset,limit})}}));};
  assert.deepEqual((await fetchCompleteResult(read,'boundary')).result,value);assert.equal(calls,64);
  value.padding+='x';calls=0;
  await assert.rejects(fetchCompleteResult(read,'boundary'),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED'&&e.actual===C.fullResultMaxUtf16Units+1);
  assert.equal(calls,1);
  value.padding='';const prefix=JSON.stringify(value).indexOf('"padding":"')+11;
  value.padding='x'.repeat(65535-prefix)+'😀漢';
  const json=JSON.stringify(value);assert.equal(json.charCodeAt(65535),0xd83d);
  assert.deepEqual((await fetchCompleteResult(read,'boundary')).result,value);
});

test('JSON escaping and redaction are measured rather than raw payload length',()=>{
  const value={text:'"'.repeat(2200000)};
  assert.ok(value.text.length<C.fullResultMaxUtf16Units);
  assert.throws(()=>assertReadableResult(value),e=>e.code==='PI_RESULT_CAPACITY_EXCEEDED');
  const small={text:'Bearer x'};assert.equal(assertReadableResult(small).actual,JSON.stringify({text:'Bearer [REDACTED]'}).length);
});
