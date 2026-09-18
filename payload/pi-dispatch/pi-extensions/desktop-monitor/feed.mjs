import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readProxyConfig} from '../../scripts/stdio-proxy.mjs';
import {once} from 'node:events';
export function describePet(snapshot){
  if(!snapshot?.ok)return {state:'offline',label:'连接中断',detail:'自动重连中',accent:'#E4BD7B',count:'?'};
  const failed=snapshot.tasks.filter(t=>['failed','blocked'].includes(t.state)).length;
  const detail=failed?`近期失败 ${failed} · 点击查看`:'点击查看任务';
  if(snapshot.active>0)return {state:'running',label:`执行中 ${snapshot.active}`,detail:snapshot.queued?`排队 ${snapshot.queued} · ${detail}`:detail,accent:'#83DFCB',count:String(snapshot.active)};
  if(snapshot.queued>0)return {state:'waiting',label:`排队中 ${snapshot.queued}`,detail,accent:'#E4BD7B',count:String(snapshot.queued)};
  if(failed)return {state:'failed',label:'近期有失败',detail:'点击查看记录',accent:'#FF949D',count:'!'};
  return {state:'idle',label:'Pi 已就绪',detail:'暂无进行中的任务',accent:'#B7C6DE',count:'0'};
}
export function projectSnapshot(data){
  if(data?.ok!==true||!data.gateway||!Array.isArray(data.tasks))throw new Error('Invalid monitor snapshot');
  const text=value=>String(value??'').slice(0,160);
  const snapshot={ok:true,instance:text(data.gateway.instanceId),active:Number(data.gateway.active)||0,queued:Number(data.gateway.queued)||0,rssMiB:Number(data.gateway.gatewayRssMiB)||0,updatedAt:new Date().toISOString(),tasks:data.tasks.slice(0,50).map(t=>({requestId:text(t.requestId),role:text(t.role),state:text(t.state),route:text(`${t.actualProvider||t.requestedProvider||''}/${t.actualModel||t.requestedModel||''}`),seconds:Math.round((Number(t.elapsedMs)||0)/1000)}))};
  return {...snapshot,pet:describePet(snapshot)};
}
export async function runFeed(configPath,{onceOnly=false}={}){
  let client=null,delay=2000;
  const emit=async data=>{if(!process.stdout.write(JSON.stringify(data)+'\n'))await once(process.stdout,'drain');};
  process.stdout.on('error',()=>process.exit(0));
  do{
    try{
      if(!client){const {url,token}=readProxyConfig(configPath);client=new Client({name:'pi-desktop-monitor',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`},redirect:'error'}}),{timeout:5000});}
      const result=await client.callTool({name:'list_subagents',arguments:{limit:50}},undefined,{timeout:5000,maxTotalTimeout:5000});
      if(result.isError)throw new Error('Monitor unavailable');
      await emit(projectSnapshot(result.structuredContent));delay=2000;
    }catch{await client?.close().catch(()=>{});client=null;await emit({ok:false,message:'Gateway 暂不可用，正在重连'});delay=Math.min(delay*2,15000);}
    if(!onceOnly)await new Promise(r=>setTimeout(r,delay));
  }while(!onceOnly);
  await client?.close();
}
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runFeed(process.argv[2],{onceOnly:process.argv.includes('--once')});
