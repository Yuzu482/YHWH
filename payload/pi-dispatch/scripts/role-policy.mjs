import { API_PROVIDERS, configuredRoute } from './controlled-provider.mjs';
export const ROLE_MODELS = Object.freeze({
  Yesod: 'gpt-6-luna', Binah: 'gpt-6-luna', Malkuth: 'gpt-6-luna',
  Hod: 'gpt-6-luna', Chochmah: 'gpt-6-luna', Chesed: 'gpt-6-luna', Netzach: 'gpt-6-luna',
  Geburah: 'claude-sonnet-5',
});
export const ROLE_ALIASES = Object.freeze({worker:'Chesed',researcher:'Malkuth',reviewer:'Geburah'});
export const ROLE_PROVIDERS = Object.freeze(Object.fromEntries(Object.keys(ROLE_MODELS).map(role => [role,role === 'Geburah' ? 'anthropic' : 'openai-codex'])));
export function resolveRoleModel(role, requestedModel, requestedProvider) {
  const canonical = Object.hasOwn(ROLE_ALIASES,role) ? ROLE_ALIASES[role] : role;
  if (!Object.hasOwn(ROLE_MODELS,canonical)) throw new Error(`Role is not admitted for Pi execution: ${role}`);
  if (API_PROVIDERS.includes(requestedProvider)) {
    const route=configuredRoute(requestedProvider);
    const expected=canonical==='Geburah'?'yhwh-reviewer-api':'yhwh-worker-api';
    if (!route || requestedProvider!==expected || (route.semanticModel!==ROLE_MODELS[canonical] && !(requestedProvider==='yhwh-worker-api' && canonical!=='Geburah' && route.semanticModel==='gpt-5.6-luna'))) throw new Error('Controlled API role binding rejected');
    if (requestedModel!==undefined && requestedModel!==route.model) throw new Error('Controlled API model binding rejected');
    return {role:canonical,provider:requestedProvider,model:route.model};
  }
  const model=ROLE_MODELS[canonical];
  const provider=ROLE_PROVIDERS[canonical];
  if (requestedProvider !== undefined && requestedProvider !== provider) throw new Error(`Role ${canonical} requires provider ${provider}`);
  if (requestedModel !== undefined && requestedModel !== model) throw new Error(`Role ${canonical} requires model ${model}`);
  return {role:canonical,model,provider};
}
