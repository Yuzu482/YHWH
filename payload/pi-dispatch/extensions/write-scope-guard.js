import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

const CONTROL = /[\u0000-\u001f\u007f]/u;
const GLOB = /[*?\[\]{}]/u;
const PROTECTED = new Set(['.git', '.hg', '.svn']);

export function normalizeScopedPath(value, { scope = false } = {}) {
  if (typeof value !== 'string') throw new Error('path must be a string');
  const text = value.normalize('NFC').trim().replaceAll('\\', '/');
  if (!text || CONTROL.test(text) || text.includes(':') || text.startsWith('/') || win32.isAbsolute(text)) throw new Error('path must be a printable relative workspace path');
  let tree = false;
  let body = text;
  if (scope && body.endsWith('/**')) { tree = true; body = body.slice(0, -3); }
  if (!body || GLOB.test(body)) throw new Error('only a terminal /** directory scope is supported');
  const segments = body.split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) throw new Error('path traversal and empty segments are not allowed');
  if (PROTECTED.has(segments[0].toLowerCase())) throw new Error('version-control metadata is protected');
  return { path: segments.join('/'), tree };
}

export function compileWriteScope(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('writeScope must contain at least one path');
  const compiled = entries.map(entry => normalizeScopedPath(entry, { scope: true }));
  const seen = new Set();
  for (const item of compiled) {
    const key = `${item.tree ? 'tree' : 'file'}:${item.path}`;
    if (seen.has(key)) throw new Error(`duplicate writeScope entry: ${item.path}`);
    seen.add(key);
  }
  return compiled;
}

export function isAllowedPath(target, compiledScope) {
  const normalized = normalizeScopedPath(target).path;
  return compiledScope.some(item => item.tree ? normalized === item.path || normalized.startsWith(`${item.path}/`) : normalized === item.path);
}

export function assertSafeFilesystemTarget(target, cwd) {
  const normalized = normalizeScopedPath(target).path;
  const absolute = resolve(cwd, ...normalized.split('/'));
  const rel = relative(cwd, absolute);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('resolved path escapes the workspace');
  let current = cwd;
  for (const segment of normalized.split('/')) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symbolic-link path component is not writable: ${normalized}`);
    if (current === absolute && stat.isFile() && stat.nlink > 1) throw new Error(`hard-linked files are not writable: ${normalized}`);
  }
  return normalized;
}

export function validateUnifiedPatch(patch, entries, baselinePrefix, workspacePrefix) {
  const scope = compileWriteScope(entries);
  if (typeof patch !== 'string') throw new Error('patch must be text');
  if (!patch) return [];
  if (/^(Binary files |Files |Only in |diff .*--|GIT binary patch)/m.test(patch)) throw new Error('Unverifiable binary or non-unified patch record');
  const changed = [];
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('--- ')) continue;
    const next = lines[index + 1] ?? '';
    if (!next.startsWith('+++ ')) throw new Error('malformed unified patch header');
    const before = lines[index].slice(4).split('\t', 1)[0];
    const after = next.slice(4).split('\t', 1)[0];
    if (!before.startsWith(`${baselinePrefix}/`) || !after.startsWith(`${workspacePrefix}/`)) throw new Error('patch path prefix mismatch');
    const left = before.slice(baselinePrefix.length + 1);
    const right = after.slice(workspacePrefix.length + 1);
    if (left !== right) throw new Error('patch attempts a cross-path rename');
    const normalized = normalizeScopedPath(right).path;
    if (!isAllowedPath(normalized, scope)) throw new Error(`patch changed path outside writeScope: ${normalized}`);
    changed.push(normalized);
  }
  if (changed.length === 0) throw new Error('non-empty patch did not contain verifiable file headers');
  return [...new Set(changed)];
}

function loadAuthoritativeScope() {
  const path = process.env.PI_WRITE_SCOPE_FILE;
  if (!path) throw new Error('PI_WRITE_SCOPE_FILE is required');
  return compileWriteScope(JSON.parse(readFileSync(path, 'utf8')));
}

export default function writeScopeGuard(pi) {
  let scope;
  let setupError;
  try { scope = loadAuthoritativeScope(); } catch (error) { setupError = error.message; }
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'bash' || event.toolName === 'powershell') return { block: true, reason: 'Shell tools are disabled for scope-enforced write tasks', terminate: false };
    if (!['write', 'edit', 'code_rewrite'].includes(event.toolName)) return undefined;
    if (setupError || !scope) return { block: true, reason: `Write scope is unavailable: ${setupError || 'unknown error'}`, terminate: true };
    if (event.toolName === 'code_rewrite' && event.input?.dry_run !== false) return undefined;
    try {
      const normalized = assertSafeFilesystemTarget(event.input?.path, ctx.cwd);
      if (!isAllowedPath(normalized, scope)) throw new Error(`path is outside writeScope: ${normalized}`);
      event.input.path = normalized;
      return undefined;
    } catch (error) {
      return { block: true, reason: `Write rejected by scope guard: ${error.message}`, terminate: false };
    }
  });
}
