import {z} from 'zod';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {EditorBridge,readConfig} from '../pi-extensions/editor-common/runtime.mjs';
import {UnityBridge,operations as unityOperations} from '../pi-extensions/unity/index.mjs';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const sceneSchema=z.object({name:z.string().min(1).max(256),path:z.string().max(4096)}).strict();
export const editorAuthorizationSchema=z.object({version:z.literal(1),expiresAt:z.string().datetime(),operations:z.array(z.object({id,editor:z.enum(['unity','blender']),tool:z.string().min(1).max(128),args:z.record(z.string(),z.unknown()),scene:sceneSchema.optional()}).strict()).min(1).max(16)}).strict();
const blenderTools={blender_scene_info:'read',blender_create_object:'write',blender_set_transform:'write',blender_delete_object:'write',blender_set_material:'write',blender_save_copy:'write',blender_export_glb:'write'};
export const EDITOR_POLICY={version:1,authorization:'Tifereth via authenticated MCP',field:'editorAuthorization',transport:'per-task stdio/IPC',tool:'pi_editor_execute',maxOperations:16,maxValiditySeconds:900,exactArguments:true,credentials:'host-only',writesRequireScene:true,rollback:false};
function reject(code){throw Object.assign(new Error(code),{code});}
function digest(v){return createHash('sha256').update(JSON.stringify(v)).digest('hex');}
export function authorizeEditors(value,{requestId,parentRunId,provider,role,ledgerEnabled,now=Date.now()}={}){
 if(value===undefined)return null;
 const grant=editorAuthorizationSchema.parse(value);
 if(!requestId||!parentRunId||!ledgerEnabled)reject('EDITOR_TRACE_AND_LEDGER_REQUIRED');
 if(provider!=='openai-codex'||!['Chesed','Malkuth','Netzach'].includes(role))reject('EDITOR_ROLE_FORBIDDEN');
 const deadline=Date.parse(grant.expiresAt);
 if(deadline<=now||deadline>now+900000)reject('EDITOR_GRANT_EXPIRED_OR_TOO_LONG');
 if(Buffer.byteLength(JSON.stringify(grant))>32768)reject('EDITOR_GRANT_TOO_LARGE');
 const ids=new Set();
 for(const op of grant.operations){
  if(ids.has(op.id))reject('EDITOR_DUPLICATE_OPERATION');ids.add(op.id);
  const access=op.editor==='unity'?unityOperations[op.tool]?.access:blenderTools[op.tool];
  if(!access||Object.hasOwn(op.args,'_piScene'))reject('EDITOR_TOOL_FORBIDDEN');
  if(access==='write'&&(role!=='Chesed'||!op.scene))reject('EDITOR_WRITE_SCENE_REQUIRED');
  if(Buffer.byteLength(JSON.stringify(op.args))>8192)reject('EDITOR_ARGUMENTS_TOO_LARGE');
 }
 return grant;
}
export function createEditorBroker(grant,{requestId,parentRunId,signal,audit,now=Date.now,stateDir=join(homedir(),'.local','state','pi-editors'),bridgeFactory=(editor)=>editor==='unity'?new UnityBridge({stateDir}):new EditorBridge(editor,{stateDir}),configReader=readConfig}={}){
 grant=structuredClone(grant);
 const deadline=Date.parse(grant.expiresAt),controller=new AbortController(),records=[],memo=new Map(),configs=new Map();
 let closed=false,busy=false,frames=0,rejected=0;const pending=new Set();
 if(now()>=deadline||signal?.aborted)reject('EDITOR_GRANT_REVOKED');
 for(const op of grant.operations){
  const c=configReader(op.editor);
  const access=op.editor==='unity'?unityOperations[op.tool]?.access:blenderTools[op.tool];
  if(!c?.enabled||c.tools[op.tool]!==access||access==='write'&&!c.allowWrites)reject('EDITOR_HOST_POLICY_DENIED');
  configs.set(op.editor,digest(c));
 }
 const abort=()=>{closed=true;controller.abort();};
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(abort,Math.max(1,deadline-now()));timer.unref?.();
 const emit=(op,outcome,durationMs)=>{
  const record={operationId:op.id,editor:op.editor,tool:op.tool,outcome,durationMs};records.push(record);
  audit?.record({auditVersion:1,timestamp:new Date().toISOString(),requestId,parentRunId,operation:'editor_operation',...record});
 };
 const execute=async(message)=>{
  if(++frames>32)reject('EDITOR_CALL_LIMIT');
  if(closed||signal?.aborted||now()>=deadline)reject('EDITOR_GRANT_REVOKED');
  if(!message||Object.keys(message).length!==1||typeof message.operationId!=='string')reject('EDITOR_INVALID_FRAME');
  const op=grant.operations.find(o=>o.id===message.operationId);if(!op)reject('EDITOR_OPERATION_DENIED');
  if(memo.has(op.id))return structuredClone(memo.get(op.id));
  if(busy)reject('EDITOR_BUSY');
  if(configs.get(op.editor)!==digest(configReader(op.editor)))reject('EDITOR_CONFIG_CHANGED');
  busy=true;const started=now();
  const write=(op.editor==='unity'?unityOperations[op.tool]?.access:blenderTools[op.tool])==='write';
  const operationRequestId='editor-'+digest([requestId,op.id]);
  const fence=join(stateDir,op.editor,'gateway-write-fence.json');let owned=false,invoked=false;
  try{
   if(write){
    mkdirSync(join(stateDir,op.editor),{recursive:true});
    try{writeFileSync(fence,JSON.stringify({requestId,operationId:op.id,operationRequestId,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});owned=true;}
    catch(error){if(error.code==='EEXIST')reject('EDITOR_RECONCILIATION_REQUIRED');throw error;}
   }
   if(closed||now()>=deadline)reject('EDITOR_GRANT_REVOKED');
   const args=write?{...structuredClone(op.args),_piScene:structuredClone(op.scene)}:structuredClone(op.args);
   invoked=true;
   const result=await bridgeFactory(op.editor).invoke('call',{tool:op.tool,args,requestId:operationRequestId},controller.signal);
   if(Buffer.byteLength(JSON.stringify(result))>262144)reject('EDITOR_OUTPUT_LIMIT');
   let ok=result.ok===true&&result.result?.isError!==true;
   if(ok&&op.editor==='unity'){
    try{const payload=result.result.structuredContent??JSON.parse(result.result.content.find(c=>c.type==='text').text);ok=payload.success===true;}catch{ok=false;}
   }
   if(write&&ok){unlinkSync(fence);owned=false;}
   const value={...result,ok,operationId:op.id,boundary:'host-editor; no sandbox rollback'};
   memo.set(op.id,value);emit(op,ok?'completed':write?'uncertain':'failed',now()-started);return structuredClone(value);
  }catch(error){
   // A crash or uncertain call leaves a durable write fence; reads remain available for reconciliation.
   if(owned&&(!invoked||error.code==='EDITOR_CONNECTION_FAILED')){unlinkSync(fence);owned=false;}
   const value={ok:false,operationId:op.id,code:error.code||'EDITOR_OPERATION_FAILED',uncertain:write&&owned};
   memo.set(op.id,value);emit(op,value.uncertain?'uncertain':'failed',now()-started);return value;
  }finally{busy=false;}
 };
 return {
  catalog:structuredClone(grant.operations),
  invoke(message){const work=execute(message).catch(error=>{rejected++;audit?.record({auditVersion:1,timestamp:new Date().toISOString(),requestId,parentRunId,operation:'editor_operation_rejected',outcome:'rejected',code:error.code||'EDITOR_REJECTED'});throw error;});pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work;},
  report(){return {authorized:true,rollback:false,operations:structuredClone(records),rejected,ok:rejected===0&&records.every(r=>r.outcome==='completed')};},
  async close(){abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);await Promise.allSettled([...pending]);},
 };
}
