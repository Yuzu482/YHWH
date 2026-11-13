import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
const catalog=JSON.parse(readFileSync(new URL('../workflow/catalog.json',import.meta.url),'utf8'));
export const primaryPolicy=Object.freeze({
  mode:'host-selected',
  implementationOwner:'primary-or-delegate',
  directCoding:false,
  directCodingScope:'legacy Pi coordinator-only channel; not a statement of primary host permissions',
  hostDirectCoding:'determined by current host instructions and user authorization',
  unavailableWorkerAction:'continue-authorized-work',
  enforcement:'host-instructions',
});
export const workflowInstructions='The primary owns implementation and may work directly or delegate as allowed by current host instructions and user authorization. Pi is optional for work outside Pi. Pi calls remain subject to their advertised role, tier, review and ledger checks. Preserve existing task identity, history and explicit limits. Before Pi model selection, read pi-routing and list_capabilities. Topic-gated tools require a fresh workflowReceipt; retrieval is not compliance or authority.';
export function workflowTopic(topic='primary'){
  if(!Object.hasOwn(catalog.topics,topic))throw new Error('Unknown workflow topic');
  const content=catalog.topics[topic];
  return {version:catalog.version,topic,sha256:createHash('sha256').update(content).digest('hex'),content,availableTopics:Object.keys(catalog.topics),enforcement:'Pi invocation checks only; host compliance is not attested',primaryPolicy};
}
export function registerHostWorkflow(server,{receipts,onRead,openItems,installationIntegrity}={}){
  server.registerTool('get_workflow',{
    description:'Read a YHWH policy topic on its trigger. A gateway may return a short-lived workflowReceipt for topic-gated tools. No model call or file-path access.',
    inputSchema:{topic:z.enum(Object.keys(catalog.topics)).default('primary'),includeOpenItems:z.boolean().optional(),limit:z.number().int().min(1).max(100).optional(),cursor:z.object({snapshotSha256:z.string().regex(/^[a-f0-9]{64}$/),lastKey:z.string().max(160)}).strict().optional(),legacyCursor:z.string().regex(/^[a-f0-9]{64}$/).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async({topic,includeOpenItems,limit,cursor,legacyCursor})=>{
    const result=workflowTopic(topic);
    if(installationIntegrity) { result.installationIntegrity=installationIntegrity; if(installationIntegrity.code) result.code=installationIntegrity.code; }
    if(receipts) Object.assign(result,receipts.issue(topic,result.sha256));
    if(includeOpenItems&&openItems)result.openItems=await openItems({limit,cursor,legacyCursor});
    onRead?.(topic,result.sha256);
    return {content:[{type:'text',text:JSON.stringify(result)}]};
  });
}
