// Client contracts checked against the linked official documentation on 2026-09-18.
// These are export templates, not evidence that an application loaded the configuration.
const standard = (file, rule, sources, extra = {}) => ({file, rule, sources, format:'mcpServers', ...extra});
export const COMMON_CLIENTS = Object.freeze({
  cursor: standard('.cursor/mcp.json', '.cursor/rules/yhwh.mdc', ['https://prod.cursor.com/help/customization/mcp','https://prod.cursor.com/docs/rules'], {frontmatter:'alwaysApply: true'}),
  'vscode-copilot': standard('.vscode/mcp.json', '.github/copilot-instructions.md', ['https://code.visualstudio.com/docs/agent-customization/mcp-servers','https://code.visualstudio.com/docs/agent-customization/custom-instructions'], {format:'servers', serverOptions:{type:'stdio'}}),
  windsurf: standard('mcp_config.json', '.windsurf/rules/yhwh.md', ['https://docs.windsurf.com/windsurf/cascade/mcp','https://docs.windsurf.com/windsurf/cascade/memories'], {frontmatter:'trigger: always_on', scope:'Cascade only; not Devin Local'}),
  cline: standard('cline_mcp_settings.json', '.clinerules/yhwh.md', ['https://docs.cline.bot/mcp/mcp-overview','https://github.com/cline/cline/blob/main/docs/customization/cline-rules.mdx'], {serverOptions:{disabled:false,autoApprove:[]}}),
  'roo-code': standard('.roo/mcp.json', '.roo/rules/yhwh.md', ['https://docs.roocode.com/features/mcp/using-mcp-in-roo','https://docs.roocode.com/features/custom-instructions'], {serverOptions:{disabled:false,alwaysAllow:[]}}),
  'gemini-cli': standard('.gemini/settings.json', 'GEMINI.md', ['https://geminicli.com/docs/tools/mcp-server/','https://geminicli.com/docs/cli/gemini-md/'], {serverOptions:{trust:false}}),
  kiro: standard('.kiro/settings/mcp.json', '.kiro/steering/yhwh.md', ['https://kiro.dev/docs/mcp/configuration/','https://kiro.dev/docs/steering/'], {frontmatter:'inclusion: always',serverOptions:{disabled:false,autoApprove:[]},scope:'Local IDE/CLI; cloud requires remote transport'}),
  zed: standard('settings.json', 'AGENTS.md', ['https://zed.dev/docs/ai/mcp','https://zed.dev/docs/ai/instructions'], {format:'context_servers',scope:'Native Zed Agent; external agents have separate instruction loading'}),
  continue: standard('.continue/mcpServers/yhwh.json', '.continue/rules/yhwh.md', ['https://docs.continue.dev/customize/deep-dives/mcp','https://docs.continue.dev/customize/deep-dives/rules'], {frontmatter:'name: YHWH primary coordinator\nalwaysApply: true',scope:'IDE Agent mode; CLI discovery not validated'}),
  'lm-studio': standard('mcp.json', 'SYSTEM-PROMPT.md', ['https://lmstudio.ai/docs/app/mcp','https://lmstudio.ai/blog/lmstudio-v0.3.17'], {scope:'Tool-capable local model; paste instructions into the active chat system prompt'}),
});

export function commonClientFiles(host, connection, prompt) {
  const spec = COMMON_CLIENTS[host];
  if (!spec) return {};
  const server = {...connection, ...spec.serverOptions};
  return {
    [spec.file]: JSON.stringify({[spec.format]:{yhwh:server}},null,2)+'\n',
    [spec.rule]: (spec.frontmatter ? `---\n${spec.frontmatter}\n---\n\n` : '')+prompt,
  };
}
