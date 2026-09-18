import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROVIDER_POLICY = Object.freeze({
  'pi-claude-code-provider': Object.freeze({defaultModel:'claude-sonnet-5',defaultThinking:'max',models:Object.freeze(['claude-sonnet-5'])}),
  'openai-codex': Object.freeze({
    defaultModel: 'gpt-5.6-luna',
    defaultThinking: 'max',
    models: Object.freeze(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']),
  }),

});

export function validateRoute(provider, model) {
  const policy = PROVIDER_POLICY[provider];
  if (!policy) throw new Error('provider is not in the Pi gateway allowlist');
  if (!policy.models.includes(model)) throw new Error('provider/model tuple is not in the Pi gateway allowlist');
  return policy;
}

export function resolveControlledExtensions(provider, access, env = process.env, runtime = 'host') {
  const userProfile = env.USERPROFILE;
  if (!userProfile) throw new Error('USERPROFILE is required to resolve controlled Pi extensions');
  const agentModules = runtime === 'wsl2' ? '/opt/pi-kether/node_modules' : join(userProfile, '.pi', 'agent', 'npm', 'node_modules');
  const joinPath = runtime === 'wsl2' ? posix.join : join;
  const paths = [];
  if (provider === 'pi-claude-code-provider') {
    if (access !== 'none' || runtime !== 'wsl2') throw new Error('Claude review requires WSL and none access');
    paths.push('/opt/pi-kether/extensions/claude-review.ts');
  }
  if (runtime === 'wsl2' && access !== 'none') paths.push('/opt/pi-kether/extensions/read-scope-guard.js');
  if (access !== 'none') paths.push(joinPath(agentModules, 'pi-lsp-extension', 'src', 'index.ts'));
  if (access === 'workspace-write') {
    paths.push(runtime === 'wsl2'
      ? '/opt/pi-kether/extensions/write-scope-guard.js'
      : fileURLToPath(new URL('../extensions/write-scope-guard.js', import.meta.url)));
  }
  if (runtime === 'host') for (const path of paths) if (!existsSync(path)) throw new Error(`Required controlled Pi extension is missing: ${path}`);
  return paths;
}

export function publicCapabilities() {
  return {
    providers: Object.fromEntries(Object.entries(PROVIDER_POLICY).map(([provider, policy]) => [provider, {
      defaultModel: policy.defaultModel,
      defaultThinking: policy.defaultThinking,
      models: [...policy.models],
    }])),
    access: ['none', 'read'],
    writeEnabled: false,
    osSandbox: 'unavailable',
    maxConcurrency: 4,
  };
}
