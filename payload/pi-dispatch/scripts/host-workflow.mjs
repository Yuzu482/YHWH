import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const catalog=JSON.parse(readFileSync(new URL('../workflow/catalog.json',import.meta.url),'utf8'));
export const primaryPolicy=Object.freeze({
  mode:'coordinator-only',
  implementationOwner:'pi-subagents',
  directCoding:false,
  unavailableWorkerAction:'blocked',
  enforcement:'host-instructions',
});
export const workflowInstructions='YHWH provides governed Pi execution for the primary agent in this host. The primary is coordinator-only: it owns thinking, scheduling and integration, while implementation must be delegated to Pi subagents using the existing role bindings. Do not code directly or fall back to direct coding when a worker is unavailable; block instead. Read primary only if the host has not injected it. Before Pi model selection, read pi-routing and list_capabilities. Topic-gated tools require a fresh workflowReceipt from get_workflow for that topic. Fetching a topic proves retrieval only, not compliance. Preserve host permissions and role bindings; use discovered tool names.';
export function workflowTopic(topic='primary'){
  if(!Object.hasOwn(catalog.topics,topic))throw new Error('Unknown workflow topic');
  const content=catalog.topics[topic];
  return {version:catalog.version,topic,sha256:createHash('sha256').update(content).digest('hex'),content,availableTopics:Object.keys(catalog.topics),enforcement:'Pi invocation checks only; host compliance is not attested',primaryPolicy};
}
export function registerHostWorkflow(server,{receipts,onRead}={}){
  server.registerTool('get_workflow',{
    description:'Read a YHWH policy topic on its trigger. A gateway may return a short-lived workflowReceipt for topic-gated tools. No model call or file-path access.',
    inputSchema:{topic:z.enum(Object.keys(catalog.topics)).default('primary')},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({topic})=>{
    const result=workflowTopic(topic);
    if(receipts) Object.assign(result,receipts.issue(topic,result.sha256));
    onRead?.(topic,result.sha256);
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  });
}
