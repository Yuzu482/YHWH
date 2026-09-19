// SPDX-License-Identifier: Apache-2.0
// Host-owned configuration only. Never load endpoints or secrets from a task/workspace.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export const API_PROVIDERS = Object.freeze(['yhwh-worker-api', 'yhwh-reviewer-api']);
export const PLATFORM_PROFILES = Object.freeze({
  'opencode-go': { origin: 'https://opencode.ai', prefix: '/zen/go', protocols: ['openai-responses'], docs: 'https://opencode.ai/v2/docs/console/go' },
  commandcode: { origin: 'https://api.commandcode.ai', prefix: '/provider', protocols: ['openai-responses', 'anthropic-messages'], docs: 'https://commandcode.ai/docs/provider' },
  openrouter: { origin: 'https://openrouter.ai', prefix: '/api', protocols: ['openai-responses', 'anthropic-messages'], docs: 'https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages' },
  custom: { protocols: ['openai-responses', 'anthropic-messages'] },
});
const fail = (code='PI_PROVIDER_CONFIG_INVALID') => { throw Object.assign(new Error(code), {code}); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) { if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) fail(); }
export function validateProviderConfig(value) {
  exact(value, ['version', 'routes']);
  if (value.version !== 1) fail();
  exact(value.routes, API_PROVIDERS);
  for (const [provider, route] of Object.entries(value.routes)) {
    exact(route, ['platform', 'baseUrl', 'model', 'semanticModel', 'protocol', 'credentialRef', 'contextWindow', 'maxTokens', 'capabilities']);
    const reviewer = provider === 'yhwh-reviewer-api';
    if (route.semanticModel !== (reviewer ? 'claude-sonnet-5' : 'gpt-5.6-luna')) fail();
    if (typeof route.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(route.model)) fail();
    // Mapping is explicit; model-family substitution is not an aggregation feature.
    if (route.model.split('/').at(-1) !== route.semanticModel) fail();
    if (!Object.hasOwn(PLATFORM_PROFILES, route.platform)) fail();
    const profile = PLATFORM_PROFILES[route.platform];
    if (!profile.protocols.includes(route.protocol) || route.protocol !== (reviewer ? 'anthropic-messages' : 'openai-responses')) fail();
    let url; try { url = new URL(route.baseUrl); } catch { fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== route.baseUrl || /\s/.test(route.baseUrl)) fail();
    // Custom HTTPS origin is an explicit operator trust decision. No redirects allowed at runtime.
    const suffix = route.protocol === 'anthropic-messages' ? '' : '/v1';
    if (profile.origin && route.baseUrl !== profile.origin + profile.prefix + suffix) fail();
    if (!profile.origin && (route.baseUrl.endsWith('/') || (suffix && !url.pathname.endsWith(suffix)))) fail();
    if (typeof route.credentialRef !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(route.credentialRef)) fail();
    if (!Number.isInteger(route.contextWindow) || route.contextWindow < 4096 || route.contextWindow > 2000000 || !Number.isInteger(route.maxTokens) || route.maxTokens < 256 || route.maxTokens > Math.min(route.contextWindow, 200000)) fail();
    exact(route.capabilities, ['maxThinking', 'tools', 'streaming']);
    if (route.capabilities.maxThinking !== true || route.capabilities.streaming !== true || typeof route.capabilities.tools !== 'boolean' || (!reviewer && !route.capabilities.tools)) fail('PI_PROVIDER_CAPABILITY_REQUIRED');
  }
  return value;
}
export function readHostJson(file, limit=65536) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail();
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') throw error; fail(); }
}
export const configDigest = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function loadProviderConfig(env=process.env) {
  if (!env.USERPROFILE) return {version:1, routes:{}};
  try { return validateProviderConfig(readHostJson(join(env.USERPROFILE, '.local/state/pi-kether/provider-config.json'))); }
  catch (error) { if (error.code === 'ENOENT') return {version:1, routes:{}}; throw error; }
}
export function configuredRoute(provider, config=loadProviderConfig()) { return Object.hasOwn(config.routes,provider) ? config.routes[provider] : undefined; }
export function providerPolicy(provider, config=loadProviderConfig()) {
  const route=configuredRoute(provider,config);
  return route && {defaultModel:route.model,defaultThinking:'max',models:[route.model]};
}
export function selectControlledCredential(provider, config, credentials, expectedDigest) {
  validateProviderConfig(config);
  if (configDigest(config) !== expectedDigest) fail('PI_PROVIDER_CONFIG_CHANGED');
  const route = configuredRoute(provider,config);
  if (!route) fail('PI_PROVIDER_NOT_CONFIGURED');
  const credential = credentials?.[route.credentialRef];
  if (!credential || credential.type !== 'api_key' || typeof credential.key !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(credential.key) || credential.key.startsWith('sk-ant-oat')) fail('PI_AUTH_INVALID');
  return {controlledApi:{provider,route,configDigest:expectedDigest,apiKey:credential.key}};
}
export function controlledBootstrap(data,args) {
  const packet=data?.controlledApi;
  if (!object(data) || Object.keys(data).length!==1 || !packet || !API_PROVIDERS.includes(packet.provider)) fail();
  const one = flag => { if (args.filter(a=>a===flag).length!==1 || args.some(a=>a.startsWith(flag+'='))) fail(); return args[args.indexOf(flag)+1]; };
  const digest=one('--yhwh-config');
  if (digest!==packet.configDigest || !/^[a-f0-9]{64}$/.test(digest)) fail('PI_PROVIDER_CONFIG_CHANGED');
  validateProviderConfig({version:1,routes:{[packet.provider]:packet.route}});
  if (one('--provider')!==packet.provider || one('--model')!==packet.route.model || one('--thinking')!=='max' || args.some(a=>a==='--api-key'||a.startsWith('--api-key='))) fail();
  if (packet.provider==='yhwh-reviewer-api' && (!args.includes('--no-tools')||args.some(a=>a==='--tools'||a.startsWith('--tools=')))) fail();
  selectControlledCredential(packet.provider,{version:1,routes:{[packet.provider]:packet.route}}, {[packet.route.credentialRef]:{type:'api_key',key:packet.apiKey}},configDigest({version:1,routes:{[packet.provider]:packet.route}}));
  const index=args.indexOf('--yhwh-config'); args.splice(index,2);
  return {packet,credentials:{[packet.provider]:{type:'api_key',key:packet.apiKey}}};
}
export function registrationConfig(route) {
  return {baseUrl:route.baseUrl,api:route.protocol,authHeader:true,models:[{
    id:route.model,name:route.semanticModel,reasoning:true,
    thinkingLevelMap:{off:null,minimal:null,low:null,medium:null,high:null,xhigh:null,max:'max'},
    ...(route.protocol==='anthropic-messages'?{compat:{forceAdaptiveThinking:true}}:{}),
    input:['text'],contextWindow:route.contextWindow,maxTokens:route.maxTokens,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  }]};
}
