// Internal read-only gateway client. Local output is exclusive: never overwrite evidence.
import {readFileSync,writeFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchHostCandidate,prepareHostReview,summarizeCandidate,sha256} from './host-handoff.mjs';

function readJson(file) {
  const stat=lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size>8*1024*1024)throw new Error('Invalid or oversized input file');
  return JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
export function loadReviewInput(manifest) {
  if(Object.keys(manifest).some(k=>!['requestFile','candidateFile','hostCaptureFile','sourceSelections'].includes(k)))throw new Error('Invalid review manifest');
  const request=readJson(manifest.requestFile),candidate=readJson(manifest.candidateFile),hostCapture=readJson(manifest.hostCaptureFile);
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
    const bytes=readFileSync(file);
    if(sha256(bytes)!==s.fileSha256)throw new Error('Current source file hash mismatch');
    const full=new TextDecoder('utf-8',{fatal:true}).decode(bytes),lines=full.split(/\r?\n/);
    if(full.includes('\0')||s.endLine>lines.length)throw new Error('Invalid source range');
    const text=lines.slice(s.startLine-1,s.endLine).join('\n');
    return {path:`${s.path}:${s.startLine}-${s.endLine} (fileSha256=${s.fileSha256})`,text,sha256:sha256(text)};
  });
  return {request,candidate,hostCapture,sources};
}

export async function main(args, env=process.env) {
  const [command,inputFile,outputFile] = args;
  if (args.length !== 3 || !['candidate','prepare-review'].includes(command) || resolve(inputFile) === resolve(outputFile)) throw new Error('Usage: host-handoff-client.mjs candidate|prepare-review <input.json> <new-output.json>');
  const input = readJson(inputFile);
  let value,summary;
  if (command === 'prepare-review') {
    value = prepareHostReview(input.requestFile ? loadReviewInput(input) : input);
    summary = {packetSha256:value.packetSha256,budget:value.budget,elapsedMs:value.elapsedMs,requiresPrimaryInspection:true};
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
      value = await fetchHostCandidate(async(name,arguments_) => client.callTool({name,arguments:arguments_},undefined,{timeout:30000,maxTotalTimeout:30000}),input);
      summary = summarizeCandidate(value);
    } finally { await client.close().catch(()=>{}); }
  }
  writeFileSync(outputFile,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  return {ok:true,outputFile:resolve(outputFile),...summary};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)),null,2)); }
  catch (error) { console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1; }
}
