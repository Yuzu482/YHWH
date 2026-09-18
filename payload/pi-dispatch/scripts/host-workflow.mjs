import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const catalog=JSON.parse(readFileSync(new URL('../workflow/catalog.json',import.meta.url),'utf8'));
export const workflowInstructions='YHWH provides governed Pi execution for the primary agent in this host. Before orchestration, read get_workflow(topic="primary") and pi-routing, then list_capabilities. Preserve host permissions; fetching instructions does not attest compliance. Use discovered tool names, which may have a host prefix.';
export function workflowTopic(topic='primary'){
  if(!Object.hasOwn(catalog.topics,topic))throw new Error('Unknown workflow topic');
  const content=catalog.topics[topic];
  return {version:catalog.version,topic,sha256:createHash('sha256').update(content).digest('hex'),content,availableTopics:Object.keys(catalog.topics),enforcement:'Pi invocation checks only; host compliance is not attested'};
}
export function registerHostWorkflow(server){
  server.registerTool('get_workflow',{
    description:'Read the YHWH primary-agent contract, role skills or governance reference by an advertised topic. Read primary before using Pi from any host. No model call or file-path access.',
    inputSchema:{topic:z.enum(Object.keys(catalog.topics)).default('primary')},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({topic})=>({content:[{type:'text',text:JSON.stringify(workflowTopic(topic))}]}));
}
