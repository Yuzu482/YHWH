import test from 'node:test';
import assert from 'node:assert/strict';
import lspProxy from '../extensions/lsp-proxy.js';
import {createProbeFrames,LSP_FRAME,validateProbeRequest} from '../scripts/lsp-sandbox-broker.mjs';
import {buildPiArgs} from '../scripts/dispatch.mjs';
const request=(lspId=1)=>({lspId,tool:'lsp_diagnostics',params:{path:'src/check.ts'}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Pi extension registers seven distinct read-only tools and fails without its broker',async()=>{
  const tools=[],events=[];lspProxy({registerTool:t=>tools.push(t),on:n=>events.push(n)});
  assert.equal(new Set(tools.map(t=>t.name)).size,7);
  assert.ok(tools.every(t=>t.name.startsWith('yhwh_lsp_')));
  assert.ok(tools.every(t=>t.parameters.additionalProperties===false));
  assert.ok(tools.every(t=>!Object.hasOwn(t.parameters.properties,'command')));
  assert.deepEqual(events,['agent_end']);
  await assert.rejects(tools[0].execute('test',{path:'a.ts'}),/REQUIRES_GOVERNED_SANDBOX/);
  await assert.rejects(tools[0].execute('test',{path:'a.ts'},AbortSignal.abort()),/CANCELLED/);
});

test('adapter is admitted only for WSL file access; reviewer receives no tools',()=>{
  const base={provider:'openai-codex',model:'gpt-5.6-luna',access:'read'};
  const args=buildPiArgs(base,'wsl2');
  assert.ok(args.includes('/opt/pi-kether/extensions/lsp-proxy.js'));
  assert.ok(args.at(-1).includes('yhwh_lsp_diagnostics'));
  assert.deepEqual(new Set(args.at(-1).split(',')), new Set(['read', 'grep', 'find', 'ls', 'yhwh_lsp_diagnostics', 'yhwh_lsp_hover', 'yhwh_lsp_definition', 'yhwh_lsp_references', 'yhwh_lsp_symbols', 'yhwh_lsp_completions', 'yhwh_lsp_code_actions']));
  const none=buildPiArgs({...base,access:'none'},'wsl2');
  assert.ok(none.includes('--no-tools'));
  assert.ok(!none.includes('/opt/pi-kether/extensions/lsp-proxy.js'));
});

test('probe request rejects commands, escapes, ambiguous positions and unsupported operations',()=>{
  assert.equal(validateProbeRequest(request()).params.path,'/workspace/src/check.ts');
  for(const path of ['/etc/a.ts','../a.ts','src/../a.ts','C:\\a.ts','src//a.ts','/workspace/a.ts/../b.ts','a.txt'])assert.throws(()=>validateProbeRequest({...request(),params:{path}}));
  for(const params of [{path:'a.ts',command:'ls'},{path:'a.ts',line:1},{path:'a.ts',query:'x'}])assert.throws(()=>validateProbeRequest({...request(),params}));
  assert.throws(()=>validateProbeRequest({...request(),tool:'lsp_rename'}));
  assert.throws(()=>validateProbeRequest({...request(),extra:1}));
  assert.throws(()=>validateProbeRequest({...request(),tool:'lsp_hover',params:{path:'a.ts',line:1,character:1,query:'x'}}));
  assert.throws(()=>validateProbeRequest({...request(),tool:'lsp_hover',params:{path:'a.ts'}}));
  assert.equal(validateProbeRequest({...request(),tool:'lsp_hover',params:{path:'a.ts',query:'x'}}).tool,'lsp_hover');
});

test('split RPC frames preserve ordinary Pi output, route results and redact infrastructure errors',async()=>{
  const sent=[],output=[],invoked=[];let failed=0;
  const frames=createProbeFrames({workspace:'fixture',send:r=>sent.push(JSON.parse(r)),onOutput:s=>output.push(s),onFailure:()=>failed++,probe:async(w,r)=>{invoked.push([w,r.tool]);throw Error('private host path');}});
  const wire='{"type":"start"}\n'+LSP_FRAME+JSON.stringify(request())+'\n';
  frames.feed(wire.slice(0,25));frames.feed(wire.slice(25));await tick();
  assert.deepEqual(invoked,[['fixture','lsp_diagnostics']]);assert.equal(failed,0);
  assert.deepEqual(output,['{"type":"start"}\n']);assert.equal(sent[0].result.reason,'probe-failed');
  assert.doesNotMatch(JSON.stringify(sent),/private/);await frames.close();
});

test('cancellation waits for probe termination; channel close aborts and suppresses late replies',async()=>{
  const sent=[];let aborted=0;
  const frames=createProbeFrames({workspace:'fixture',send:r=>sent.push(JSON.parse(r)),onOutput:()=>{},onFailure:()=>assert.fail(),probe:(_w,_r,s)=>new Promise(resolve=>{s.addEventListener('abort',()=>{aborted++;resolve({ok:false,reason:'cancelled'});},{once:true});})});
  frames.feed(LSP_FRAME+JSON.stringify(request())+'\n');await tick();
  frames.feed(LSP_FRAME+JSON.stringify({lspCancel:1})+'\n');await tick();
  assert.equal(aborted,1);assert.equal(sent[0].result.reason,'cancelled');
  frames.feed(LSP_FRAME+JSON.stringify(request(2))+'\n');await tick();await frames.close();
  assert.equal(aborted,2);assert.equal(sent.length,1);
});

test('out-of-order, overlapping and oversized requests fail closed',async()=>{
  for(const mode of ['order','busy','oversized']){
    let failed=0,invoked=0;
    const frames=createProbeFrames({workspace:'fixture',send:()=>{},onOutput:()=>{},onFailure:()=>failed++,probe:async(_w,_r,s)=>{invoked++;if(s.aborted)return {};return new Promise(resolve=>s.addEventListener('abort',()=>resolve({}),{once:true}));}});
    if(mode==='order')frames.feed(LSP_FRAME+JSON.stringify(request(2))+'\n');
    if(mode==='busy'){frames.feed(LSP_FRAME+JSON.stringify(request())+'\n');frames.feed(LSP_FRAME+JSON.stringify(request(2))+'\n');}
    if(mode==='oversized')frames.feed('x'.repeat(8388609));
    await frames.close();assert.equal(failed,1);assert.equal(invoked,mode==='busy'?1:0);
  }
});
