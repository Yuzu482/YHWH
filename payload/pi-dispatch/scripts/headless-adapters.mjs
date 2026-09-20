// Official primary-host CLI transports. These are deliberately not Pi providers.
export const adapters = Object.freeze({
  codex: { policies: ['read-only', 'workspace-write'], versionArgs: ['--version'], helpArgs: ['exec', '--help'], requiredFlags: ['--json', '--ephemeral', '--sandbox', '--model', '--config', '--color'], source: 'https://developers.openai.com/codex/noninteractive' },
  claude: { policies: ['no-tools', 'native'], versionArgs: ['--version'], helpArgs: ['--help'], requiredFlags: ['--print', '--output-format', '--tools', '--strict-mcp-config', '--safe-mode', '--mcp-config', '--disallowedTools', '--permission-mode', '--no-session-persistence', '--model', '--effort'], source: 'https://code.claude.com/docs/en/cli-reference' },
  antigravity: { policies: ['native'], versionArgs: ['--version'], helpArgs: ['--help'], requiredFlags: ['--input-format', '--output-format', '--model'], source: 'https://www.antigravity.google/docs/cli/headless/' },
});

export function invocation(client, settings, prompt) {
  const model = ['--model', settings.model];
  if (client === 'codex') return {
    args: ['exec', '--json', '--ephemeral', '--color', 'never', '--sandbox', settings.policy,
      '-c', 'approval_policy="never"', ...model, ...(settings.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(settings.effort)}`] : []), '-'],
    input: prompt,
  };
  if (client === 'claude') return {
    args: ['--print', '--output-format', 'json', '--no-session-persistence', ...model,
      ...(settings.effort ? ['--effort', settings.effort] : []),
      ...(settings.policy === 'no-tools' ? ['--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk'] : [])],
    input: prompt,
  };
  if (client === 'antigravity') return {
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', ...model,
      ...(settings.effort ? ['--effort', settings.effort] : [])],
    input: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
  };
  throw new Error('unknown_client');
}

export function parseResult(client, stdout) {
  const invalid = () => { throw new Error('invalid_cli_result'); };
  try {
    if (client === 'claude') {
      const r = JSON.parse(stdout);
      if (r.type !== 'result' || r.subtype !== 'success' || r.is_error !== false || typeof r.result !== 'string') return invalid();
      return { text: r.result, usage: r.usage ?? null };
    }
    const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (client === 'antigravity') {
      const results = events.filter(e => e.event === 'result');
      if (results.length !== 1 || results[0] !== events.at(-1)) return invalid();
      const r = results[0].result;
      if (r.status !== 'SUCCESS' || r.error || typeof r.response !== 'string') return invalid();
      return { text: r.response, usage: r.usage ?? null };
    }
    if (client !== 'codex' || events.some(e => ['error', 'turn.failed'].includes(e.type))) return invalid();
    const completed = events.filter(e => e.type === 'turn.completed');
    if (completed.length !== 1 || completed[0] !== events.at(-1)) return invalid();
    const replies = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message');
    if (!replies.length || replies.some(e => typeof e.item.text !== 'string')) return invalid();
    return { text: replies.at(-1).item.text, usage: completed[0].usage ?? null };
  } catch { return invalid(); }
}
