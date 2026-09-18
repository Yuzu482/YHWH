export const ROLE_MODELS = Object.freeze({
  Yesod: 'gpt-5.6-luna', Binah: 'gpt-5.6-luna', Malkuth: 'gpt-5.6-luna',
  Hod: 'gpt-5.6-luna', Chochmah: 'gpt-5.6-luna', Chesed: 'gpt-5.6-luna', Netzach: 'gpt-5.6-luna',
  Geburah: 'claude-sonnet-5',
});
export const ROLE_ALIASES = Object.freeze({worker:'Chesed',researcher:'Malkuth',reviewer:'Geburah'});
export const ROLE_PROVIDERS = Object.freeze(Object.fromEntries(Object.keys(ROLE_MODELS).map(role => [role,role === 'Geburah' ? 'pi-claude-code-provider' : 'openai-codex'])));
export function resolveRoleModel(role, requestedModel, requestedProvider) {
  const canonical = Object.hasOwn(ROLE_ALIASES,role) ? ROLE_ALIASES[role] : role;
  if (!Object.hasOwn(ROLE_MODELS,canonical)) throw new Error(`Role is not admitted for Pi execution: ${role}`);
  const model=ROLE_MODELS[canonical];
  const provider=ROLE_PROVIDERS[canonical];
  if (requestedProvider !== undefined && requestedProvider !== provider) throw new Error(`Role ${canonical} requires provider ${provider}`);
  if (requestedModel !== undefined && requestedModel !== model) throw new Error(`Role ${canonical} requires model ${model}`);
  return {role:canonical,model,provider};
}
