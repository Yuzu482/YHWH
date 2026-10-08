import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planCooperativeRun } from './cooperative-run.mjs';
import { validateKetherInvocation } from './dispatch.mjs';
import { inspectPrimaryPacket, runtimePreflight } from './runtime-preflight.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function options(env = process.env) {
  if (!env.PI_GATEWAY_CONFIG) throw new Error('PI_GATEWAY_CONFIG is required');
  const config = JSON.parse(readFileSync(resolve(env.PI_GATEWAY_CONFIG), 'utf8').replace(/^\uFEFF/, ''));
  const token = readFileSync(resolve(env.PI_GATEWAY_TOKEN_FILE || config.tokenFile), 'utf8').trim();
  return { url: `http://${config.host ?? '127.0.0.1'}:${config.port ?? 7331}/mcp`, token };
}

async function withWriteReceipt(client,requests){
  const needsReceipt=request=>request.access==='workspace-write'&&request.tier!=='T0'&&request.tier!=='T1';
  if(!requests.some(needsReceipt))return requests;
  const response=await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}});
  if(response.isError)throw new Error('Cannot retrieve task-tiers workflow topic');
  const receipt=JSON.parse(response.content?.find(item=>item.type==='text')?.text??'{}').receipt;
  if(typeof receipt!=='string'||!receipt)throw new Error('Gateway did not issue a workflow receipt');
  return requests.map(request=>needsReceipt(request)?{...request,workflowReceipt:receipt}:request);
}
function isTopicRequired(response){
  const text=response?.content?.find(item=>item.type==='text')?.text;
  let value=response?.structuredContent;
  try{if(text)value=JSON.parse(text);}catch{return false;}
  return response?.isError===true&&(value?.code==='WORKFLOW_TOPIC_REQUIRED'||value?.error?.code==='WORKFLOW_TOPIC_REQUIRED'||value?.error==='WORKFLOW_TOPIC_REQUIRED');
}

