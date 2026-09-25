import { roleValue } from './contract-fixtures.mjs';
import { listenHttpFixture } from './http-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayApp } from '../scripts/gateway.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = 'test-token-0123456789-0123456789-abcdef';
const sandbox = { ok:true, backend:'wsl2-bwrap', hostMountVisible:false, windowsInterop:false, bubblewrap:true, pi:true, resourceLimits:true };
const prefix = 'KETHER_RESULT_JSON=';
const canonical = value => prefix + JSON.stringify(value);
const parse = result => JSON.parse(result.content[0].text);

async function withGateway(run, dispatchFn) {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'pi-result-submit-'));
  const { app } = createGatewayApp({
    host:'127.0.0.1', port:0, roots:[root], token, dispatchFn,
    sandboxStatus:sandbox, requestLedgerDir:ledgerDir,
    schedulerOptions:{ availableMemoryBytes:() => Number.MAX_SAFE_INTEGER, pollIntervalMs:5 },
  });
  const http = await listenHttpFixture(app);
  const client = new Client({ name:'result-submit-test', version:'1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), {
    requestInit:{ headers:{ Authorization:`Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
    await new Promise(resolvePromise => http.close(resolvePromise));
    rmSync(ledgerDir, { recursive:true, force:true });
  }
}

function task(requestId) {
  return { cwd:root, provider:'openai-codex', model:'gpt-6-luna', requestId, access:'read', resourceProfile:'small',
    task:{ role:'worker', objective:'Check structured result handling', acceptance:['Return the observed result'], readScope:['package.json'] } };
}

test('gateway treats structured result submission as authoritative and retains legacy fallback', async () => {
  let mode = 'valid';
  await withGateway(async client => {
    const call = async requestId => parse(await client.callTool({ name:'dispatch_subagent', arguments:task(requestId) }));
    const capabilities = parse(await client.callTool({ name:'list_capabilities', arguments:{} }));
    assert.equal(capabilities.resultFormat.tool, 'yhwh_submit_result');
    assert.deepEqual(capabilities.resultFormat.toolRequiredFor, ['WSL read and workspace-write Kether JSON tasks']);
    assert.equal(capabilities.resultFormat.toolEventSource, 'genuine tool event');
    assert.deepEqual(capabilities.resultFormat.legacyEnvelopeFor, ['none access']);
    assert.equal(capabilities.resultFormat.probeFormat, 'plain');

    const valid = await call('tool-valid');
    assert.equal(valid.ok, true);
    assert.equal(valid.resultSource, 'tool');
    assert.equal(valid.resultSubmission, undefined);
    assert.equal(valid.text, canonical(roleValue('worker', 'Check structured result handling')));
    assert.equal(valid.formatValidation.ok, true);
    assert.equal(valid.roleValidation.ok, true);
    assert.deepEqual(valid.structuredResult, roleValue('worker', 'Check structured result handling'));

    mode = 'spoof';
    const spoof = await call('tool-spoof');
    assert.equal(spoof.ok, false);
    assert.equal(spoof.contract, undefined);
    assert.match(spoof.formatValidation.code, /^result_submission_/);

    mode = 'malformed';
    const malformed = await call('tool-malformed');
    assert.equal(malformed.ok, false);
    assert.equal(malformed.formatValidation.code, 'result_submission_malformed');
    assert.equal(malformed.resultSubmission, undefined);
    assert.equal(malformed.contract, undefined);

    mode = 'multiple';
    const multiple = await call('tool-multiple');
    assert.equal(multiple.ok, false);
    assert.equal(multiple.formatValidation.code, 'result_submission_multiple');
    assert.equal(multiple.contract, undefined);

    mode = 'legacy';
    const legacy = await call('legacy-result');
    assert.equal(legacy.ok, true);
    assert.equal(legacy.resultSource, undefined);
    assert.equal(legacy.roleValidation.ok, true);
  }, async (_request, _signal, inputTask) => {
    const value = roleValue(inputTask.role, inputTask.objective);
    const assistantText = canonical(value);
    if (mode === 'legacy') return { ok:true, text:assistantText };
    if (mode === 'spoof') return { ok:true, resultSubmissionRequired:true, text:assistantText };
    if (mode === 'malformed') return { ok:true, resultSubmissionRequired:true, text:assistantText, resultSubmission:{ok:false,code:'RESULT_SUBMISSION_MALFORMED'} };
    if (mode === 'multiple') return { ok:true, resultSubmissionRequired:true, text:assistantText, resultSubmission:{ok:false,code:'RESULT_SUBMISSION_MULTIPLE'} };
    return { ok:true, resultSubmissionRequired:true, text:'assistant text is not authoritative', resultSubmission:{ok:true,canonicalText:assistantText} };
  });
});

test('gateway applies exact field and role validators to submitted payloads', async () => {
  let mode = 'fields';
  await withGateway(async client => {
    const invalidFields = parse(await client.callTool({ name:'dispatch_subagent', arguments:task('tool-invalid-fields') }));
    assert.equal(invalidFields.ok, false);
    assert.equal(invalidFields.contract, undefined);
    assert.equal(invalidFields.formatValidation.code, 'field_mismatch');

    mode = 'role';
    const invalidRole = parse(await client.callTool({ name:'dispatch_subagent', arguments:task('tool-invalid-role') }));
    assert.equal(invalidRole.ok, false);
    assert.equal(invalidRole.contract, undefined);
    assert.equal(invalidRole.formatValidation.ok, true);
    assert.equal(invalidRole.roleValidation.ok, false);
  }, async (_request, _signal, inputTask) => {
    const value = roleValue(inputTask.role, inputTask.objective);
    if (mode === 'fields') value.extra = true;
    else value.evidence = 'not an array';
    return { ok:true, resultSubmissionRequired:true, resultSubmission:{ok:true,canonicalText:canonical(value)} };
  });
});
