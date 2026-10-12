// Opt-in, recorded-response engineering replay. Never dispatches a model, records
// host evidence in a gateway, or manufactures an accepted task. No Git commits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createReplayGateway} from './host-handoff-flow-benchmark.mjs';
import {runProcess} from '../scripts/headless-host.mjs';
import {fetchCompleteResult,sha256} from '../scripts/host-handoff.mjs';
import {createHostHandoffSession} from '../scripts/host-handoff-session.mjs';

const [evidence,baselineRoot,priorRoot,out]=process.argv.slice(2);
if(!evidence||!baselineRoot||!priorRoot||!out?.endsWith('.json')||fs.existsSync(out))throw Error('Usage: <evidence> <baseline-root> <prior-root> <new-report.json>');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const git='E:/Git/cmd/git.exe',testPath='payload/pi-dispatch/tests/source-window.test.mjs';
const versions={baseline:await import(pathToFileURL(baselineRoot+'/payload/pi-dispatch/scripts/host-handoff.mjs')),
  prior:await import(pathToFileURL(priorRoot+'/payload/pi-dispatch/scripts/host-handoff.mjs')),
  candidate:await import('../scripts/host-handoff.mjs')};
const flows={prior:await import(pathToFileURL(priorRoot+'/payload/pi-dispatch/scripts/host-handoff-flow.mjs')),
  candidate:await import('../scripts/host-handoff-flow.mjs')};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-balanced-replay-')),runs=[];
