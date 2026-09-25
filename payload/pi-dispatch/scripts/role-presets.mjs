import { ROLE_MODELS, ROLE_ALIASES } from './role-policy.mjs';

const accessByRole = Object.freeze({
  Yesod: ['none'], Binah: ['none'], Malkuth: ['none', 'read'], Hod: ['none'],
  Chochmah: ['none', 'read'], Chesed: ['none', 'read', 'workspace-write'],
  Netzach: ['none', 'read'], Geburah: ['none'],
});
const purposes = Object.freeze({
  Yesod: 'Coordinate bounded task execution', Binah: 'Analyze and structure information',
  Malkuth: 'Research supplied workspace materials', Hod: 'Produce concise task outputs',
  Chochmah: 'Develop ideas and analysis', Chesed: 'Implement scoped workspace changes',
  Netzach: 'Verify and report task outcomes', Geburah: 'Review supplied materials',
});
const lspRead = ['lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'lsp_references', 'lsp_symbols', 'lsp_rename', 'lsp_completions', 'lsp_code_actions', 'code_overview', 'ast_search', 'yhwh_lsp_diagnostics', 'yhwh_lsp_hover', 'yhwh_lsp_definition', 'yhwh_lsp_references', 'yhwh_lsp_symbols', 'yhwh_lsp_completions', 'yhwh_lsp_code_actions'];
const read = ['read', 'grep', 'find', 'ls', ...lspRead];
const chesedRead = ['read', 'grep', 'find', 'ls', 'yhwh_submit_result'];
const ceilings = Object.freeze({ none: [], read: [...read, 'yhwh_submit_result'], 'workspace-write': [...read, 'edit', 'write', 'code_rewrite', 'yhwh_submit_result'] });

export const ROLE_PRESETS = Object.freeze(Object.fromEntries(Object.keys(ROLE_MODELS).map(role => [role, Object.freeze({
  id: role, purpose: purposes[role], allowedAccess: Object.freeze(accessByRole[role]),
  toolCeilings: Object.freeze(Object.fromEntries(accessByRole[role].map(access => [access, role === 'Chesed' ? (access === 'workspace-write' ? [...chesedRead, 'edit', 'write', 'code_rewrite'] : access === 'read' ? chesedRead : ceilings[access]) : ceilings[access]]))),
})])));

export function resolveRolePreset(role) {
  const canonical = Object.hasOwn(ROLE_ALIASES, role) ? ROLE_ALIASES[role] : role;
  if (!Object.hasOwn(ROLE_PRESETS, canonical)) throw new Error(`Role preset is not admitted: ${role}`);
  return ROLE_PRESETS[canonical];
}

export function validateRoleAccess(role, access) {
  const preset = resolveRolePreset(role);
  if (!preset.allowedAccess.includes(access)) throw new Error(`Role ${preset.id} does not allow ${access} access`);
  return preset;
}