export function parseProbeArgs(args) {
  const positional = [];
  let recovery = false;
  for (const arg of args) {
    if (arg === '--recovery') {
      if (recovery) throw new Error('Duplicate --recovery flag');
      recovery = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown probe flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length < 2 || positional.length > 3) throw new Error('Invalid probe arguments');
  return { provider: positional[0], model: positional[1], resourceProfile: positional[2] ?? 'standard', recovery };
}

async function main(args) {
  const command = args.shift();
  if (command === 'task-plan') {
    if (args.length !== 1) throw new Error('Usage: gateway-client.mjs task-plan <request.json>');
    const value = JSON.parse(readFileSync(resolve(args[0]), 'utf8').replace(/^\uFEFF/, ''));
    const packetCheck = inspectPrimaryPacket(value?.task);
    if (!packetCheck.ok) return {ok: false, modelCalls: 0, readOnly: true, packetCheck};
    const {request, task} = validateKetherInvocation({
      cwd: value.cwd, access: value.access, provider: value.provider, model: value.model,
      thinking: value.thinking, timeoutSeconds: value.timeoutSeconds, resourceProfile: value.resourceProfile, task: value.task,
    }, value.access === 'workspace-write', value.cwd);
    return {ok: true, modelCalls: 0, readOnly: true, thinkingDecision: request.thinkingDecision,
      packetCheck, preflight: runtimePreflight(task), request: {...value, thinking: request.thinking, task}};
  }
  if ((command === 'cooperative-plan' || command === 'cooperative-submit') && args.length === 1) {
    const spec = JSON.parse(readFileSync(resolve(args[0]), 'utf8').replace(/^\uFEFF/, ''));
    const plan = planCooperativeRun(spec);
    if (command === 'cooperative-plan') return { ok: true, runAnchor: plan.runAnchor, thinking: plan.thinking, requests: plan.requests.map((request, index) => ({ requestId: request.requestId, unitId: spec.units[index].id, readScope: request.task.readScope, writeScope: request.task.writeScope })) };
    const { url, token } = options();
    const client = new Client({ name: 'pi-kether-gateway-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    try {
      await client.connect(transport);
      const requests=await withWriteReceipt(client,plan.requests);
      const settled = await Promise.allSettled(requests.map(request => client.callTool({ name: 'submit_subagent', arguments: request }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 })));
      const receipts = settled.map((result, index) => {
        const request = plan.requests[index];
        const unitId = spec.units[index].id;
        if (result.status === 'rejected') return { requestId: request.requestId, unitId, status: 'error', error: 'submission failed or outcome uncertain' };
        const response = result.value;
        const text = response?.content?.find(item => item.type === 'text')?.text;
        let value;
        try { value = text ? JSON.parse(text) : response?.structuredContent; } catch { value = null; }
        const failed = response?.isError === true || value == null || typeof value !== 'object' || value.ok !== true || value.task?.requestId !== request.requestId;
        return { requestId: request.requestId, unitId, status: failed ? 'error' : 'accepted', ...(failed ? { error: 'submission failed or outcome uncertain' } : {}) };
      });
      return { ok: receipts.every(receipt => receipt.status === 'accepted'), runAnchor: plan.runAnchor, receipts };
    } finally { await client.close().catch(() => {}); }
  }
  const { url, token } = options();
  const client = new Client({ name: 'pi-kether-gateway-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  let stage = 'connect';
  try {
    await client.connect(transport);
    stage = command || 'command';
    if (command === 'capabilities' && args.length === 0) return await client.callTool({ name: 'list_capabilities', arguments: {} });
    if (command === 'dispatch' && args.length === 1) {
      const request = JSON.parse(readFileSync(resolve(args[0]), 'utf8').replace(/^\uFEFF/, ''));
      const [prepared]=await withWriteReceipt(client,[request]);
      return await client.callTool({ name: 'dispatch_subagent', arguments: prepared }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    if (command === 'record-host-verification' && args.length === 1) {
      const submission=JSON.parse(readFileSync(resolve(args[0]),'utf8').replace(/^\uFEFF/,''));
      const submit=argumentsValue=>client.callTool({name:'record_host_verification',arguments:argumentsValue},undefined,{timeout:30000,maxTotalTimeout:30000});
      let response=await submit(submission);
      if(isTopicRequired(response)){
        const [prepared]=await withWriteReceipt(client,[{access:'workspace-write'}]);
        response=await submit({...submission,workflowReceipt:prepared.workflowReceipt});
      }
      return response;
    }
    if (command === 'apply-artifact' && args.length === 1) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args[0])) throw new Error('Invalid requestId');
      return await client.callTool({name:'apply_artifact',arguments:{requestId:args[0]}},undefined,{timeout:30000,maxTotalTimeout:30000});
    }
    if (command === 'host-pending' && args.length === 0) {
      return await client.callTool({name:'list_host_verification_pending',arguments:{}},undefined,{timeout:30000,maxTotalTimeout:30000});
    }
    if ((command === 'handoff' || command === 'wait-handoff') && args.length === 1) {
      const request=JSON.parse(readFileSync(resolve(args[0]),'utf8').replace(/^\uFEFF/,''));
      const allowed=command==='handoff'?['requestId','artifactSha256']:['requestId','artifactSha256','afterRevision','timeoutMs'];
      if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!allowed.includes(key))||typeof request.requestId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)||request.artifactSha256!==undefined&&!/^[a-f0-9]{64}$/.test(request.artifactSha256)||request.afterRevision!==undefined&&!/^[a-f0-9]{64}$/.test(request.afterRevision))throw new Error(`${command} request is invalid`);
      if(command==='wait-handoff'&&request.timeoutMs!==undefined&&(!Number.isInteger(request.timeoutMs)||request.timeoutMs<0||request.timeoutMs>55000))throw new Error('timeoutMs must be an integer from 0 to 55000');
      return await client.callTool({name:command==='handoff'?'get_task_handoff':'wait_task_handoff',arguments:{...request,...(command==='wait-handoff'?{timeoutMs:request.timeoutMs??55000}:{})}},undefined,{timeout:60000,maxTotalTimeout:60000});
    }
    if (command === 'wait' && args.length === 1) {
      const request=JSON.parse(readFileSync(resolve(args[0]),'utf8').replace(/^\uFEFF/,''));
      if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['requestId','timeoutMs'].includes(key))||typeof request.requestId!=='string') throw new Error('wait request must contain requestId and optional timeoutMs only');
      const timeoutMs=request.timeoutMs??55000;
      if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>55000) throw new Error('timeoutMs must be an integer from 0 to 55000');
      return await client.callTool({name:'wait_subagent',arguments:{requestId:request.requestId,timeoutMs}},undefined,{timeout:60000,maxTotalTimeout:60000});
    }
    if (command === 'probe') {
      const probe = parseProbeArgs(args);
      return await client.callTool({ name: 'probe_model', arguments: { provider: probe.provider, model: probe.model, cwd: process.cwd(), resourceProfile: probe.resourceProfile, ...(probe.recovery ? { recovery: true } : {}), timeoutSeconds: 180, requestId: `probe-${Date.now()}` } }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    if (command === 'lsp' && args.length >= 3 && args.length <= 4) {
      return await client.callTool({ name: 'lsp_request', arguments: { provider: args[0], model: args[1], cwd: process.cwd(), timeoutSeconds: 180, method: args[2], file: args[3] ?? 'scripts/gateway.mjs', requestId: `lsp-${Date.now()}` } }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    throw new Error('Usage: gateway-client.mjs capabilities | dispatch <request.json> | record-host-verification <evidence.json> | apply-artifact <requestId> | host-pending | handoff <request.json> | wait-handoff <request.json> | wait <request.json> | probe <provider> <model> [small|standard|large] [--recovery] | lsp <provider> <model> <method> [file] | cooperative-plan <spec.json> | cooperative-submit <spec.json>');
  } catch (error) {
    error.message = `${stage}: ${error.message}`;
    throw error;
  } finally { await client.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(result => {
    const value = result.content?.[0]?.type === 'text' ? JSON.parse(result.content[0].text) : result;
    console.log(JSON.stringify(value, null, 2));
    const expectedHostPending = value.status === 'awaiting-host-verification' && result.isError !== true;
    process.exitCode = result.isError || (value.ok === false && !expectedHostPending) ? 1 : 0;
  }).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
