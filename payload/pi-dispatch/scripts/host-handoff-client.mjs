// Internal read-only gateway client. Local output is exclusive: never overwrite evidence.
import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchHostCandidate,prepareHostReview,summarizeCandidate,sha256} from './host-handoff.mjs';
import {waitForHostCandidate,prepareReviewBundle,collectAcceptanceInspection} from './host-handoff-flow.mjs';
import {createHostHandoffSession,stageSummary,resumeStage,inspectDispatchReadiness} from './host-handoff-session.mjs';
import {inspectReviewMaterialBudget} from './review-materials.mjs';

function readJson(file) {
  const stat=lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>8*1024*1024)throw new Error('Invalid or oversized input file');
  return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
export function loadReviewInput(manifest) {
  if(Object.keys(manifest).some(k=>!['requestFile','candidateFile','hostCaptureFile','hostRecordFile','sourceSelections'].includes(k)))throw new Error('Invalid review manifest');
  const jsonCache=new Map(),sourceCache=new Map();
  const readOnce=file=>{const key=resolve(file);if(!jsonCache.has(key))jsonCache.set(key,readJson(file));return jsonCache.get(key);};
  const request=readOnce(manifest.requestFile),candidate=readOnce(manifest.candidateFile),hostCapture=readOnce(manifest.hostCaptureFile);
  const root=realpathSync(request.cwd),selections=manifest.sourceSelections;
  if(!Array.isArray(selections)||!selections.length||selections.length>16)throw new Error('Invalid source selections');
  const sources=selections.map(s=>{
    if(!s || typeof s.path!=='string' || isAbsolute(s.path) || s.path.includes('\\') || s.path.split('/').some(p=>!p||p==='.'||p==='..') ||
       !request.task?.readScope?.includes(s.path) || !Number.isSafeInteger(s.startLine) || !Number.isSafeInteger(s.endLine) || s.startLine<1 || s.endLine<s.startLine || s.endLine-s.startLine>=2000)throw new Error('Invalid or unadmitted source selection');
    const file=resolve(root,s.path),rel=relative(root,realpathSync(file));
    if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('Source escapes project');
    let cursor=root;
    for(const part of s.path.split('/')){cursor=resolve(cursor,part);if(lstatSync(cursor).isSymbolicLink())throw new Error('Linked source not allowed');}
    const stat=lstatSync(file);
    if(!stat.isFile()||stat.nlink!==1||stat.size>1024*1024)throw new Error('Invalid source file');
    if(!sourceCache.has(file)) {
      const bytes=readFileSync(file),full=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      sourceCache.set(file,{sha256:sha256(bytes),full,lines:full.split(/\r?\n/)});
    }
    const {sha256:fileSha256,full,lines}=sourceCache.get(file);
    if(fileSha256!==s.fileSha256)throw new Error('Current source file hash mismatch');
    if(full.includes('\0')||s.endLine>lines.length)throw new Error('Invalid source range');
    const text=lines.slice(s.startLine-1,s.endLine).join('\n');
    return {path:`${s.path}:${s.startLine}-${s.endLine} (fileSha256=${s.fileSha256})`,text,sha256:sha256(text)};
  });
  return {request,candidate,hostCapture,sources,...(manifest.hostRecordFile?{hostRecord:readOnce(manifest.hostRecordFile)}:{})};
}

function loadClosureInput(input) {
  if(!input.requestFile)return input;
  if(Object.keys(input).some(k=>!['requestFile','candidateFile','hostCaptureFile','hostRecordFile','reviewRequestFile','expectedReviewRequestSha256'].includes(k)))throw new Error('Invalid closure manifest');
  return {request:readJson(input.requestFile),candidate:readJson(input.candidateFile),hostCapture:readJson(input.hostCaptureFile),
    hostRecord:readJson(input.hostRecordFile),reviewRequest:readJson(input.reviewRequestFile),expectedReviewRequestSha256:input.expectedReviewRequestSha256};
}

