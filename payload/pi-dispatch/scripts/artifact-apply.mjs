import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { assertSafeFilesystemTarget, compileWriteScope, isAllowedPath, normalizeScopedPath } from '../extensions/write-scope-guard.js';

const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function decodePatchHeader(value) {
  if (!value.startsWith('"')) return value.split('\t', 1)[0];
  const bytes = [];
  let i = 1;
  for (; i < value.length && value[i] !== '"'; i++) {
    if (value[i] !== '\\') { const char=String.fromCodePoint(value.codePointAt(i)); bytes.push(...Buffer.from(char)); i += char.length - 1; continue; }
    const octal = /^[0-7]{3}/.exec(value.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    const escaped = value[++i];
    if (!['\\', '"', 't', 'n', 'r'].includes(escaped)) throw new Error('invalid quoted patch escape');
    bytes.push(...Buffer.from(({t:'\t', n:'\n', r:'\r'})[escaped] ?? escaped));
  }
  if (value[i] !== '"' || (value.slice(i + 1) && !value.slice(i + 1).startsWith('\t'))) throw new Error('malformed quoted patch header');
  return new TextDecoder('utf-8', {fatal:true}).decode(Uint8Array.from(bytes));
}
const quote = path => /[\s"\\]/u.test(path) ? `"${path.replaceAll('\\','\\\\').replaceAll('"','\\"')}"` : path;
function safePath(value) {
  const normalized = normalizeScopedPath(value).path;
  if (normalized !== value || normalized.split('/').some(p => ['.git','.hg','.svn'].includes(p.toLowerCase()))) throw new Error('noncanonical or protected patch path');
  return normalized;
}

// Count hunk lines before interpreting headers; hunk data remains byte-for-byte intact.
export function parsePatchHeaders(patch) {
  if (typeof patch !== 'string' || patch.includes('\0') || Buffer.byteLength(patch) > 4 * 1024 * 1024) throw new Error('invalid patch text');
  const lines = patch.split('\n'), pairs = [], metadata = [];
  let old = 0, current = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (old || current) {
      if (line === '\\ No newline at end of file' || line === '\\ No newline at end of file\r') continue;
      if (line.startsWith('+') && current) current--;
      else if (line.startsWith('-') && old) old--;
      else if (line.startsWith(' ') && old && current) { old--; current--; }
      else throw new Error('malformed patch hunk');
      continue;
    }
    if (/^diff -ruN? /.test(line)) { metadata.push(i); continue; }
    if (/^(?:Binary files |Only in |GIT binary patch|rename |copy )/.test(line)) throw new Error('unsupported patch record');
    if (line.startsWith('--- ')) {
      if (!lines[i + 1]?.startsWith('+++ ')) throw new Error('unpaired patch header');
      pairs.push({index:i, before:decodePatchHeader(line.slice(4)), after:decodePatchHeader(lines[i + 1].slice(4))}); i++; continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (!pairs.length) throw new Error('hunk without file headers');
      old = Number(hunk[2] ?? 1); current = Number(hunk[4] ?? 1);
      if (![old,current].every(Number.isSafeInteger)) throw new Error('invalid hunk range');
    } else if (line.startsWith('@@') || line.startsWith('+++ ')) throw new Error('invalid patch header');
  }
  if (old || current) throw new Error('truncated patch hunk');
  return {lines, pairs, metadata};
}

export function relativePatchFiles(patch) {
  const files = parsePatchHeaders(patch).pairs.map(({before,after}) => {
    const left = before === '/dev/null' ? null : before.startsWith('a/') ? safePath(before.slice(2)) : undefined;
    const right = after === '/dev/null' ? null : after.startsWith('b/') ? safePath(after.slice(2)) : undefined;
    if (left === undefined || right === undefined || (!left && !right) || (left && right && left !== right)) throw new Error('invalid relative patch paths');
    return left ?? right;
  });
  if (!files.length || new Set(files).size !== files.length) throw new Error('missing or repeated patch files');
  return files.sort();
}

export function sandboxPatchFiles(patch, {baseline,workspace,writeScope}) {
  if (!patch) return [];
  const scope = compileWriteScope(writeScope);
  const files = parsePatchHeaders(patch).pairs.map(({before,after}) => {
    if (!before.startsWith(`${baseline}/`) || !after.startsWith(`${workspace}/`)) throw new Error('sandbox patch prefix mismatch');
    const path = safePath(before.slice(baseline.length + 1));
    if (safePath(after.slice(workspace.length + 1)) !== path || !isAllowedPath(path,scope)) throw new Error('patch path outside write scope');
    return path;
  });
  if (!files.length || new Set(files).size !== files.length) throw new Error('missing or repeated patch files');
  return files.sort();
}

export function normalizeSandboxPatch(patch, job, changedFiles, roots = {}, fileStates) {
  if (!UUID.test(job) || !Array.isArray(changedFiles)) throw new Error('invalid sandbox patch binding');
  const baseline = roots.baseline ?? `/var/lib/pi-kether/jobs/${job}/baseline`;
  const workspace = roots.workspace ?? `/var/lib/pi-kether/jobs/${job}/workspace`;
  const {lines,pairs,metadata} = parsePatchHeaders(patch);
  const states = new Map();
  if (fileStates !== undefined) {
    if (!Array.isArray(fileStates) || fileStates.length !== changedFiles.length) throw new Error('invalid file existence proof');
    for (const row of fileStates) {
      if (!row || typeof row.before !== 'boolean' || typeof row.after !== 'boolean' || (!row.before && !row.after) || states.has(row.path)) throw new Error('invalid file existence proof');
      states.set(safePath(row.path), row);
    }
    if (!same(states.keys(), changedFiles)) throw new Error('file existence proof mismatch');
  }
  for (const {index,before,after} of pairs) {
    if (!before.startsWith(`${baseline}/`) || !after.startsWith(`${workspace}/`)) throw new Error('sandbox patch prefix mismatch');
    const path = safePath(before.slice(baseline.length + 1));
    if (path !== safePath(after.slice(workspace.length + 1))) throw new Error('cross-path rename');
    const state = states.get(path);
    // Old transports lack existence data. Do not guess deletion from zero-size hunks or epoch timestamps.
    if (!state && /\t1970-01-01 /.test(lines[index] + lines[index + 1])) throw new Error('file existence proof required');
    lines[index] = `--- ${state?.before === false ? '/dev/null' : quote(`a/${path}`)}`;
    lines[index + 1] = `+++ ${state?.after === false ? '/dev/null' : quote(`b/${path}`)}`;
  }
  for (const index of metadata.reverse()) lines.splice(index, 1);
  const normalized = lines.join('\n');
  if (!same(relativePatchFiles(normalized), changedFiles)) throw new Error('normalized patch files mismatch');
  return normalized;
}

// Called only by the trusted post-snapshot producer, never by apply_artifact or a model.
export function describeSandboxFiles(patch, {baseline, workspace}) {
  const present = (root, path) => {
    try { const target = assertSafeFilesystemTarget(path, root), st = lstatSync(resolve(root, target)); if (!st.isFile()) throw new Error('non-file sandbox target'); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return parsePatchHeaders(patch).pairs.map(({before,after}) => {
    if (!before.startsWith(`${baseline}/`) || !after.startsWith(`${workspace}/`)) throw new Error('sandbox file prefix mismatch');
    const path = safePath(before.slice(baseline.length + 1));
    if (safePath(after.slice(workspace.length + 1)) !== path) throw new Error('cross-path rename');
    return {path, before:present(baseline,path), after:present(workspace,path)};
  });
}

function gitEnvironment(cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform === 'win32' ? 'NUL' : '/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'3',
    GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'false',GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:process.platform === 'win32' ? 'NUL' : '/dev/null',GIT_CONFIG_KEY_2:'safe.directory',GIT_CONFIG_VALUE_2:cwd});
  return env;
}
const errorData = error => error ? {message:error.message, ...(error.code ? {code:error.code} : {})} : null;
export function runArtifactGit({cwd,args,patch,spawnFn=spawn,timeoutMs=15000,outputLimit=65536}) {
  if (!(same(args,['apply']) || (args.length === 2 && args[0] === 'apply' && args[1] === '--check'))) throw new Error('unsupported Git operation');
  return new Promise(resolveCall => {
    let child, timer, error = null, timedOut = false, overflow = false, stdout = '', stderr = '';
    const decoders = {stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')}, counts = {stdout:0,stderr:0};
    const stop = () => { try { child.kill(); } catch (failure) { error ??= failure; } };
    try { child = spawnFn('git',args,{cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:gitEnvironment(cwd)}); }
    catch (failure) { resolveCall({ok:false,exitCode:null,signal:null,stdout,stderr,error:errorData(failure),timedOut:false}); return; }
    for (const name of ['stdout','stderr']) child[name]?.on('data',chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0,outputLimit-counts[name]); counts[name] += bytes.length;
      const text = decoders[name].write(bytes.subarray(0,remaining));
      if (name === 'stdout') stdout += text; else stderr += text;
      if (counts[name] > outputLimit && !overflow) { overflow = true; stop(); }
    });
    child.on('error',failure => {error ??= failure;});
    child.stdin?.on('error',failure => {if (failure.code !== 'EPIPE') {error ??= failure; stop();}});
    child.on('close',(exitCode,signal) => {
      clearTimeout(timer);
      if (!overflow) { stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); }
      resolveCall({ok:exitCode === 0 && !signal && !error && !timedOut && !overflow,exitCode,signal:signal ?? null,stdout,stderr,
        error:errorData(error ?? (timedOut ? Object.assign(new Error('Git operation timed out'),{code:'ETIMEDOUT'}) : overflow ? Object.assign(new Error('Git output limit exceeded'),{code:'EOUTPUTLIMIT'}) : null)),timedOut,...(overflow ? {outputTruncated:true} : {})});
    });
    timer = setTimeout(() => {timedOut = true; stop();},timeoutMs); timer.unref?.();
    try { child.stdin.end(patch,'utf8'); } catch (failure) {error ??= failure; stop();}
  });
}

