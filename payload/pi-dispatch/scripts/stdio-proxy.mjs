import {readFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ListToolsRequestSchema,ListToolsResultSchema,CallToolRequestSchema,CallToolResultSchema,ListResourcesRequestSchema,ListResourcesResultSchema,ReadResourceRequestSchema,ReadResourceResultSchema,ListResourceTemplatesRequestSchema,ListResourceTemplatesResultSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';

export function readProxyConfig(configPath){
  if(!configPath||!isAbsolute(configPath))throw new Error('PI_GATEWAY_CONFIG must be an absolute path');
  const config=JSON.parse(readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
  const host=config.host??'127.0.0.1',port=config.port??7331;
  if(!['127.0.0.1','localhost','::1'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Shared gateway must use loopback');
  if(typeof config.tokenFile!=='string'||!config.tokenFile)throw new Error('Shared gateway token file is required');
  const token=readFileSync(resolve(dirname(configPath),config.tokenFile),'utf8').trim();
  if(token.length<24||/[\r\n]/.test(token))throw new Error('Invalid shared gateway token');
  return {url:`http://${host==='::1'?'[::1]':host}:${port}/mcp`,token};
}

// This transport exposes the existing Gateway's tools AND UI resources locally.
// It must never create a second scheduler, monitor, ledger or sandbox runtime.
export async function startStdioProxy({configPath,transport=new StdioServerTransport()}={}){
  const {url,token}=readProxyConfig(configPath);
  const client=new Client({name:'pi-kether-local-bridge',version:'1.0.0'});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`},redirect:'error'}}));}
  catch{await client.close().catch(()=>{});throw new Error('Shared Pi gateway unavailable; start the configured local runtime');}
  const server=new Server({name:'pi-kether-gateway',version:'1.0.0'},{capabilities:{tools:{},resources:{}}});
  const routes=[[ListToolsRequestSchema,ListToolsResultSchema],[CallToolRequestSchema,CallToolResultSchema],[ListResourcesRequestSchema,ListResourcesResultSchema],[ReadResourceRequestSchema,ReadResourceResultSchema],[ListResourceTemplatesRequestSchema,ListResourceTemplatesResultSchema]];
  for(const [requestSchema,resultSchema] of routes)server.setRequestHandler(requestSchema,async(request,extra)=>{
    try{return await client.request(request,resultSchema,{signal:extra.signal,timeout:1810000,maxTotalTimeout:1810000});}
    catch{throw new McpError(ErrorCode.InternalError,'Shared Pi gateway request failed; reconcile a write by its requestId before retrying');}
  });
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;await server.close().catch(()=>{});await client.close().catch(()=>{});};
  server.onclose=()=>{void close();};
  try{await server.connect(transport);}catch(error){await close();throw error;}
  return {server,close};
}
