import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderResult, createMemoryProviderCircuitState } from '../extensions/provider-circuit-state.js';

const provider = 'openai-codex';
const model = 'gpt-5.6-luna';

test('native runtime abort is a failure rather than user cancellation',()=>{
 const assessment=classifyProviderResult({failure:'Missing complete assistant response',diagnostics:'panic(main thread): abort() called; Bun has crashed; SIGABRT'});
 assert.deepEqual(assessment,{healthy:false,category:'runtime_crash',impact:true});
});

test('unsupported account model opens immediately and never records success', () => {
  const circuit=createMemoryProviderCircuitState();
  const assessment=classifyProviderResult({provider,model,requestedProvider:provider,requestedModel:model,ok:false,failure:"Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."});
  assert.equal(assessment.category,'model_unavailable');
  circuit.record({provider,model,...assessment});
  assert.equal(circuit.state(provider,model).state,'open');
  assert.equal(circuit.state(provider,model).lastSuccessAt,null);
  assert.throws(()=>circuit.beginProbe(provider,model),/recovery=true/);
  const lease=circuit.beginProbe(provider,model,{recovery:true});
  assert.ok(lease);
  circuit.cancelProbe(provider,model,lease);
  assert.equal(circuit.state(provider,model).state,'open');
  assert.equal(classifyProviderResult({provider,model,requestedProvider:provider,requestedModel:model,ok:false,failure:'Unhandled provider failure'}).healthy,false);
});

test('a completed model response overrides a nonfatal custom-model warning', () => {
  const circuit = createMemoryProviderCircuitState();
  const matched = { provider, model, requestedProvider: provider, requestedModel: model };
  circuit.record({ provider, model, healthy: false, category: 'model_unavailable', probe: true });
  const assessment = classifyProviderResult({
    ...matched, ok: true, exitCode: 0, failure: null,
    diagnostics: `Warning: Model "${model}" not found for provider "${provider}". Using custom model id.`,
  });
  assert.deepEqual(assessment, { healthy: true, category: 'provider_reachable', impact: true });
  assert.deepEqual(classifyProviderResult({
    ...matched, ok: false, exitCode: 10, failure: null,
    diagnostics: `Warning: Model "${model}" not found for provider "${provider}". Using custom model id.`,
  }), assessment);
  circuit.record({ provider, model, ...assessment, probe: true, heartbeatPassed: true });
  assert.equal(circuit.state(provider, model).state, 'closed');
});

test('authentication opens indefinitely and needs an explicit recovery probe', () => {
  let now = 1_700_000_000_000;
  const circuit = createMemoryProviderCircuitState({ clock: () => now });
  circuit.record({ provider, model, healthy: false, category: 'authentication', probe: true });
  assert.equal(circuit.state(provider, model).state, 'open');
  assert.equal(circuit.state(provider, model).retryAt, null);
  assert.equal(circuit.state(provider, model).canRecoveryProbe, true);
  assert.throws(() => circuit.assertTaskAllowed(provider, model), /repair login/);
  assert.throws(() => circuit.beginProbe(provider, model), /recovery=true/);
  now += 24 * 60 * 60 * 1000;
  assert.equal(circuit.state(provider, model).state, 'open');
  const lease = circuit.beginProbe(provider, model, { recovery: true });
  assert.ok(lease);
  assert.equal(circuit.state(provider, model).probeInFlight, true);
  assert.equal(circuit.state(provider, model).canRecoveryProbe, false);
  assert.throws(() => circuit.beginProbe(provider, model, { recovery: true }), /already in flight/);
  circuit.record({ provider, model, healthy: true, category: 'provider_reachable', probe: true, heartbeatPassed: true });
  assert.equal(circuit.state(provider, model).state, 'closed');
});

test('network failures open after threshold and cooldown becomes half-open', () => {
  let now = 1_700_000_000_000;
  const circuit = createMemoryProviderCircuitState({ clock: () => now, failureThreshold: 3, failureCooldownMs: 500 });
  for (let index = 0; index < 2; index++) {
    circuit.record({ provider, model, healthy: false, category: 'network' });
    now += 10;
    assert.equal(circuit.state(provider, model).state, 'closed');
  }
  circuit.record({ provider, model, healthy: false, category: 'timeout' });
  assert.equal(circuit.state(provider, model).state, 'open');
  now += 501;
  assert.equal(circuit.state(provider, model).state, 'half-open');
  assert.throws(() => circuit.assertTaskAllowed(provider, model), /recovery probe/);
  assert.ok(circuit.beginProbe(provider, model));
});

test('429 opens immediately and honors provider retry-after', () => {
  let now = 1_700_000_000_000;
  const circuit = createMemoryProviderCircuitState({ clock: () => now, rateLimitCooldownMs: 60_000 });
  const assessment = classifyProviderResult({ failure: '429 too many requests; retry-after: 12 seconds' });
  assert.equal(assessment.category, 'rate_limit');
  assert.equal(assessment.retryAfterMs, 12_000);
  circuit.record({ provider, model, ...assessment });
  assert.equal(circuit.state(provider, model).state, 'open');
  now += 12_001;
  assert.equal(circuit.state(provider, model).state, 'half-open');
});

test('answer quality and tool failures do not count as provider failures', () => {
  const matched = { provider, model, requestedProvider: provider, requestedModel: model };
  assert.deepEqual(classifyProviderResult({ ...matched, ok: false, failure: 'Tool execution failed', toolErrors: 1 }), { healthy: true, category: 'provider_reachable', impact: true });
  assert.deepEqual(classifyProviderResult({ ...matched, ok: true, text: 'refusal' }), { healthy: true, category: 'provider_reachable', impact: true });
  assert.equal(classifyProviderResult({ failure: 'Provided authentication token is expired.' }).category, 'authentication');
  assert.equal(classifyProviderResult(null, new Error('cancelled')).impact, false);
});
