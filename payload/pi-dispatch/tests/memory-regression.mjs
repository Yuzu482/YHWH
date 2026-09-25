import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeHeapSnapshot } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayApp } from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';
import {roleValue} from './contract-fixtures.mjs';

if (typeof global.gc !== 'function') throw new Error('run with node --expose-gc');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = 'memory-regression-token-0123456789';
const ledgerDir = mkdtempSync(join(tmpdir(), 'pi-memory-regression-'));
const verifiedSandbox = { ok: true, backend: 'wsl2-bwrap', hostMountVisible: false, windowsInterop: false, bubblewrap: true, pi: true, resourceLimits: true };
const largeText = 'x'.repeat(256 * 1024);

function resultText(result = 'ok') {
  return `KETHER_RESULT_JSON=${JSON.stringify(roleValue('Chesed', result))}`;
}

let largeDispatches = 0;
const dispatchFn = async (request, signal, task) => {
  if (task.objective.startsWith('large')) largeDispatches += 1;
  if (task.objective.startsWith('delay')) {
    await new Promise((resolveDelay, rejectDelay) => {
      const timer = setTimeout(resolveDelay, 250);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        rejectDelay(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      }, { once: true });
    });
  }
  return { ok: true, text: resultText(task.objective.startsWith('large') ? largeText : 'ok'), provider: request.provider, model: request.model };
};

const { app } = createGatewayApp({
  host: '127.0.0.1', port: 0, roots: [root], token, dispatchFn,
  sandboxStatus: verifiedSandbox, requestLedgerDir: ledgerDir,
  schedulerOptions: { availableMemoryBytes: () => Number.MAX_SAFE_INTEGER, pollIntervalMs: 2 },
});
const http = await listenHttpFixture(app);
const port = http.address().port;
const client = new Client({ name: 'memory-regression', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

const collect = async () => {
  for (let i = 0; i < 3; i += 1) {
    global.gc();
    await new Promise(resolveTick => setImmediate(resolveTick));
  }
  const usage = process.memoryUsage();
  return { heapUsed: usage.heapUsed, rss: usage.rss, handles: process._getActiveHandles().length };
};

const taskArguments = objective => ({
  cwd: root, provider: 'openai-codex', model: 'gpt-6-luna', access: 'read', resourceProfile: 'small', timeoutSeconds: 30,
  task: { contractVersion: 2, role: 'Chesed', objective, readScope: ['package.json'], acceptance: ['Return the complete synthetic fixture result.'] },
});

function slopePerHundred(samples, field) {
  const recent = samples.slice(-3);
  const meanX = recent.reduce((sum, item) => sum + item.requests, 0) / recent.length;
  const meanY = recent.reduce((sum, item) => sum + item[field], 0) / recent.length;
  const numerator = recent.reduce((sum, item) => sum + (item.requests - meanX) * (item[field] - meanY), 0);
  const denominator = recent.reduce((sum, item) => sum + (item.requests - meanX) ** 2, 0);
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

async function abruptDisconnect(index) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: `disconnect-${index}`, method: 'tools/call', params: { name: 'dispatch_subagent', arguments: taskArguments(`delay disconnect ${index}`) } });
  await new Promise(resolveDisconnect => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body),
    } });
    req.on('error', () => resolveDisconnect());
    req.on('response', response => { response.resume(); response.on('end', resolveDisconnect); });
    req.end(body);
    setTimeout(() => { req.destroy(); resolveDisconnect(); }, 5);
  });
}

try {
  await client.connect(transport);
  for (let i = 0; i < 25; i += 1) await client.callTool({ name: 'list_capabilities', arguments: {} });
  const baseline = await collect();
  const samples = [{ requests: 0, ...baseline }];

  for (let i = 0; i < 400; i += 1) {
    await client.callTool({ name: 'list_capabilities', arguments: {} });
    if ((i + 1) % 100 === 0) samples.push({ requests: i + 1, ...await collect() });
  }
  const largeDurations = [];
  for (let i = 0; i < 40; i += 1) {
    const started = performance.now();
    const result = await client.callTool({ name: 'dispatch_subagent', arguments: taskArguments(`large ${i}`) });
    largeDurations.push(performance.now() - started);
    assert.equal(result.isError, false);
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.ok, true);
    assert.equal(response.roleValidation.ok, true);
    assert.equal(response.structuredResult.result, largeText, 'large results must not be truncated');
  }
  assert.equal(largeDispatches, 40, 'every large fixture must reach the dispatcher');
  let cancelled = 0;
  for (let i = 0; i < 40; i += 1) {
    const controller = new AbortController();
    const pending = client.callTool({ name: 'dispatch_subagent', arguments: taskArguments(`delay cancel ${i}`) }, undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    try { await pending; } catch { cancelled += 1; }
  }
  for (let i = 0; i < 40; i += 1) await abruptDisconnect(i);
  // Allow aborted HTTP sockets to pass Node's keep-alive cleanup window before measuring retained state.
  await new Promise(resolveDrain => setTimeout(resolveDrain, 6500));
  const final = await collect();
  const growth = { heapUsed: final.heapUsed - baseline.heapUsed, rss: final.rss - baseline.rss, handles: final.handles - baseline.handles };
  const trend = {
    heapBytesPerHundred: slopePerHundred(samples, 'heapUsed'),
    rssBytesPerHundred: slopePerHundred(samples, 'rss'),
    heapIncrements: samples.slice(1).map((sample, index) => sample.heapUsed - samples[index].heapUsed),
    rssIncrements: samples.slice(1).map((sample, index) => sample.rss - samples[index].rss),
  };
  assert.equal(cancelled, 40, 'all cancellation requests should abort');
  assert.ok(growth.heapUsed <= 20 * 1024 * 1024, `heap growth ${growth.heapUsed} exceeds 20 MiB`);
  assert.ok(growth.rss <= 96 * 1024 * 1024, `RSS growth ${growth.rss} exceeds 96 MiB`);
  assert.ok(growth.handles <= 8, `active handle growth ${growth.handles} exceeds 8`);
  assert.ok(trend.heapBytesPerHundred <= 4 * 1024 * 1024, `recent heap slope ${trend.heapBytesPerHundred} exceeds 4 MiB/100 requests`);
  console.log(JSON.stringify({ ok: true, requests: { warmup: 25, ordinary: 400, largeOutput: largeDispatches, cancelled, disconnected: 40 }, largeOutputMs: { max: Math.max(...largeDurations), mean: largeDurations.reduce((a, b) => a + b, 0) / largeDurations.length }, samples, baseline, final, growth, trend, thresholds: { heapUsed: 20 * 1024 * 1024, rss: 96 * 1024 * 1024, handles: 8, recentHeapPerHundred: 4 * 1024 * 1024 } }, null, 2));
} catch (error) {
  const snapshot = writeHeapSnapshot(join(tmpdir(), `pi-gateway-memory-failure-${Date.now()}.heapsnapshot`));
  console.error(JSON.stringify({ ok: false, error: error.message, heapSnapshot: snapshot }));
  throw error;
} finally {
  await client.close().catch(() => {});
  await new Promise(resolveClose => http.close(resolveClose));
  rmSync(ledgerDir, { recursive: true, force: true });
}
