import { normalizeScopedPath } from './write-scope-guard.js';

const FILE_TOOLS = new Set(['read', 'edit', 'write']);

// Correlate only unambiguous Pi start/end pairs. Arguments and paths never leave this helper.
export function accountToolErrors(events) {
  const starts = new Map(), ends = new Map(), ambiguous = new Set();
  const errorEnds = events.filter(event => event?.type === 'tool_execution_end' && event.isError === true);
  for (const event of events) {
    if (!['tool_execution_start', 'tool_execution_end'].includes(event?.type)) continue;
    const id = event.toolCallId;
    if (typeof id !== 'string' || !id) continue;
    const map = event.type === 'tool_execution_start' ? starts : ends;
    if (map.has(id)) ambiguous.add(id); else map.set(id, event);
  }
  const recoverable = [];
  for (const failedEnd of errorEnds) {
    const id = failedEnd.toolCallId;
    const start = typeof id === 'string' ? starts.get(id) : null;
    if (!id || ambiguous.has(id) || ends.get(id) !== failedEnd || !start || events.indexOf(start) >= events.indexOf(failedEnd) || start.toolName !== failedEnd.toolName || !FILE_TOOLS.has(start.toolName)) {
      recoverable.push(null); continue;
    }
    let target;
    try { target = normalizeScopedPath(start.args?.path).path; } catch { recoverable.push(null); continue; }
    recoverable.push({ id, toolName: start.toolName, target, end: failedEnd });
  }
  const recovered = new Set();
  for (let i = 0; i < recoverable.length; i++) {
    const failed = recoverable[i];
    if (!failed) continue;
    for (const [id, end] of ends) {
      const start = starts.get(id);
      if (ambiguous.has(id) || id === failed.id || !start || events.indexOf(start) >= events.indexOf(end) || start.toolName !== failed.toolName || end.toolName !== failed.toolName || end.isError !== false || !FILE_TOOLS.has(start.toolName)) continue;
      let target;
      try { target = normalizeScopedPath(start.args?.path).path; } catch { continue; }
      if (events.indexOf(start) > events.indexOf(failed.end) && events.indexOf(end) > events.indexOf(failed.end) && target === failed.target) { recovered.add(i); break; }
    }
  }
  const fileToolErrors = recoverable.filter(Boolean).length;
  const recoveredFileToolErrors = recoverable.reduce((count, item, index) => count + (item && recovered.has(index) ? 1 : 0), 0);
  return {
    total: errorEnds.length,
    recoveredErrors: recovered.size,
    unrecoveredErrors: errorEnds.length - recovered.size,
    fileToolErrors,
    unrecoveredFileToolErrors: fileToolErrors - recoveredFileToolErrors,
  };
}
