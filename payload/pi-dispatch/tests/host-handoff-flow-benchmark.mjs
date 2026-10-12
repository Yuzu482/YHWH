// Opt-in alternating replay of ONE frozen task and patch. Real isolated git apply
// and host commands; recorded model/review/acceptance responses; zero model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import express from 'express';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {listenHttpFixture} from './http-fixture.mjs';
import {exportResult} from '../extensions/result-export.js';
import {runProcess} from '../scripts/headless-host.mjs';
import {sha256,captureHostChecks} from '../scripts/host-handoff.mjs';
import {collectAcceptanceInspection} from '../scripts/host-handoff-flow.mjs';

const own=fileURLToPath(import.meta.url),root=path.resolve(path.dirname(own),'../../..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};

// Restricted synthetic transport used only by tests/replay; never a production
// gateway. Unknown tools/IDs are errors, not fallback to actual workers.
export async function createReplayGateway({requestId,result,review,handoff,ready=true}) {
  const token='synthetic-replay-only-token',calls=[],app=express();app.use(express.json({limit:'1mb'}));
  app.post('/mcp',async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`)return res.status(401).end();
    const server=new McpServer({name:'yhwh-offline-replay',version:'1'});
    const response=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
    server.registerTool('wait_subagent',{inputSchema:{requestId:z.string(),timeoutMs:z.number().optional()}},async args=>{
      calls.push({name:'wait_subagent',args});if(args.requestId!==requestId)throw Error('Unknown replay task');
      return response({ok:true,ready,requestId,state:ready?'awaiting-host-verification':'running'});
    });
    server.registerTool('get_subagent_result',{inputSchema:{requestId:z.string(),offset:z.number().optional(),limit:z.number().optional()}},async args=>{
      calls.push({name:'get_subagent_result',args});
      const value=args.requestId===requestId?result:args.requestId===review.requestId?review:null;
      if(!value)throw Error('Unknown replay result');
      return response({ok:true,ready:true,requestId:args.requestId,...exportResult(value,args)});
    });
    server.registerTool('get_task_handoff',{inputSchema:{requestId:z.string(),artifactSha256:z.string().optional()}},async args=>{
      calls.push({name:'get_task_handoff',args});if(args.requestId!==requestId||args.artifactSha256!==handoff.artifactSha256)throw Error('Unknown replay artifact');
      return response(handoff);
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    res.on('close',()=>{void transport.close();void server.close();});
    try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
    catch{if(!res.headersSent)res.status(500).end();}
  });
  const http=await listenHttpFixture(app);
  return {calls,token,port:http.address().port,close:()=>new Promise(r=>{http.close(r);http.closeAllConnections();})};
}

async function readResultCli(configFile,requestId) {
  // Baseline bootstrap/result export, mirroring the previous separate host read.
  const config=read(configFile),token=fs.readFileSync(config.tokenFile,'utf8');
  const client=new Client({name:'baseline-replay-reader',version:'1'});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    let json='',offset=0,digest,total;
    do{
      const r=await client.callTool({name:'get_subagent_result',arguments:{requestId,offset,limit:65536}}),p=r.structuredContent;
      if(!p?.ok||p.offset!==offset||p.encoding!=='json-utf16-offsets'||(digest&&(digest!==p.sha256||total!==p.totalLength)))throw Error('Invalid baseline replay page');
      digest=p.sha256;total=p.totalLength;json+=p.result!==undefined?JSON.stringify(p.result):p.resultJsonChunk;offset=p.nextOffset;
    }while(offset!==null);
    if(json.length!==total||sha256(json)!==digest)throw Error('Baseline replay digest mismatch');
    return JSON.parse(json);
  }finally{await client.close();}
}

export async function benchmark(dir,baselineRoot,out) {
  if(!out.endsWith('.json')||fs.existsSync(out)||fs.existsSync(out.replace(/\.json$/,'.details.json')))throw Error('New unique JSON report and details required');
  const request=read(path.join(dir,'live-request.json')),record=read(path.join(dir,'live-host-record.value.json')),
    accepted=read(path.join(dir,'live-handoff.value.json')),candidate=read(path.join(dir,'live-candidate.json')),
    review=read(path.join(dir,'live-review-result.value.json')).result;
  const patch=fs.readFileSync(path.join(dir,'live.patch'),'utf8'),baseline=fs.readFileSync(path.join(dir,'live-baseline-test.mjs'));
  if(patch!==candidate.result.patch||sha256(patch)!==candidate.artifactSha256||sha256(JSON.stringify(candidate.result))!==candidate.resultSha256)throw Error('Frozen task/patch drift');
  const testPath='payload/pi-dispatch/tests/source-window.test.mjs',sourcePath='payload/pi-dispatch/extensions/source-window.js';
  const source=fs.readFileSync(path.join(root,sourcePath));
  if(sha256(source)!=='0897cc01b8997a6777dd3105c679eb016f34cb37ca579d2dd0923416772afe96')throw Error('Frozen source drift');
  const oldScript=path.join(baselineRoot,'payload/pi-dispatch/scripts/host-handoff.mjs');
  if(sha256(fs.readFileSync(oldScript))!=='ad4e1e9f135280f9f103a9859c80741e0df86abbedbbc955b153036764287e05')throw Error('Baseline helper drift');
  const old=await import(pathToFileURL(oldScript));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-p3p5-replay-')),git=process.env.YHWH_GIT??'git',runs=[];
  const gateway=await createReplayGateway({requestId:request.requestId,result:candidate.result,review,handoff:accepted});
  const config=path.join(temp,'gateway.json'),tokenFile=path.join(temp,'token');
  fs.writeFileSync(tokenFile,gateway.token);fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:gateway.port,tokenFile}));
  const commandEnv={...process.env,PI_GATEWAY_CONFIG:config,PI_GATEWAY_TOKEN_FILE:tokenFile};
  const details={};
  try{
    for(let pair=0;pair<5;pair++)for(const mode of pair%2?['new','old']:['old','new']){
      const cwd=path.join(temp,`${pair}-${mode}`);fs.mkdirSync(path.dirname(path.join(cwd,testPath)),{recursive:true});fs.mkdirSync(path.dirname(path.join(cwd,sourcePath)),{recursive:true});
      fs.writeFileSync(path.join(cwd,testPath),baseline);fs.writeFileSync(path.join(cwd,sourcePath),source);fs.writeFileSync(path.join(cwd,'package.json'),' {"type":"module"}\n');fs.writeFileSync(path.join(cwd,'.gitattributes'),'* text eol=lf\n');
      const gitArgs=args=>['-c',`safe.directory=${cwd}`,'-c','core.autocrlf=false',...args];
      execFileSync(git,gitArgs(['init','-q']),{cwd});execFileSync(git,gitArgs(['add','.']),{cwd});
      execFileSync(git,gitArgs(['-c','user.name=Replay','-c','user.email=replay@invalid','commit','-qm','frozen replay baseline']),{cwd});
      const paths={};for(const name of ['wait','identity','candidate','material','prepared','review-request','closure','inspection'])paths[name]=path.join(temp,`${pair}-${mode}-${name}.json`);
      fs.writeFileSync(paths.wait,JSON.stringify({requestId:request.requestId,timeoutMs:0}));
      let children=0;const begin=performance.now(),callStart=gateway.calls.length,phase={};
      const cli=async(script,args)=>{
        children++;const r=await runProcess(process.execPath,[script,...args],{cwd:root,env:commandEnv,timeoutMs:30000,maxOutputBytes:524288});
        if(r.exitCode!==0||r.failure)throw Error(`Replay child failed: ${r.stderr||r.failure}`);return JSON.parse(r.stdout);
      };
      let t=performance.now();
      if(mode==='old'){
        await cli(path.join(baselineRoot,'payload/pi-dispatch/scripts/gateway-client.mjs'),['wait',paths.wait]);
        const bootstrap=await cli(own,['--read-result',config,request.requestId]);
        fs.writeFileSync(paths.identity,JSON.stringify({requestId:request.requestId,artifactSha256:bootstrap.patchSha256}));
        await cli(path.join(baselineRoot,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),['candidate',paths.identity,paths.candidate]);
      }else{
        await cli(path.join(root,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),['wait-candidate',paths.wait,paths.candidate]);
      }
      const gathered=read(paths.candidate),c=mode==='new'?gathered.candidate:gathered;
      if(c.result.patch!==patch)throw Error('Replay patch changed');phase.handoffMs=performance.now()-t;
      t=performance.now();
      const patchFile=path.join(temp,`${pair}-${mode}.patch`);fs.writeFileSync(patchFile,patch);
      for(const args of [['apply','--check',patchFile],['apply',patchFile]]){
        const r=await runProcess(git,gitArgs(args),{cwd,timeoutMs:30000,maxOutputBytes:262144});if(r.exitCode!==0||r.failure)throw Error('Replay apply failed: '+r.stderr);
      }
      phase.applyMs=performance.now()-t;t=performance.now();
      const capture=mode==='old'?old.captureHostChecks:captureHostChecks;
      const hostCapture=await capture(c,[{checkName:c.handoff.requiredCheckNames[0],command:'node --test source-window; git diff --check; git diff --name-only (exact scope)',cwd,run:async()=>{
        const specs=[['test',process.execPath,['--test',testPath]],['whitespace',git,gitArgs(['diff','--check'])],['scope',git,gitArgs(['diff','--name-only'])]],steps=[];
        for(const [name,exe,args] of specs){const start=performance.now(),r=await runProcess(exe,args,{cwd,timeoutMs:120000,maxOutputBytes:262144});
          steps.push({name,command:[path.basename(exe),...args].join(' '),exitCode:r.exitCode,failure:r.failure??null,stdout:r.stdout,stderr:r.stderr,elapsedMs:performance.now()-start});}
        if(steps[2].stdout.trim()!==testPath)throw Error('Replay scope mismatch');
        return {exitCode:steps.every(s=>s.exitCode===0&&!s.failure)?0:1,stdout:steps.map(s=>s.name+'\n'+s.stdout).join('\n'),stderr:steps.map(s=>s.stderr).join('\n'),steps};
      }}]);
      if(!hostCapture.passed)throw Error('Real replay host checks failed');phase.hostChecksMs=performance.now()-t;
      const sources=read(path.join(dir,'live-prepared-review.json')).packet.context.content.slice(-2).map(s=>{const p=JSON.parse(s);return {path:p.path,text:p.text,sha256:p.excerptSha256};});
      // Update test-fixture excerpt hash to the ACTUAL applied frozen file (same
      // bytes in both arms); supplied source code remains identical.
      const fileHash=sha256(fs.readFileSync(path.join(cwd,testPath)));
      sources[0].path=sources[0].path.replace(/fileSha256=[a-f0-9]{64}/,`fileSha256=${fileHash}`);
      const material={request,candidate:c,hostCapture,sources,hostRecord:record};
      const options={requestId:review.requestId,thinking:'medium',reason:'Focused EOF regression; recorded replay only'};
      fs.writeFileSync(paths.material,JSON.stringify(mode==='new'?{...material,reviewOptions:options}:{request,candidate:c,hostCapture,sources}));
      t=performance.now();let bundle;
      if(mode==='old'){
        await cli(path.join(baselineRoot,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),['prepare-review',paths.material,paths.prepared]);
        const p=read(paths.prepared),reviewRequest={...read(path.join(dir,'live-review-request.json')),task:{...p.taskTemplate,reviewPacket:p.packet}};
        fs.writeFileSync(paths['review-request'],JSON.stringify(reviewRequest));
        const plan=await cli(path.join(baselineRoot,'payload/pi-dispatch/scripts/gateway-client.mjs'),['task-plan',paths['review-request']]);
        if(!plan.ok)throw Error('Baseline plan failed');bundle={packet:p.packet,budget:p.budget,reviewRequest:plan.request,reviewRequestSha256:sha256(JSON.stringify(plan.request))};
      }else{
        await cli(path.join(root,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),['prepare-review-plan',paths.material,paths.prepared]);bundle=read(paths.prepared);
      }
      phase.preparePlanMs=performance.now()-t;
      const closure={...material,reviewRequest:bundle.reviewRequest,expectedReviewRequestSha256:bundle.reviewRequestSha256};fs.writeFileSync(paths.closure,JSON.stringify(closure));
      t=performance.now();
      if(mode==='old'){
        const r=await cli(own,['--read-result',config,review.requestId]);
        const h=await cli(path.join(baselineRoot,'payload/pi-dispatch/scripts/gateway-client.mjs'),['handoff',paths.identity]);
        // Identical reference reconciliation after separate baseline reads. This
        // does not time or fabricate the primary's reasoning or final acceptance.
        await collectAcceptanceInspection(async name=>({structuredContent:name==='get_task_handoff'?h:{ok:true,ready:true,requestId:review.requestId,...exportResult(r)}}),closure);
      }else await cli(path.join(root,'payload/pi-dispatch/scripts/host-handoff-client.mjs'),['close-acceptance',paths.closure,paths.inspection]);
      phase.inspectionMs=performance.now()-t;
      runs.push({pair,mode,...phase,totalMs:performance.now()-begin,orchestrationChildProcesses:children,gatewayReads:gateway.calls.length-callStart,hostPassed:true,
        taskSha256:sha256(JSON.stringify(request)),patchSha256:sha256(patch),budget:bundle.budget});
      details[`${pair}-${mode}`]={hostCapture,packet:bundle.packet,calls:gateway.calls.slice(callStart)};
    }
    const metrics=['handoffMs','preparePlanMs','inspectionMs','applyMs','hostChecksMs','totalMs','orchestrationChildProcesses','gatewayReads'];
    const medians=Object.fromEntries(['old','new'].map(mode=>[mode,Object.fromEntries(metrics.map(key=>[key,median(runs.filter(r=>r.mode===mode).map(r=>r[key]))]))]));
    const report={kind:'isolated-recorded-response-replay',modelCalls:0,newProductionTasks:0,primaryReasoningMeasured:false,pairs:5,
      baselineCommit:'e0525f64e0e555eb1ef4e9fb81c4491f8a2b8a4f',taskSha256:sha256(JSON.stringify(request)),patchSha256:sha256(patch),
      limitations:['One frozen task; not production latency or new accepted task evidence.','No artificial idle waits; excludes primary inference and independent review execution.','Historical model/review/acceptance responses are replayed; real isolated git application and host commands run in both arms.'],medians,runs};
    fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    fs.writeFileSync(out.replace(/\.json$/,'.details.json'),JSON.stringify(details,null,2)+'\n',{flag:'wx'});
    return report;
  }finally{await gateway.close();fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===own){
  if(process.argv[2]==='--read-result')console.log(JSON.stringify(await readResultCli(process.argv[3],process.argv[4])));
  else if(process.argv.length===5)console.log(JSON.stringify(await benchmark(...process.argv.slice(2)),null,2));
  else throw Error('Usage: host-handoff-flow-benchmark.mjs <frozen-evidence-dir> <baseline-worktree> <new-report.json>');
}
