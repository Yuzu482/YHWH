// Deterministic fixture: the real Pi SDK loads the extension; no model is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {loadExtensions} from '/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
fs.closeSync(3);
let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
const loaded=await loadExtensions(['/adapter/extensions/lsp-proxy.js'],'/workspace');
assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
const extension=loaded.extensions[0];assert.equal(extension.tools.size,7);
const call=async(method,params,signal)=>{
  const result=await extension.tools.get('yhwh_lsp_'+method).definition.execute('fixture',params,signal,undefined,{cwd:'/workspace'});
  return result.details;
};
if(['go','rust'].includes(prompt)) {
  const go=prompt==='go',file=go?'sdk.go':'sdk.rs';
  const source=go?'package sample\nfunc answer() int { return 42 }\nfunc run() int { var value int = "wrong"; return answer() + value }\n':'pub fn answer() -> i32 { 42 }\npub fn run() -> i32 { let value: i32 = "wrong"; answer() + value }\n';
  const line=go?3:2,character=source.split('\n')[line-1].indexOf('answer')+1,times=[];
  fs.writeFileSync('/workspace/'+file,source);
  const timed=async(method,params)=>{const start=performance.now();const r=await call(method,params);times.push({method,ms:Math.round(performance.now()-start)});return r;};
  const first=await timed('diagnostics',{path:file});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.diagnosticsPublished,true);assert.equal(first.diagnosticCompletion.complete,true);
  assert.ok(first.result.details.data.some(d=>d.code===(go?'IncompatibleAssign':'E0308')));
  assert.equal(first.probeIsolation.processView,go?'private-pid-read-only':'empty');
  for(const method of ['hover','definition','references','symbols','completions','code_actions']) {
    const r=await timed(method,{path:file,...(method==='symbols'?{}:{line,character})});
    assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.serverSession.reused,true);assert.equal(r.serverSession.generation,first.serverSession.generation);assert.equal(r.modelCalls,0);
    if(['definition','references','symbols','hover','completions'].includes(method))assert.equal(r.status,'success');
    if(method==='hover')assert.ok(JSON.stringify(r.result.details.data).includes('answer'));
    if(method==='code_actions')assert.equal(r.diagnosticCompletion.complete,true);
  }
  const repeat=await timed('diagnostics',{path:file});assert.deepEqual(repeat.result.details.data,first.result.details.data);
  fs.writeFileSync('/workspace/'+file,source.replace('"wrong"','1'));
  const clean=await timed('diagnostics',{path:file});
  assert.equal(clean.ok,true,JSON.stringify(clean));assert.equal(clean.diagnosticsPublished,true);assert.equal(clean.diagnosticCompletion.complete,true);assert.deepEqual(clean.result.details.data,[]);
  assert.equal(clean.serverSession.reused,false);assert.notEqual(clean.serverSession.documentSha256,first.serverSession.documentSha256);
  if(go) {
    fs.writeFileSync('/workspace/'+file,'package sample\nimport "fmt"\nfunc Text() string { return fmt.Sprint(42) }\n');
    const standard=await call('diagnostics',{path:file});assert.equal(standard.ok,true,JSON.stringify(standard));assert.deepEqual(standard.result.details.data,[]);assert.equal(standard.diagnosticCompletion.complete,true);
  } else {
    fs.writeFileSync('/workspace/'+file,'pub fn moved() { let a = String::new(); let _b = a; drop(a); }\n');
    const borrow=await call('diagnostics',{path:file});assert.equal(borrow.ok,true,JSON.stringify(borrow));assert.ok(borrow.result.details.data.some(d=>d.code==='E0382'));assert.equal(borrow.diagnosticCompletion.compilerCleanup,true);
  }
  console.log(JSON.stringify({fixture:prompt+'-seven-tools-reuse-edit-and-complete-diagnostics',passed:true,times,modelCalls:0}));
} else if(prompt==='java') {
  const file='SdkSample.java',source='class Sample {\n static int answer() { return 42; }\n static int run() { int value = "wrong"; return answer() + value; }\n}\n';
  fs.writeFileSync('/workspace/'+file,source);
  const first=await call('diagnostics',{path:file});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.diagnosticsPublished,true);assert.ok(first.result.details.data.some(d=>d.code==='16777233'));
  for(const method of ['hover','definition','references','symbols','completions','code_actions']){
    const result=await call(method,{path:file,...(method==='symbols'?{}:{line:3,character:source.split('\n')[2].indexOf('answer')+1})});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.serverSession.reused,true);assert.equal(result.serverSession.generation,first.serverSession.generation);assert.equal(result.modelCalls,0);
    if(['definition','references','symbols'].includes(method))assert.equal(result.status,'success');
    if(method==='hover')assert.ok(JSON.stringify(result.result.details.data).includes('answer'));
  }
  fs.writeFileSync('/workspace/'+file,source.replace('"wrong"','1'));
  const clean=await call('diagnostics',{path:file});
  assert.equal(clean.ok,true,JSON.stringify(clean));assert.equal(clean.diagnosticsPublished,true);assert.deepEqual(clean.result.details.data,[]);
  assert.equal(clean.serverSession.reused,false);assert.notEqual(clean.serverSession.documentSha256,first.serverSession.documentSha256);
  console.log(JSON.stringify({fixture:'java-seven-tools-reuse-and-edit',passed:true,modelCalls:0}));
} else if(prompt==='csharp') {
  const file='sdk.cs',source='class Sample {\n static int Answer() { return 42; }\n static int Run() { int value = "wrong"; return Answer() + value; }\n}\n';
  fs.writeFileSync('/workspace/'+file,source);
  const first=await call('diagnostics',{path:file});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.diagnosticsPublished,true);assert.ok(first.result.details.data.some(d=>d.code==='CS0029'));
  for(const method of ['hover','definition','references','symbols','completions','code_actions']){
    const result=await call(method,{path:file,...(method==='symbols'?{}:{line:3,character:source.split('\n')[2].indexOf('Answer')+1})});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.serverSession.reused,true);assert.equal(result.serverSession.generation,first.serverSession.generation);assert.equal(result.modelCalls,0);
  }
  fs.writeFileSync('/workspace/'+file,source.replace('"wrong"','1'));
  const clean=await call('diagnostics',{path:file});
  assert.equal(clean.ok,true,JSON.stringify(clean));assert.equal(clean.diagnosticsPublished,true);assert.deepEqual(clean.result.details.data,[]);
  assert.equal(clean.serverSession.reused,false);assert.notEqual(clean.serverSession.documentSha256,first.serverSession.documentSha256);
  console.log(JSON.stringify({fixture:'csharp-seven-tools-reuse-and-edit',passed:true,modelCalls:0}));
} else if(prompt==='cpp') {
  for(const suffix of ['c','cpp']){
    const file='sdk.'+suffix;
    const source='int answer(void) { return 42; }\nint main(void) { int value = "wrong"; return answer(); }\n';
    fs.writeFileSync('/workspace/'+file,source);
    const first=await call('diagnostics',{path:file});
    assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.diagnosticsPublished,true);assert.ok(first.result.details.data.length>0);
    for(const method of ['hover','definition','references','symbols','completions','code_actions']){
      const result=await call(method,{path:file,...(method==='symbols'?{}:{line:2,character:source.split('\n')[1].indexOf('answer')+1})});
      assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.serverSession.reused,true);assert.equal(result.serverSession.generation,first.serverSession.generation);
      assert.equal(result.modelCalls,0);
    }
    fs.writeFileSync('/workspace/'+file,source.replace('"wrong"','1'));
    const clean=await call('diagnostics',{path:file});
    assert.equal(clean.ok,true,JSON.stringify(clean));assert.equal(clean.diagnosticsPublished,true);assert.deepEqual(clean.result.details.data,[]);
    assert.equal(clean.serverSession.reused,false);assert.notEqual(clean.serverSession.documentSha256,first.serverSession.documentSha256);
  }
  console.log(JSON.stringify({fixture:'c-cpp-seven-tools-reuse-and-edit',passed:true,modelCalls:0}));
} else if(prompt==='python') {
  const file='/workspace/python-sdk.py';
  fs.writeFileSync(file,'def answer() -> int:\n    return 42\nvalue: int = "wrong"\nanswer()\n');
  const diag=()=>call('diagnostics',{path:'python-sdk.py'});
  const hover=()=>call('hover',{path:'python-sdk.py',line:4,character:2});
  const first=await diag(),second=await hover(),third=await diag(),fourth=await hover();
  for(const value of [first,second,third,fourth])assert.equal(value.ok,true,JSON.stringify(value));
  assert.ok(first.result.details.data.length>0);assert.equal(third.serverSession.reused,true);assert.equal(fourth.serverSession.reused,true);
  assert.equal(first.serverSession.generation,third.serverSession.generation);assert.equal(second.serverSession.generation,fourth.serverSession.generation);
  fs.writeFileSync(file,'def answer() -> int:\n    return 42\nvalue: int = 1\nanswer()\n');
  const clean=await diag(),updated=await hover();
  assert.equal(clean.ok,true,JSON.stringify(clean));assert.deepEqual(clean.result.details.data,[]);assert.equal(updated.ok,true,JSON.stringify(updated));
  assert.equal(clean.serverSession.reused,false);assert.equal(updated.serverSession.reused,false);assert.notEqual(clean.serverSession.documentSha256,first.serverSession.documentSha256);
  console.log(JSON.stringify({fixture:'python-dual-reuse-and-edit-invalidation',passed:true,modelCalls:0}));
} else if(prompt==='cancel') {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),150);
  const result=await call('diagnostics',{path:'check.ts'},controller.signal);clearTimeout(timer);
  assert.equal(result.ok,false);assert.equal(result.reason,'cancelled');
  console.log(JSON.stringify({fixture:'cancel',passed:true,modelCalls:0}));
} else {
  const clean=await call('diagnostics',{path:'check.ts'});assert.equal(clean.ok,true);assert.equal(clean.result.details.data.length,0);
  fs.writeFileSync('/workspace/check.ts','const value: number = "wrong";\nconsole.log(value);\n');
  const cases=[['diagnostics',{}],['hover',{line:2,character:13}],['definition',{line:2,character:13}],['references',{line:2,character:13}],['symbols',{}],['completions',{line:2,character:13}],['code_actions',{line:1,character:7}]];
  for(const [method,extra] of cases){
    const result=await call(method,{path:'check.ts',...extra});
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.engine,'multilspy');assert.equal(result.serverCleanup.ok,null);assert.equal(result.serverCleanup.state,'retained-until-session-close');assert.equal(result.modelCalls,0);
    assert.equal(result.serverSession.reused,method!=='diagnostics');
    assert.equal(result.serverSession.generation,2);
    if(method==='diagnostics'){assert.ok(result.result.details.data.some(d=>d.code===2322));assert.equal(result.diagnosticCompletion.complete,true);}
    console.log(JSON.stringify({fixture:method,passed:true,modelCalls:0}));
  }
  console.log(JSON.stringify({fixture:'current-worker-edit-visible',passed:true,modelCalls:0}));
}
for(const handler of extension.handlers.get('agent_end')??[])await handler({type:'agent_end'},{cwd:'/workspace'});