export async function main(args, env=process.env) {
  const [command,inputFile,outputFile] = args;
  if (args.length !== 3 || !['candidate','prepare-review','wait-candidate','prepare-review-plan','close-acceptance','summarize-stage','resume-stage','inspect-readiness','review-budget'].includes(command) || resolve(inputFile) === resolve(outputFile)) throw new Error('Usage: host-handoff-client.mjs candidate|wait-candidate|prepare-review|prepare-review-plan|close-acceptance|summarize-stage|resume-stage|inspect-readiness|review-budget <input.json> <new-output.json>');
  const input = readJson(inputFile);
  let value,summary;
  if(command==='review-budget'){
    value=inspectReviewMaterialBudget(input);summary={ready:false,budgetFits:value.ok,admissionReady:false,
      requiresTrustedDiffBinding:value.requiresTrustedDiffBinding??false,budget:value.budget,violations:value.violations,modelCalls:0,readOnly:true};
  }else if(command==='inspect-readiness'){
    value=inspectDispatchReadiness(input);summary={ready:value.ok,modelCalls:0,readOnly:true};
  }else if(command==='summarize-stage'||command==='resume-stage'){
    const material=input.material??input,loaded=material.requestFile?loadReviewInput(material):material;
    value=command==='resume-stage'?resumeStage(input.checkpoint,loaded):stageSummary(loaded);
    summary={stage:value.stage,readOnly:true,modelCalls:0};
  }else if (command === 'prepare-review' || command === 'prepare-review-plan') {
    const {reviewOptions,...material}=input;
    const loaded=material.requestFile?loadReviewInput(material):material;
    if(command==='prepare-review-plan'){
      const prepared=createHostHandoffSession().prepare(loaded,reviewOptions);
      if(!prepared.ok)throw Object.assign(new Error(prepared.issues.map(i=>i.message).join('; ')),{readiness:prepared});
      value={...prepared.bundle,stageSummary:prepared.summary};
    }else value=prepareHostReview(loaded);
    summary = {packetSha256:value.packetSha256,budget:value.budget,elapsedMs:value.elapsedMs,requiresPrimaryInspection:true,
      ...(value.plan?{plan:{ok:value.plan.ok,modelCalls:0,readOnly:true,packetCheck:value.plan.packetCheck,thinkingDecision:value.plan.thinkingDecision,preflight:value.plan.preflight},reviewRequestSha256:value.reviewRequestSha256}:{} )};
  } else {
    if (!env.PI_GATEWAY_CONFIG) throw new Error('PI_GATEWAY_CONFIG required');
    const config = JSON.parse(readFileSync(env.PI_GATEWAY_CONFIG,'utf8').replace(/^\uFEFF/,''));
    if (!['127.0.0.1','localhost','::1'].includes(config.host ?? '127.0.0.1')) throw new Error('Only local gateway supported');
    const token = readFileSync(env.PI_GATEWAY_TOKEN_FILE ?? config.tokenFile,'utf8').trim();
    const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
    const {StreamableHTTPClientTransport} = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({name:'yhwh-host-handoff',version:'1'});
    const host = config.host === '::1' ? '[::1]' : config.host ?? '127.0.0.1';
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://${host}:${config.port ?? 7331}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
      const callTool=async(name,arguments_)=>{
        if(!['wait_subagent','get_subagent_result','get_task_handoff'].includes(name))throw new Error('Read-only handoff tool required');
        return client.callTool({name,arguments:arguments_},undefined,{timeout:60000,maxTotalTimeout:60000});
      };
      if(command==='wait-candidate'){
        value=await waitForHostCandidate(callTool,input);
        summary={ready:value.ready,...(value.ready?summarizeCandidate(value.candidate):{requestId:value.requestId,state:value.state}),requiresPrimaryInspection:true};
      }else if(command==='close-acceptance'){
        value=await collectAcceptanceInspection(callTool,loadClosureInput(input));
        summary={requestId:value.requestId,readyForPrimaryAcceptance:value.readyForPrimaryAcceptance,requiresPrimaryAcceptance:true};
      }else{
        value=await fetchHostCandidate(callTool,input);
        summary=summarizeCandidate(value);
      }
    } finally { await client.close().catch(()=>{}); }
  }
  writeFileSync(outputFile,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  return {ok:true,outputFile:resolve(outputFile),...summary};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)),null,2)); }
  catch (error) { console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1; }
}
