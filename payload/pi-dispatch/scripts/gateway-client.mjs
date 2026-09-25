import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { planCooperativeRun } from './cooperative-run.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function options(env = process.env) {
  if (!env.PI_GATEWAY_CONFIG) throw new Error('PI_GATEWAY_CONFIG is required');
  const config = JSON.parse(readFileSync(resolve(env.PI_GATEWAY_CONFIG), 'utf8').replace(/^\uFEFF/, ''));
  const token = readFileSync(resolve(env.PI_GATEWAY_TOKEN_FILE || config.tokenFile), 'utf8').trim();
  return { url: `http://${config.host ?? '127.0.0.1'}:${config.port ?? 7331}/mcp`, token };
}

async function main(args) {
  const command = args.shift();
  if ((command === 'cooperative-plan' || command === 'cooperative-submit') && args.length === 1) {
    const spec = JSON.parse(readFileSync(resolve(args[0]), 'utf8').replace(/^\uFEFF/, ''));
    const plan = planCooperativeRun(spec);
    if (command === 'cooperative-plan') return { ok: true, runAnchor: plan.runAnchor, thinking: plan.thinking, requests: plan.requests.map((request, index) => ({ requestId: request.requestId, unitId: spec.units[index].id, readScope: request.task.readScope, writeScope: request.task.writeScope })) };
    const { url, token } = options();
    const client = new Client({ name: 'pi-kether-gateway-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    try {
      await client.connect(transport);
      const settled = await Promise.allSettled(plan.requests.map(request => client.callTool({ name: 'submit_subagent', arguments: request }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 })));
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
      return await client.callTool({ name: 'dispatch_subagent', arguments: request }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    if (command === 'probe' && args.length >= 2 && args.length <= 3) {
      return await client.callTool({ name: 'probe_model', arguments: { provider: args[0], model: args[1], cwd: process.cwd(), resourceProfile: args[2] ?? 'standard', timeoutSeconds: 180, requestId: `probe-${Date.now()}` } }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    if (command === 'lsp' && args.length >= 3 && args.length <= 4) {
      return await client.callTool({ name: 'lsp_request', arguments: { provider: args[0], model: args[1], cwd: process.cwd(), timeoutSeconds: 180, method: args[2], file: args[3] ?? 'scripts/gateway.mjs', requestId: `lsp-${Date.now()}` } }, undefined, { timeout: 1810000, maxTotalTimeout: 1810000 });
    }
    throw new Error('Usage: gateway-client.mjs capabilities | dispatch <request.json> | probe <provider> <model> [small|standard|large] | lsp <provider> <model> <method> [file] | cooperative-plan <spec.json> | cooperative-submit <spec.json>');
  } catch (error) {
    error.message = `${stage}: ${error.message}`;
    throw error;
  } finally { await client.close().catch(() => {}); }
}

main(process.argv.slice(2)).then(result => {
  const value = result.content?.[0]?.type === 'text' ? JSON.parse(result.content[0].text) : result;
  console.log(JSON.stringify(value, null, 2));
  process.exitCode = result.isError || value.ok === false ? 1 : 0;
}).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