try {
  for(const file of fs.readdirSync(evidence).filter(f=>/^pack-.*\.json$/.test(f)).sort()){
    const pack=read(evidence+'/'+file),dir=evidence+'/real-candidate/'+pack.id;
    if(sha256(JSON.stringify(pack.source))!==pack.sourceSha256||sha256(JSON.stringify(pack.task))!==pack.taskSha256)throw Error('Frozen pack drift');
    const frozen=read(dir+'/candidate.json'),request=read(dir+'/request.json'),review=read(dir+'/review.json').result,
      accepted=read(dir+'/accepted-handoff.json'),hostRecord=read(dir+'/host-record.json');
    if(sha256(frozen.result.patch)!==frozen.artifactSha256)throw Error('Patch drift');
    const gateway=await createReplayGateway({requestId:request.requestId,result:frozen.result,review,handoff:accepted});
    const client=new Client({name:'recorded-only-balanced-replay',version:'1'});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+gateway.token}}}));
      const call=(name,args)=>client.callTool({name,arguments:args});
      // Five counterbalanced triads: each version sees the same initial bytes,
      // actual patch, commands and recorded responses in every triad.
      for(let pair=0;pair<5;pair++)for(const mode of pair%2?['candidate','prior','baseline']:['baseline','prior','candidate']){
        const cwd=path.join(tmp,pack.id+'-'+pair+'-'+mode);fs.mkdirSync(cwd,{recursive:true});
        for(const [rel,text]of Object.entries(pack.source)){fs.mkdirSync(path.dirname(path.join(cwd,rel)),{recursive:true});fs.writeFileSync(path.join(cwd,rel),text);}
        execFileSync(git,['init','-q'],{cwd});const patchFile=path.join(tmp,pack.id+'.patch');fs.writeFileSync(patchFile,frozen.result.patch);
        const start=performance.now(),callStart=gateway.calls.length;let t=performance.now(),candidate;
        if(mode==='baseline'){
          await call('wait_subagent',{requestId:request.requestId,timeoutMs:0});
          const complete=await fetchCompleteResult(call,request.requestId);
          candidate=await versions.baseline.fetchHostCandidate(call,{requestId:request.requestId,artifactSha256:complete.result.patchSha256});
        }else candidate=(await flows[mode].waitForHostCandidate(call,{requestId:request.requestId,timeoutMs:0})).candidate;
        const handoffMs=performance.now()-t;
        // Replayed final acceptance is NOT used as a new acceptance event.
        if(candidate.artifactSha256!==frozen.artifactSha256)throw Error('Replayed identity drift');
        t=performance.now();
        for(const args of [['apply','--check',patchFile],['apply',patchFile]]){
          const r=await runProcess(git,['-c','safe.directory='+cwd,...args],{cwd,timeoutMs:30000,maxOutputBytes:262144});
          if(r.exitCode!==0||r.failure)throw Error('Replay apply failed: '+r.stderr);
        }
        const applyMs=performance.now()-t;t=performance.now();
        const hostCapture=await versions[mode].captureHostChecks(candidate,[{checkName:'host regression',command:'node --test '+testPath+'; frozen source/assertion check',cwd,run:async()=>{
          const r=await runProcess(process.execPath,['--test',testPath],{cwd,timeoutMs:120000,maxOutputBytes:262144});
          const originalAssertions=pack.source[testPath].split("test('frozen host regression',()=>{")[1].split('});')[0];
          const scopeOk=Object.keys(pack.source).every(f=>pack.task.writeScope.includes(f)||fs.readFileSync(path.join(cwd,f),'utf8')===pack.source[f]);
          return {...r,exitCode:scopeOk&&fs.readFileSync(path.join(cwd,testPath),'utf8').includes(originalAssertions)?r.exitCode:1};
        }}]);
        if(!hostCapture.passed)throw Error('Replay host validation failed');
        const hostMs=performance.now()-t;
        const sources=pack.task.readScope.filter(f=>f!=='package.json').slice(0,3).map(f=>{const text=fs.readFileSync(path.join(cwd,f),'utf8');return {path:f,text,sha256:sha256(text)};});
        const input={request,candidate,hostCapture,hostRecord,sources},options={requestId:review.requestId,reason:'Recorded-response-only engineering replay'};
        let bundle,firstPrepareMs,repeatPrepareMs,cacheHit=false;t=performance.now();
        const baselinePrepare=()=>{const p=versions.baseline.prepareHostReview(input);return {...p,reviewRequest:{...request,requestId:review.requestId,provider:'claude-code-cli',model:'claude-sonnet-5',access:'none',task:{...p.taskTemplate,reviewPacket:p.packet}}};};
        if(mode==='candidate'){
          const session=createHostHandoffSession();const first=session.prepare(input,options);if(!first.ok)throw Error('Replay materials not ready');
          firstPrepareMs=performance.now()-t;t=performance.now();const repeated=session.prepare(input,options);repeatPrepareMs=performance.now()-t;cacheHit=repeated.cacheHit;bundle=first.bundle;session.clear();
        }else{
          const prepare=mode==='baseline'?baselinePrepare:()=>flows.prior.prepareReviewBundle(input,options);
          bundle=prepare();firstPrepareMs=performance.now()-t;t=performance.now();prepare();repeatPrepareMs=performance.now()-t;
        }
        runs.push({packId:pack.id,pair,mode,taskSha256:pack.taskSha256,sourceSha256:pack.sourceSha256,patchSha256:frozen.artifactSha256,
          handoffMs,applyMs,hostMs,firstPrepareMs,repeatPrepareMs,totalMs:performance.now()-start,gatewayReads:gateway.calls.length-callStart,cacheHit,hostPassed:true,budget:bundle.budget});
      }
    }finally{await client.close();await gateway.close();}
  }
  const quantile=(values,q)=>{const v=[...values].sort((a,b)=>a-b);return v[Math.ceil(q*v.length)-1];};
  const keys=['handoffMs','applyMs','hostMs','firstPrepareMs','repeatPrepareMs','totalMs','gatewayReads'];
  const summary=Object.fromEntries(Object.keys(versions).map(mode=>[mode,Object.fromEntries(keys.map(key=>[key,{median:quantile(runs.filter(r=>r.mode===mode).map(r=>r[key]),.5),p95:quantile(runs.filter(r=>r.mode===mode).map(r=>r[key]),.95)}]))]));
  fs.writeFileSync(out,JSON.stringify({kind:'recorded-response-three-version-library-replay',packs:10,alternatingTriadsPerPack:5,runs:runs.length,actualModelCalls:0,newAcceptances:0,summary,measurements:runs,
    limitations:['Library/API deterministic time only; excludes primary takeover/inference, CLI bootstrap and model execution/wait.','Actual git apply/check and host commands; historical gateway/acceptance responses remain synthetic replay, never recorded as production acceptance.','Baseline full-result reader is a protocol-compatible recorded replay shim; all actual version-specific handoff/material functions are loaded from their own roots.','Same-process repeated preparation is optional and never reused across changed fingerprint or process restart.']},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({runs:runs.length,summary}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
