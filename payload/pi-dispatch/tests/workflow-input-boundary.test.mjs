import test from 'node:test';
import assert from 'node:assert/strict';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerHostWorkflow,workflowTopic} from '../scripts/host-workflow.mjs';

test('get_workflow MCP boundary advertises and enforces the workflow topic contract',async()=>{
 const server=new McpServer({name:'workflow-boundary-test',version:'1'});
 const client=new Client({name:'workflow-boundary-test-client',version:'1'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 registerHostWorkflow(server);
 try{
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const expectedTopics=workflowTopic().availableTopics;
  const tools=await client.listTools();
  const tool=tools.tools.find(candidate=>candidate.name==='get_workflow');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.topic.enum,expectedTopics);

  const defaultResult=await client.callTool({name:'get_workflow',arguments:{}});
  assert.deepEqual(JSON.parse(defaultResult.content[0].text),workflowTopic());
  assert.deepEqual(JSON.parse(defaultResult.content[0].text).primaryPolicy,workflowTopic().primaryPolicy);

  for(const topic of expectedTopics){
   const result=await client.callTool({name:'get_workflow',arguments:{topic}});
   assert.deepEqual(JSON.parse(result.content[0].text),workflowTopic(topic));
  }

  for(const topic of [42,null,[],{},'unknown','__proto__']){
   let result;
   try{result=await client.callTool({name:'get_workflow',arguments:{topic}});}
   catch{continue;}
   assert.equal(result.isError,true);
  }
 } finally{
  await client.close();
  await server.close();
 }
});
