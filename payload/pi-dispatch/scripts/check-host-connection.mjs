import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
export async function checkHostConnection(connection){
  const client=new Client({name:'yhwh-host-adapter-check',version:'1.0.0'});
  const transport=new StdioClientTransport({...connection,env:{...process.env,...connection.env},stderr:'pipe'});
  try{
    await client.connect(transport,{timeout:30000});
    const {tools}=await client.listTools();
    const required=['get_workflow','list_capabilities','submit_subagent','get_subagent_status','get_subagent_result','lsp_request'];
    const missing=required.filter(name=>!tools.some(tool=>tool.name===name));
    if(missing.length)throw new Error(`Missing required tools: ${missing.join(', ')}`);
    const response=await client.callTool({name:'get_workflow',arguments:{topic:'primary'}});
    if(response.isError)throw new Error('Primary workflow retrieval failed');
    const policy=JSON.parse(response.content.find(item=>item.type==='text').text);
    if(policy.topic!=='primary'||!policy.content||!policy.sha256)throw new Error('Invalid workflow response');
    return {transport:'passed',toolDiscovery:'passed',policyRetrieval:'passed',policySha256:policy.sha256,toolCount:tools.length,modelCalls:0,sandbox:'unverified',hostInstructionLoading:'unverified',hostUi:'unverified',modelHeartbeat:'unverified'};
  }finally{await client.close();await transport.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await checkHostConnection(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