export async function applyArtifact({requestId,ledger,roots=[],writeLocks,spawnFn=spawn}) {
  const fail = (code,error=code) => ({ok:false,requestId,code,error});
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) return fail('invalid_request');
  const artifact = typeof ledger?.getHostApplyArtifact === 'function' ? ledger.getHostApplyArtifact(requestId) : ledger?.getHostArtifact(requestId), pending = artifact?.pending;
  if (!pending || ledger?.getEffectiveResult(requestId)?.state !== 'awaiting-host-verification') return fail('artifact_not_pending');
  const response = artifact.originalResult?.response ?? artifact.originalResult, patch = response?.patch, proof = response?.patchValidation;
  if (typeof patch !== 'string' || !HEX.test(pending.artifactSha256 ?? '') || pending.artifactSha256 !== response.patchSha256 || pending.artifactSha256 !== proof?.patchSha256 || !proof.ok || proof.requestId !== requestId || digest(patch) !== pending.artifactSha256 || response.patchBytes !== Buffer.byteLength(patch)) return fail('artifact_hash_mismatch');
  if (response.secretLikeContent === true) return fail('secret_content_confirmation_required');
  if (proof.format !== 'relative-a-b-v1' || !UUID.test(proof.jobId ?? '') || !Array.isArray(proof.changedFiles)) return fail('trusted_relative_proof_required');
  let cwd, changed, lock;
  const validate = () => {
    cwd = realpathSync(pending.workspace);
    const canonical = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    if (canonical(cwd) !== canonical(pending.workspace) || !statSync(cwd).isDirectory() || lstatSync(pending.workspace).isSymbolicLink() || !roots.some(root => {const rel=relative(realpathSync(root),cwd);return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));})) throw new Error('workspace is not an admitted physical root');
    const scope = compileWriteScope(response.trustedWriteScope);
    if (digest(scope.map(i => `${i.tree?'tree':'file'}:${i.path}`).sort().join('\\n')) !== proof.scopeSha256) throw new Error('scope proof mismatch');
    changed = relativePatchFiles(patch);
    if (!same(changed,proof.changedFiles)) throw new Error('changedFiles do not match patch');
    for (const file of changed) if (!isAllowedPath(assertSafeFilesystemTarget(file,cwd),scope)) throw new Error('path outside write scope');
    const git = lstatSync(resolve(cwd,'.git'));
    if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) throw new Error('unsafe Git repository');
  };
  try {validate();} catch (error) {return fail('artifact_path_unsafe',error.message);}
  try {lock = writeLocks?.tryAcquire({requestId,cwd,writeScope:response.trustedWriteScope,timeoutSeconds:30});} catch (error) {return fail('write_lock_error',error.message);}
  if (!lock) return fail('write_scope_busy');
  try {
    try {validate();} catch (error) {return fail('artifact_path_unsafe',error.message);}
    const check = await runArtifactGit({cwd,args:['apply','--check'],patch,spawnFn});
    if (!check.ok) return {requestId,...check};
    const applied = await runArtifactGit({cwd,args:['apply'],patch,spawnFn});
    if (!applied.ok) return {requestId,...applied};
    return {ok:true,requestId,artifactSha256:pending.artifactSha256,changedFiles:changed};
  } finally {writeLocks.release(lock);}
}
