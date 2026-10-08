import {API_PROVIDERS} from '../../controlled-provider.mjs';
import {resolveControlledExtensions} from '../../provider-policy.mjs';
import {validateRoleAccess} from '../../role-presets.mjs';

export const safeFlags = Object.freeze(['--offline', '--no-approve', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-extensions']);
const readTools = ['read', 'grep', 'find', 'ls'];
const lspReadTools = ['lsp_diagnostics', 'lsp_hover', 'lsp_definition', 'lsp_references', 'lsp_symbols', 'lsp_rename', 'lsp_completions', 'lsp_code_actions', 'code_overview', 'ast_search'];
const wslLspTools = ['diagnostics','hover','definition','references','symbols','completions','code_actions'].map(m => `yhwh_lsp_${m}`);
const rolePresetExtension = '/opt/pi-kether/extensions/role-presets.js';
const resultSubmitExtension = '/opt/pi-kether/extensions/result-submit.js';
const sourceWindowExtension = '/opt/pi-kether/extensions/source-window.js';

export function buildPiArgs(request, runtime = 'host', editorAuthorized = false, structuredResultTool = false) {
  const args = [...safeFlags, '--print', '--mode', 'json', '--no-session'];
  let preset;
  if (request.rolePresetId !== undefined) {
    if (runtime !== 'wsl2') throw new Error('Role presets require WSL2');
    preset = validateRoleAccess(request.rolePresetId, request.access);
    if (preset.id !== request.rolePresetId) throw new Error('Invalid role preset identity');
    args.push('--extension', rolePresetExtension, '--yhwh-role-preset', preset.id);
  }
  for (const extension of resolveControlledExtensions(request.provider, request.access, process.env, runtime)) args.push('--extension', extension);
  if (runtime === 'wsl2') args.push('--extension', '/opt/pi-kether/extensions/auth-scrub.js');
  if (runtime === 'wsl2' && request.access !== 'none') args.push('--extension', sourceWindowExtension);
  if (structuredResultTool) {
    if (runtime !== 'wsl2' || request.access === 'none') throw new Error('Structured result tool requires WSL2 read or workspace-write access');
    if (!preset) throw new Error('Structured result tool requires a trusted role preset');
    args.push('--extension', resultSubmitExtension, '--yhwh-result-role', request.rolePresetId);
  }
  args.push('--provider', request.provider, '--model', request.model);
  if (request.thinking) args.push('--thinking', request.thinking);
  if (API_PROVIDERS.includes(request.provider)) {
    if (!/^[a-f0-9]{64}$/.test(request.providerConfigDigest ?? '')) throw new Error('PI_PROVIDER_CONFIG_REQUIRED');
    args.push('--yhwh-config', request.providerConfigDigest);
  }
  if (editorAuthorized) {
    if(runtime!=='wsl2'||request.provider!=='openai-codex')throw new Error('Editor proxy requires WSL openai-codex');
    args.push('--extension','/opt/pi-kether/extensions/editor-proxy.js');
  }
  if (request.access === 'none' && !editorAuthorized) args.push('--no-tools');
  else {
    const tools = request.access === 'none' ? [] : request.access === 'read'
      ? [...readTools, ...(runtime === 'wsl2' ? [] : lspReadTools)]
      : [...readTools, ...(runtime === 'wsl2' ? [] : lspReadTools), 'edit', 'write', ...(runtime === 'wsl2' ? [] : ['code_rewrite'])];
    if (runtime === 'wsl2' && request.access !== 'none') tools.push(...wslLspTools, 'yhwh_source_window');
    if (structuredResultTool) tools.push('yhwh_submit_result');
    if (preset) {
      const ceiling = new Set(preset.toolCeilings[request.access]);
      const bounded = tools.filter(tool => ceiling.has(tool));
      if (editorAuthorized) bounded.push('pi_editor_execute');
      args.push('--tools', bounded.join(','));
      return args;
    }
    if(editorAuthorized)tools.push('pi_editor_execute');
    args.push('--tools', tools.join(','));
  }
  return args;
}

