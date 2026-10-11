// Host-only integration harness: real Pi models, candidate launcher, isolated gateway and ledger.
import fs from 'node:fs';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createGatewayApp} from '../../scripts/gateway.mjs';import{dispatch}from'../../scripts/dispatch.mjs';
import{piRuntime}from'../../scripts/worker-runtime/pi/index.mjs';import{probeWslSandbox}from'../../scripts/wsl-sandbox.mjs';
import{resolveRuntime}from'../../scripts/worker-runtime/index.mjs';
import{prepareCandidate}from'./run-check-candidate.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
export const parseMcp=r=>{if(r.structuredContent)return r.structuredContent;const value=r.content.find(c=>c.type==='text')?.text??'';try{return JSON.parse(value);}catch{throw Error('MCP response was not JSON: '+value.slice(0,1800));}};
export async function candidateGateway({directory,storageDirectory=directory,workspaces,policyPath,projectFiles=[],toolEnabled,onExecutionProgress}){
  fs.mkdirSync(directory,{recursive:true});const candidate=await prepareCandidate({policyPath,projectFiles});
  fs.writeFileSync(path.join(directory,'candidate.json'),JSON.stringify(candidate,null,2));
  const sandboxStatus=probeWslSandbox(process.env,{candidate:candidate.configuration});
  if(!sandboxStatus.ok)throw Error('candidate sandbox probe failed: '+JSON.stringify(sandboxStatus));
  const token=randomBytes(32).toString('hex');
  const runtimeResolver=request=>request.provider==='claude-code-cli'?resolveRuntime(request):({...piRuntime,run:(prepared,options)=>piRuntime.run(prepared,{...options,candidate:candidate.configuration,disableChecks:!toolEnabled})});
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:workspaces,token,sandboxStatus,maxConcurrency:1,
    auditFile:path.join(storageDirectory,'audit.jsonl'),requestLedgerDir:path.join(storageDirectory,'ledger'),
    dispatchFn:(request,signal,task,options)=>dispatch(request,signal,task,{...options,runtimeResolver,onProgress:value=>{options.onProgress?.(value);onExecutionProgress?.(value,candidate);}})});
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
  const client=new Client({name:'yhwh-run-check-replay',version:'1'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+server.address().port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));}
  catch(e){await runtime.shutdown({graceMs:100,abortWaitMs:100});server.close();throw e;}
  return{candidate,client,runtime,async call(name,args){return parseMcp(await client.callTool({name,arguments:args},undefined,{timeout:1000000}));},async close(){await client.close();await runtime.shutdown({graceMs:100,abortWaitMs:100});await new Promise(done=>server.close(done));}};
}
export function freezePacket(file,packet,provenance){
  const bytes=JSON.stringify(packet,null,2)+'\n';
  if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==bytes)throw Error('frozen packet cannot change');
  if(!fs.existsSync(file))fs.writeFileSync(file,bytes,{flag:'wx'});
  const record={...provenance,packetSha256:sha(bytes),taskSha256:sha(JSON.stringify(packet.task)),frozenAt:new Date().toISOString()};
  if(!fs.existsSync(file+'.provenance.json'))fs.writeFileSync(file+'.provenance.json',JSON.stringify(record,null,2),{flag:'wx'});
  return record;
}
