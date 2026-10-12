// Opt-in recorded-response replay; no model, production write, receipt or acceptance.
// node tests/host-handoff-benchmark.mjs <frozen-evidence-dir> <new-report.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {runProcess} from '../scripts/headless-host.mjs';
import {exportResult} from '../extensions/result-export.js';
import {buildReviewPacket} from '../scripts/review-materials.mjs';
import {fetchHostCandidate,captureHostChecks,prepareHostReview,sha256} from '../scripts/host-handoff.mjs';

const own=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(own),'../../..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v[Math.floor(v.length/2)];};
function legacyPrepare(input) {
  const {request,candidate,hostCapture,sources}=input;
  return buildReviewPacket({stage:'post-change',tier:request.tier,changedFiles:candidate.result.patchValidation.changedFiles,
    requirements:[JSON.stringify({objective:request.task.objective,acceptance:request.task.acceptance,forbidden:request.task.forbidden??[],owner:'Host verifies; primary accepts after required independent review'})],changes:[candidate.result.patch],
    context:[...request.task.context,...sources.map(s=>JSON.stringify({path:s.path,excerptSha256:s.sha256,text:s.text}))],
    verification:[JSON.stringify({kind:'hostEvidence',requestId:request.requestId,artifactSha256:candidate.artifactSha256,commands:hostCapture.evidence.commands}),
      'sandboxEvidence is preliminary and separate; host evidence is mandatory. No gateway acceptance or reviewer authorship is inferred.']});
}
if(process.argv[2]==='--legacy-read') {
  const [dir,part]=process.argv.slice(3);
  const files={result:'live-result.json.value.json',pending:'live-pending.json.value.json'};
  process.stdout.write(JSON.stringify(read(path.join(dir,files[part]))));
} else if(process.argv[2]==='--legacy-source') {
  process.stdout.write(fs.readFileSync(process.argv[3],'utf8'));
} else if(process.argv[2]==='--legacy-prepare') {
  process.stdout.write(JSON.stringify(legacyPrepare(read(process.argv[3]))));
} else if(process.argv.length===4) {
  const [dir,out]=process.argv.slice(2),request=read(path.join(dir,'live-request.json'));
  const response=read(path.join(dir,'live-result.json.value.json')),result=response.result;
  const accepted=read(path.join(dir,'live-handoff.json.value.json'));
  const handoff={...accepted,state:'host-verification-required',finalAccepted:false,acceptedAt:null,proofSha256:null};
  const patch=fs.readFileSync(path.join(dir,'live-acceptance.patch'),'utf8');
  if(sha256(patch)!==result.patchSha256 || patch!==result.patch || sha256(JSON.stringify(result))!==response.sha256)throw Error('Frozen artifact drift');
  const baseline=fs.readFileSync(path.join(dir,'live-test-baseline.mjs'));
  const extension=fs.readFileSync(path.join(root,'payload/pi-dispatch/extensions/source-window.js'));
  const sourcePath='payload/pi-dispatch/extensions/source-window.js',sourceFile=path.join(request.cwd,sourcePath);
  if(sha256(fs.readFileSync(sourceFile))!==sha256(extension))throw Error('Original source context drift');
  const runs=[],temp=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-handoff-compare-'));
  const git=process.env.YHWH_GIT ?? 'git';
  const testPath='payload/pi-dispatch/tests/source-window.test.mjs';
  async function hostRun(cwd) {
    const test=await runProcess(process.execPath,['--test',testPath],{cwd,timeoutMs:120000,maxOutputBytes:262144});
    const diff=await runProcess(git,['diff','--check'],{cwd,timeoutMs:30000,maxOutputBytes:262144});
    const scope=execFileSync(git,['diff','--name-only'],{cwd,encoding:'utf8'}).trim().split(/\r?\n/);
    if(scope.length!==1||scope[0]!==testPath)throw Error('Replay scope drift');
    return {exitCode:test.exitCode===0?diff.exitCode:test.exitCode,failure:test.failure??diff.failure,stdout:test.stdout+diff.stdout,stderr:test.stderr+diff.stderr};
  }
  try {
    for(let pair=0;pair<5;pair++)for(const mode of pair%2?['new','old']:['old','new']) {
      const cwd=path.join(temp,`${pair}-${mode}`);fs.mkdirSync(path.join(cwd,'payload/pi-dispatch/tests'),{recursive:true});fs.mkdirSync(path.join(cwd,'payload/pi-dispatch/extensions'),{recursive:true});
      fs.writeFileSync(path.join(cwd,testPath),baseline);fs.writeFileSync(path.join(cwd,'payload/pi-dispatch/extensions/source-window.js'),extension);
      fs.writeFileSync(path.join(cwd,'package.json'),' {"type":"module"}\n');
      execFileSync(git,['init','-q'],{cwd});execFileSync(git,['-c','core.autocrlf=false','add','.'],{cwd});
      let candidate,consoleBytes=0,readProcesses=0;
      const started=performance.now();
      if(mode==='old') {
        const full=execFileSync(process.execPath,[own,'--legacy-read',dir,'result'],{encoding:'utf8',maxBuffer:4*1024*1024});
        const pending=execFileSync(process.execPath,[own,'--legacy-read',dir,'pending'],{encoding:'utf8',maxBuffer:4*1024*1024});readProcesses=2;
        const list=JSON.parse(pending).items;
        if(!Array.isArray(list)||!list.some(p=>p.requestId===request.requestId))throw Error('Legacy recorded pending lookup missed candidate');
        consoleBytes=Buffer.byteLength(full+pending);
        candidate={requestId:request.requestId,artifactSha256:result.patchSha256,handoff,result:JSON.parse(full).result,resultSha256:response.sha256};
      } else {
        candidate=await fetchHostCandidate(async(name,args)=>({structuredContent:name==='get_task_handoff'?handoff:{ok:true,ready:true,requestId:request.requestId,...exportResult(result,args)}}),{requestId:request.requestId,artifactSha256:result.patchSha256});
        consoleBytes=Buffer.byteLength(JSON.stringify({requestId:candidate.requestId,artifactSha256:candidate.artifactSha256,state:candidate.handoff.state,requiredCheckNames:candidate.handoff.requiredCheckNames}));
      }
      const readMs=performance.now()-started;
      // Real git check/apply in this disposable copy, not the production MCP tool.
      execFileSync(git,['apply','--check','-'],{cwd,input:patch});execFileSync(git,['apply','-'],{cwd,input:patch});
      const check={checkName:handoff.requiredCheckNames[0],command:`node --test ${testPath}; git diff --check; exact scope`,cwd,run:()=>hostRun(cwd)};
      let capture;
      if(mode==='new')capture=await captureHostChecks(candidate,[check]);
      else {
        const start=performance.now(),r=await check.run(),elapsedMs=performance.now()-start;
        if(r.exitCode!==0||r.failure)throw Error('Legacy actual checks failed');
        const outputSha256=sha256(JSON.stringify({stdout:r.stdout,stderr:r.stderr}));
        const commands=[{checkName:check.checkName,command:check.command,exitCode:r.exitCode,outputSummary:JSON.stringify({cwd,elapsedMs,outputSha256,stdout:r.stdout.slice(0,1200),stderr:r.stderr.slice(0,1200),summaryTruncated:r.stdout.length>1200||r.stderr.length>1200})}];
        capture={kind:'hostEvidence',requestId:request.requestId,artifactSha256:result.patchSha256,passed:true,elapsedMs,
          outcomes:[{...r,checkName:check.checkName,command:check.command,cwd,elapsedMs,outputSha256,failure:null,passed:true}],evidence:{requestId:request.requestId,artifactSha256:result.patchSha256,commands}};
      }
      if(!capture.passed)throw Error('Replay host check failed');
      const handoffMs=performance.now()-started;
      const text=extension.toString('utf8').split(/\r?\n/).slice(0,19).join('\n');
      const sources=[{path:`${sourcePath}:1-19 (fileSha256=${sha256(extension)})`,text,sha256:sha256(text)}];
      const prepareStart=performance.now();let packet;
      if(mode==='new')packet=prepareHostReview({request,candidate,hostCapture:capture,sources}).packet;
      else packet=legacyPrepare({request,candidate,hostCapture:capture,sources});
      const prepareMs=performance.now()-prepareStart;
      for(const [file,value] of [['request',request],['candidate',candidate],['capture',capture]])fs.writeFileSync(path.join(cwd,file+'.json'),JSON.stringify(value));
      const manifest={requestFile:path.join(cwd,'request.json'),candidateFile:path.join(cwd,'candidate.json'),hostCaptureFile:path.join(cwd,'capture.json'),
        sourceSelections:[{path:sourcePath,startLine:1,endLine:19,fileSha256:sha256(extension)}]};
      fs.writeFileSync(path.join(cwd,'manifest.json'),JSON.stringify(manifest));
      const cliStart=performance.now();let prepareConsoleBytes,prepareProcesses;
      if(mode==='old') {
        const source=execFileSync(process.execPath,[own,'--legacy-source',sourceFile],{encoding:'utf8'});
        const oldSources=[{...sources[0],text:source.split(/\r?\n/).slice(0,19).join('\n')}];
        fs.writeFileSync(path.join(cwd,'legacy.json'),JSON.stringify({request,candidate,hostCapture:capture,sources:oldSources}));
        const full=execFileSync(process.execPath,[own,'--legacy-prepare',path.join(cwd,'legacy.json')],{encoding:'utf8'});
        if(JSON.parse(full).changes.content.join('')!==patch)throw Error('Legacy review omitted diff');
        prepareConsoleBytes=Buffer.byteLength(source+full);prepareProcesses=2;
      } else {
        const summary=execFileSync(process.execPath,[path.join(root,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),'prepare-review',path.join(cwd,'manifest.json'),path.join(cwd,'review.json')],{encoding:'utf8'});
        const saved=read(path.join(cwd,'review.json'));
        if(JSON.stringify(saved.packet)!==JSON.stringify(packet))throw Error('Manifest review differs from same-context packet');
        prepareConsoleBytes=Buffer.byteLength(summary);prepareProcesses=1;
      }
      const prepareCliMs=performance.now()-cliStart;
      runs.push({pair,mode,readMs,handoffMs,hostCheckMs:capture.elapsedMs,prepareMs,prepareCliMs,prepareConsoleBytes,prepareProcesses,consoleBytes,readProcesses,
        hostPassed:capture.passed,hostCommand:check.command,hostCwd:cwd,hostOutcomes:capture.outcomes,
        reviewBytes:Buffer.byteLength(JSON.stringify(packet)),requestSha256:sha256(fs.readFileSync(path.join(dir,'live-request.json'))),artifactSha256:result.patchSha256});
    }
    const summary=Object.fromEntries(['old','new'].map(mode=>{const r=runs.filter(r=>r.mode===mode);return [mode,Object.fromEntries(['readMs','handoffMs','hostCheckMs','prepareMs','prepareCliMs','prepareConsoleBytes','prepareProcesses','consoleBytes','readProcesses'].map(k=>[k,median(r.map(v=>v[k]))]))];}));
    fs.writeFileSync(out,JSON.stringify({mode:'isolated-recorded-response-replay',productionAcceptance:false,modelCalls:0,
      limitations:['Recorded MCP responses; not live gateway or model dispatch.','Handoff projection is synthetic: an accepted recorded handoff is changed to host-verification-required, with acceptance/proof cleared; this is not a new gateway event.','Legacy scripted read uses two Node processes; new path uses in-process calls.','Legacy preparation uses source-read plus build processes; new manifest CLI uses one process.','Console-byte figures are harness outputs of complete recorded JSON, not a direct production baseline measurement.','Primary reasoning/user-visible coordination delay is not measured.','Both groups use unchanged frozen task/patch and real disposable git apply and host tests.'],
      frozen:{requestSha256:runs[0].requestSha256,artifactSha256:result.patchSha256,baselineSha256:sha256(baseline),extensionSha256:sha256(extension)},runs,summary},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({summary,report:out}));
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
} else throw Error('Usage: host-handoff-benchmark.mjs <frozen-evidence-dir> <new-report.json>');
