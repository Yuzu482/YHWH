// Explicit opt-in, read-only real WSL -> host editor verification. Never edits scenes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if(!process.env.PI_GATEWAY_CONFIG||!process.env.PI_EDITOR_LIVE_REPORT)throw Error('Set PI_GATEWAY_CONFIG and PI_EDITOR_LIVE_REPORT explicitly');
const config=JSON.parse(readFileSync(process.env.PI_GATEWAY_CONFIG,'utf8'));
const token=readFileSync(config.tokenFile,'utf8').trim();
const client=new Client({name:'pi-editor-authorized-live-check',version:'1'});
const transport=new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token}}});
const report={startedAt:new Date().toISOString(),checks:[]};
const parse=r=>r.structuredContent??JSON.parse(r.content[0].text);
const call=async(name,args)=>parse(await client.callTool({name,arguments:args},undefined,{timeout:30000}));
try{
 await client.connect(transport);
 const caps=await call('list_capabilities',{});assert.equal(caps.editors?.field,'editorAuthorization');assert.equal(caps.sandbox.ok,true);report.capabilities={editors:caps.editors,sandbox:caps.sandbox};
 const suffix=Date.now();
 const common={cwd:resolve('.'),provider:'openai-codex',model:'gpt-5.6-luna',thinking:'max',resourceProfile:'standard',access:'none',timeoutSeconds:240,queueTimeoutSeconds:120,parentRunId:'editor-live-'+suffix};
 const task={role:'Malkuth',objective:'Read only. Execute each of the two host-authorized operation IDs blender-scene and unity-scene exactly once via pi_editor_execute. Report actual observed editor versions, current scene names, and object information, distinguishing Unity and Blender. Never claim success on a tool error. Return the required typed Malkuth result with observations, sources and limitations. Do not modify scenes, assets or files. Do not delegate.',acceptance:['Both authorized editor calls return successful real scene information; cite concrete observed data.','No writes or unsupported tool calls; return the exact role JSON contract.']};
 const authorization={version:1,expiresAt:new Date(Date.now()+600000).toISOString(),operations:[{id:'blender-scene',editor:'blender',tool:'blender_scene_info',args:{}},{id:'unity-scene',editor:'unity',tool:'unity_scene_info',args:{}}]};
 const expired=await call('dispatch_subagent',{...common,requestId:'editor-expired-'+suffix,task,editorAuthorization:{...authorization,expiresAt:new Date(Date.now()-1000).toISOString()}});
 assert.equal(expired.ok,false);assert.equal(expired.code,'EDITOR_GRANT_EXPIRED_OR_TOO_LONG');report.checks.push('expired authorization rejected before dispatch');
 const wrongRole=await call('dispatch_subagent',{...common,requestId:'editor-role-denied-'+suffix,task:{...task,role:'Hod'},editorAuthorization:authorization});
 assert.equal(wrongRole.ok,false);assert.equal(wrongRole.code,'EDITOR_ROLE_FORBIDDEN');report.checks.push('unadmitted role rejected before dispatch');
 const input={...common,requestId:'editor-read-'+suffix,task,editorAuthorization:authorization};report.requestId=input.requestId;
 const submitted=await call('submit_subagent',input);assert.equal(submitted.accepted,true);report.submitted=submitted;
 console.log(JSON.stringify({submitted:input.requestId}));
 let final,lastState;
 for(let i=0;i<80;i++){
  await new Promise(r=>setTimeout(r,5000));
  const current=await call('get_subagent_status',{requestId:input.requestId});
  if(current.task.state!==lastState){lastState=current.task.state;console.log(JSON.stringify({state:lastState}));}
  if(['completed','failed','cancelled','timed_out'].includes(lastState)){
   final=await call('get_subagent_result',{requestId:input.requestId,limit:65536});break;
  }
 }
 assert.equal(final?.ready,true);assert.equal(final.nextOffset,null);report.final=final;
 assert.equal(final.result.ok,true,JSON.stringify(final.result));
 assert.equal(final.result.formatValidation.ok,true);assert.equal(final.result.cleanup.ok,true);
 const ops=final.result.editorExecution.operations;assert.equal(ops.length,2);assert.ok(ops.every(o=>o.outcome==='completed'));assert.ok(final.result.toolsUsed.includes('pi_editor_execute'));
 report.checks.push('actual WSL worker read Blender and Unity through the bounded IPC bridge','typed output and WSL cleanup passed');
 const replay=await call('dispatch_subagent',input);assert.equal(replay.idempotency.status,'replayed');assert.deepEqual(replay.editorExecution,final.result.editorExecution);report.replay=replay.idempotency;report.checks.push('same parent request replay returned existing result');
 report.ok=true;
}catch(error){report.ok=false;report.error=error.message;process.exitCode=1;}
finally{writeFileSync(process.env.PI_EDITOR_LIVE_REPORT,JSON.stringify(report,null,2));await client.close();console.log(JSON.stringify({ok:report.ok,checks:report.checks,error:report.error}));}
