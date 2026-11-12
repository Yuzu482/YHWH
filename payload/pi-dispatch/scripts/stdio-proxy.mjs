import {readFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ListToolsRequestSchema,ListToolsResultSchema,CallToolRequestSchema,CallToolResultSchema,ListResourcesRequestSchema,ListResourcesResultSchema,ReadResourceRequestSchema,ReadResourceResultSchema,ListResourceTemplatesRequestSchema,ListResourceTemplatesResultSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {createLspApprovalRunner} from './lsp-approval-runner.mjs';

// Leave time for a human response while staying below the gateway's four-minute
// one-time challenge lifetime. A timeout never constitutes approval.
const LSP_CONFIRMATION_TIMEOUT_MS=180000;

export function readProxyConfig(configPath){
  if(!configPath||!isAbsolute(configPath))throw new Error('PI_GATEWAY_CONFIG must be an absolute path');
  const config=JSON.parse(readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
  const host=config.host??'127.0.0.1',port=config.port??7331;
  if(!['127.0.0.1','localhost','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Shared gateway must use loopback');
  if(typeof config.tokenFile!=='string'||!config.tokenFile)throw new Error('Shared gateway token file is required');
  const token=readFileSync(resolve(dirname(configPath),config.tokenFile),'utf8').trim();
  if(token.length<24||/[\r\n]/.test(token))throw new Error('Invalid shared gateway token');
  return {url:`http://${host==='::1'?'[::1]':host}:${port}/mcp`,token,roots:config.roots??[],stateDir:resolve(dirname(configPath),'lsp-approval')};
}

// This transport exposes the existing Gateway's tools AND UI resources locally.
// It must never create a second scheduler, monitor, ledger or sandbox runtime.
export async function startStdioProxy({configPath,transport=new StdioServerTransport()}={}){
  const {url,token,roots,stateDir}=readProxyConfig(configPath);
  const client=new Client({name:'pi-kether-local-bridge',version:'1.0.0'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`},redirect:'error'}}));}
  catch{await client.close().catch(()=>{});throw new Error('Shared Pi gateway unavailable; start the configured local runtime');}
  const server=new Server({name:'pi-kether-gateway',version:'1.0.0'},{capabilities:{tools:{},resources:{}}});
  const lspApproval=createLspApprovalRunner({roots,stateDir});
  const pendingConfirmations=new Map();
  const blocked=(message,reason)=>({isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:'PI_LSP_CONFIRMATION_BLOCKED',error:message,...(reason?{reason}:{})})}]});
  const routes=[[ListToolsRequestSchema,ListToolsResultSchema],[CallToolRequestSchema,CallToolResultSchema],[ListResourcesRequestSchema,ListResourcesResultSchema],[ReadResourceRequestSchema,ReadResourceResultSchema],[ListResourceTemplatesRequestSchema,ListResourceTemplatesResultSchema]];
  for(const [requestSchema,resultSchema] of routes)server.setRequestHandler(requestSchema,async(request,extra)=>{
    try{
      if(request.method==='tools/list'){
        const listed=await client.request(request,resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});
        const lsp=listed.tools.find(tool=>tool.name==='lsp_request');
        if(lsp&&listed.tools.some(tool=>tool.name==='lsp_confirmation_enforced_v1')&&!listed.tools.some(tool=>tool.name==='lsp_confirmed_request')){
          const properties={...lsp.inputSchema.properties};delete properties.confirmationNonce;
          listed.tools.push({...lsp,name:'lsp_confirmed_request',inputSchema:{...lsp.inputSchema,properties},description:'Run the governed LSP query with per-repository confirmation on first use and major changes. '+lsp.description});
        }
        return listed;
      }
      if(request.method==='tools/call'&&['lsp_request','lsp_confirmed_request'].includes(request.params.name)){
        const input={...(request.params.arguments??{})};if(!input.requestId)input.requestId=randomUUID();
        const first={...request,params:{...request.params,name:'lsp_confirmation_enforced_v1',arguments:input}};
        let result=await client.request(first,resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});
        let challenge=result.structuredContent?.challenge;
        if(result.structuredContent?.code!=='PI_LSP_CONFIRMATION_REQUIRED'||!challenge)return result;
        let key=challenge.repoHash;
        while(key&&pendingConfirmations.has(key)){
          await pendingConfirmations.get(key);
          result=await client.request(first,resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});
          challenge=result.structuredContent?.challenge;
          if(result.structuredContent?.code!=='PI_LSP_CONFIRMATION_REQUIRED'||!challenge)return result;
          key=challenge.repoHash;
        }
        let finishPending;const pending=key?new Promise(resolve=>{finishPending=resolve}):null;
        if(key)pendingConfirmations.set(key,pending);
        try{
        let message;
        if(challenge.reason==='first')message=`首次对代码库 ${challenge.repo} 运行 LSP。确认后，累计变动达到 50 个文件或 2000 行时会再次询问。`;
        else if(challenge.reason==='files'||challenge.reason==='lines')message=`代码库 ${challenge.repo} 自上次确认以来变动达到门槛（${challenge.changedFiles} 个文件，${challenge.changedLines??'未计算'} 行）。确认继续 LSP？`;
        else if(challenge.reason==='inspection-unavailable')message='无法可靠计算代码库变化。是否仅允许这一次 LSP 查询？';
        else return blocked('unsupported_confirmation_challenge');
        let answer;try{answer=await server.elicitInput({mode:'form',message,requestedSchema:{type:'object',properties:{}}},{signal:extra.signal,relatedRequestId:extra.requestId,timeout:LSP_CONFIRMATION_TIMEOUT_MS})}catch(error){
          const reason=extra.signal?.aborted?'request_cancelled':error?.code===ErrorCode.RequestTimeout?'confirmation_timeout':!server.getClientCapabilities()?.elicitation?.form?'form_unsupported':error?.code===ErrorCode.ConnectionClosed?'connection_closed':'client_error';
          return blocked('confirmation_unavailable',reason);
        }
        if(answer.action!=='accept')return blocked('confirmation_declined');
        try{
          if(challenge.reason==='inspection-unavailable'){await lspApproval.issueOneTime(input,challenge,extra.signal);input.confirmationNonce=challenge.nonce;}
          else await lspApproval.accept(input,challenge,extra.signal);
        }catch(error){return blocked(error.message)}
        return await client.request({...first,params:{...first.params,arguments:input}},resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});
        } finally {if(key&&pendingConfirmations.get(key)===pending)pendingConfirmations.delete(key);finishPending?.();}
      }
      return await client.request(request,resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});
    }
    catch{throw new McpError(ErrorCode.InternalError,'Shared Pi gateway request failed; reconcile a write by its requestId before retrying');}
  });
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;await server.close().catch(()=>{});await client.close().catch(()=>{});};
  server.onclose=()=>{void close();};
  try{await server.connect(transport);}catch(error){await close();throw error;}
  return {server,close};
}
