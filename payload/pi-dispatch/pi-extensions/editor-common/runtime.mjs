import {readFileSync,existsSync,mkdirSync,appendFileSync,statSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join,basename} from 'node:path';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
import {z} from 'zod';
import {createRequestLedger} from '../../extensions/request-ledger.js';
import {redactSensitiveText} from '../../extensions/audit-log.js';

const absolute=z.string().max(4096).refine(isAbsolute,'Absolute path required');
const configSchema=z.object({
 version:z.literal(1),enabled:z.boolean(),allowWrites:z.boolean().default(false),assetRoot:z.string().max(1024).optional(),
 timeoutMs:z.number().int().min(1000).max(120000).default(30000),
 maxInputBytes:z.number().int().min(1024).max(262144).default(65536),
 maxOutputBytes:z.number().int().min(1024).max(8388608).default(2097152),
 transport:z.discriminatedUnion('type',[
  z.object({type:z.literal('stdio'),command:absolute,args:z.array(z.string().max(8192)).max(32).default([]),cwd:absolute}).strict(),
  z.object({type:z.literal('http'),url:z.string().max(2048),tokenFile:absolute.optional()}).strict()
 ]),
 tools:z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),z.enum(['read','write'])),
}).strict();
export function configPath(editor,env=process.env){
 if(!['unity','blender'].includes(editor))throw new Error('Invalid editor');
 const path=env['PI_'+editor.toUpperCase()+'_CONFIG']||join(homedir(),'.pi','agent','editors',editor+'.json');
 if(!isAbsolute(path))throw new Error('Config path must be absolute');
 return path;
}
export function validateConfig(value){
 const c=configSchema.parse(value);
 if(Object.keys(c.tools).length>64)throw new Error('Too many configured tools');
 if(c.transport.type==='http'){
  const u=new URL(c.transport.url);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw new Error('Only exact loopback HTTP without URL credentials is supported');
 } else {
  if(/\.(cmd|bat|ps1)$/i.test(c.transport.command)||/^(cmd|powershell|pwsh|wscript|cscript)(\.exe)?$/i.test(basename(c.transport.command)))throw new Error('Shell wrappers are not supported');
 }
 for(const name of ['Unity_RunCommand','Unity_AssetGeneration_GenerateAsset','blender_create_object','blender_set_transform','blender_delete_object','blender_set_material','blender_save_copy','blender_export_glb']){
  if(c.tools[name]==='read')throw new Error('Known mutation tool cannot be classified read-only');
 }
 return c;
}
export function readConfig(editor,path=configPath(editor)){
 if(!existsSync(path))return null;
 const data=readFileSync(path,'utf8');
 if(Buffer.byteLength(data)>65536)throw new Error('Configuration exceeds size limit');
 return validateConfig(JSON.parse(data.replace(/^\uFEFF/,'')));
}
function safeResult(value,secrets=[]){
 let text=JSON.stringify(value);
 for(const secret of secrets)if(secret)text=text.split(secret).join('[REDACTED]');
 return JSON.parse(redactSensitiveText(text,{compact:false}));
}
export class EditorBridge {
 constructor(editor,{path, stateDir=join(homedir(),'.local','state','pi-editors'),env=process.env}={}){
  this.editor=editor;this.path=path||configPath(editor,env);this.stateDir=stateDir;this.busy=false;this.ledger=null;
 }
 async invoke(action,{tool,args={},requestId}={},signal){
  const c=readConfig(this.editor,this.path);
  if(!c||!c.enabled)return {ok:false,status:c?'disabled':'not-configured',editor:this.editor};
  if(!['status','tools','call'].includes(action))throw new Error('Unknown operation');
  if(this.busy)throw new Error('Editor connection is busy; wait for the current operation');
  if(action==='call'){
   if(!Object.hasOwn(c.tools,tool))throw new Error('Tool is not in the editor allowlist');
   if(c.tools[tool]==='write'&&!c.allowWrites)throw new Error('Editor writes are disabled');
   if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments must be an object');
   if(Buffer.byteLength(JSON.stringify(args))>c.maxInputBytes)throw new Error('Tool input exceeds configured limit');
  }
  if(signal?.aborted)throw new Error('Operation cancelled');
  this.busy=true;
  try{
   const execute=()=>this.request(c,action,{tool,args},signal);
   if(action==='call'&&c.tools[tool]==='write'){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId))throw new Error('A stable requestId is required for editor writes; never mint a new ID to retry an uncertain write');
    this.ledger??=createRequestLedger(join(this.stateDir,this.editor,'requests'));
    const audit=(outcome)=>{const dir=join(this.stateDir,this.editor);mkdirSync(dir,{recursive:true});const path=join(dir,'audit.jsonl');if(existsSync(path)&&statSync(path).size>1048576){if(existsSync(path+'.1')){ /* rename replaces on supported host */ }renameSync(path,path+'.1');}appendFileSync(path,JSON.stringify({timestamp:new Date().toISOString(),requestId,tool,outcome})+'\n',{mode:0o600});};
    audit('started');
    try{const r=await this.ledger.execute({requestId,operation:this.editor+':editor-write',input:{tool,args,transport:c.transport,assetRoot:c.assetRoot}},execute);audit(r.disposition);return {...r.value,requestId,idempotency:r.disposition};}
    catch(error){audit('failed-or-uncertain');throw error;}
   }
   return await execute();
  }finally{this.busy=false;}
 }
 async request(c,action,{tool,args},signal){
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)controller.abort();
  const client=new Client({name:'pi-'+this.editor+'-bridge',version:'1.0.0'});
  let transport,timer;
  const secrets=[];
  let dispatched=false;
  try{
   if(c.transport.type==='stdio'){
    transport=new StdioClientTransport({...c.transport,stderr:'ignore',maxBufferSize:c.maxOutputBytes});
   }else{
    const token=c.transport.tokenFile?readFileSync(c.transport.tokenFile,'utf8').trim():null;
    if(token&&(!/^[A-Za-z0-9_-]{24,256}$/.test(token)))throw new Error('Invalid local bridge token');
    if(token)secrets.push(token);
    const endpoint=new URL(c.transport.url).href;
    const boundedFetch=async(url,init={})=>{
     if(new URL(url).href!==endpoint)throw new Error('Endpoint change rejected');
     const response=await fetch(url,{...init,redirect:'error',signal:controller.signal});
     if(!response.body)return response;
     let bytes=0;
     const stream=response.body.pipeThrough(new TransformStream({transform(chunk,ctl){bytes+=chunk.byteLength;if(bytes>c.maxOutputBytes){controller.abort();throw new Error('Transport output limit exceeded');}ctl.enqueue(chunk);}}));
     return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
    };
    transport=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:token?{Authorization:'Bearer '+token}:{},redirect:'error'},fetch:boundedFetch,reconnectionOptions:{maxRetries:0}});
   }
   const work=async()=>{
    await client.connect(transport);
    const catalog=[];let cursor;
    for(let page=0;page<8;page++){
     const result=await client.listTools(cursor?{cursor}:{},{signal:controller.signal,timeout:c.timeoutMs});
     catalog.push(...result.tools);cursor=result.nextCursor;
     if(catalog.length>256)throw new Error('Remote tool catalog too large');
     if(!cursor)break;
    }
    if(cursor)throw new Error('Remote tool pagination limit exceeded');
    const allowed=catalog.filter(t=>Object.hasOwn(c.tools,t.name));
    if(action==='status')return {ok:true,status:'connected',editor:this.editor,allowWrites:c.allowWrites,availableTools:allowed.map(t=>t.name),missingTools:Object.keys(c.tools).filter(n=>!catalog.some(t=>t.name===n)),boundary:'host-editor; not WSL sandbox'};
    if(action==='tools')return {ok:true,editor:this.editor,tools:allowed.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,access:c.tools[t.name]}))};
    const selected=allowed.find(t=>t.name===tool);
    if(!selected)throw new Error('Configured tool is unavailable on this editor');
    const validated=new AjvJsonSchemaValidator().getValidator(selected.inputSchema)(args);
    if(!validated.valid)throw new Error('Tool arguments do not match remote schema');
    if(controller.signal.aborted)throw new Error('Operation cancelled');
    dispatched=true;
    const result=await client.callTool({name:tool,arguments:args},undefined,{signal:controller.signal,timeout:c.timeoutMs,maxTotalTimeout:c.timeoutMs});
    return {ok:!result.isError,editor:this.editor,tool,result};
   };
   const cancelled=new Promise((_,reject)=>{
    const stop=()=>reject(new Error('Editor operation cancelled or timed out'));
    controller.signal.addEventListener('abort',stop,{once:true});
    if(controller.signal.aborted)stop();
    timer=setTimeout(abort,c.timeoutMs);
   });
   const result=await Promise.race([work(),cancelled]);
   if(Buffer.byteLength(JSON.stringify(result))>c.maxOutputBytes)throw new Error('Tool output exceeds configured limit');
   return safeResult(result,secrets);
  }catch(error){
   // Never forward raw server stderr or transport errors, which may include secrets.
   const e=new Error(dispatched?'Editor call failed or response lost; side effects may have occurred. Reconcile the same requestId before any retry.':'Editor connection, catalog or parameter validation failed.');
   e.code=dispatched?'EDITOR_RESULT_UNCERTAIN':'EDITOR_CONNECTION_FAILED';
   throw e;
  }finally{
   clearTimeout(timer);signal?.removeEventListener('abort',abort);
   await client.close().catch(()=>{});
   await transport?.close().catch(()=>{});
  }
 }
}
export function registerEditor(pi,editor,Bridge=EditorBridge){
 const bridge=Bridge===EditorBridge?new Bridge(editor):new Bridge();
 const object={type:'object',properties:{},additionalProperties:false};
 for(const action of ['status','tools','call']){
  pi.registerTool({
   name:'pi_'+editor+'_'+action,label:editor+' '+action,
   description:action==='call'?'Call an explicitly configured '+editor+' MCP tool. Writes affect the real editor, require allowWrites and a stable requestId. Never retry an uncertain write with a new ID.':'Read '+editor+' connection '+action+'. Does not dispatch a model.',
   parameters:action==='call'?{type:'object',properties:{tool:{type:'string',maxLength:128},args:{type:'object',additionalProperties:true},requestId:{type:'string',maxLength:128}},required:['tool','args'],additionalProperties:false}:object,
   async execute(_id,params,signal){
    try{const result=await bridge.invoke(action,params,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}
    catch(error){const result={ok:false,editor,code:error.code||'EDITOR_REJECTED',message:error.code?error.message:'Editor operation rejected; check trusted local configuration, permissions and requestId.'};return {content:[{type:'text',text:JSON.stringify(result)}],details:result,isError:true};}
   },
  });
 }
 pi.registerCommand('pi-'+editor,{description:'Show '+editor+' bridge status',handler:async(_args,ctx)=>{
  try{const r=await bridge.invoke('status');ctx.ui.notify(editor+': '+(r.status||'unknown'),r.ok?'info':'warning');}catch{ctx.ui.notify(editor+': connection failed','error');}
 }});
}
