import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const MARKER = '.yhwh-managed-files.json';
const MAX_FILE = 16 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
const excluded = value => value.split('/').some(s =>
  ['node_modules','.git','.test','.runtime','diagnostics','__pycache__'].includes(s) ||
  s.startsWith('.env') || s.includes('.local.') || /\.(log|bak|backup|pyc)$/.test(s) || /^(?:.*token|.*key).*\.txt$/i.test(s)) ||
  ['.mcp.json',MARKER,'auth.json','provider-config.json','provider-credentials.json','anthropic-api-key.json'].includes(path.posix.basename(value));
function validPath(value) {
  return typeof value === 'string' && value.length <= 512 && value.length > 0 &&
    !/[\\:\x00-\x1f\x7f-\x9f\u2028\u2029~]/.test(value) && !path.posix.isAbsolute(value) && !excluded(value) &&
    value.split('/').every(s => s && s !== '.' && s !== '..' && !/[. ]$/.test(s) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
}
function safeFile(root, relative) {
  let current = path.parse(root).root;
  const parts = [...root.slice(current.length).split(path.sep).filter(Boolean), ...relative.split('/')];
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1))
      throw new Error('unsafe-file');
  }
  const real = fs.realpathSync(current), rel = path.relative(fs.realpathSync(root), real);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw new Error('unsafe-file');
  return current;
}
function readBounded(file, maximum, hashOnly = false, consume) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink > 1 || before.size > maximum) throw new Error('file-limit-or-unsafe');
    const digest = createHash('sha256'), chunks = [], buffer = Buffer.alloc(65536);
    let total = 0, read;
    while (total < before.size && (read = fs.readSync(fd, buffer, 0, Math.min(buffer.length,before.size-total), null)) > 0) {
      total += read;
      consume?.(read);
      if (total > maximum) throw new Error('file-limit-or-unsafe');
      if (hashOnly) digest.update(buffer.subarray(0,read));
      else chunks.push(Buffer.from(buffer.subarray(0,read)));
    }
    const after = fs.fstatSync(fd);
    if (total !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('changed-during-check');
    return {value:hashOnly ? digest.digest('hex') : Buffer.concat(chunks).toString('utf8'), bytes:total};
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Bounded synchronous startup evidence; the mutable marker is not a trust anchor.
export function inspectInstallIntegrity(pluginRoot, {requireInstalled = false} = {}) {
  const result = {state:'not-installed',checkedAt:new Date().toISOString(),checkedFiles:0,driftCount:0,drift:[],truncated:false,
    scope:'startup snapshot of installation-managed files; mutable manifest, not tamper-proof or continuous monitoring'};
  const drift = (relative, reason) => {
    result.state = 'drift'; result.code = 'PI_INSTALL_DRIFT'; result.driftCount++;
    if (result.drift.length < 100) result.drift.push({path:relative,reason}); else result.truncated = true;
  };
  try {
    if (typeof pluginRoot !== 'string' || !path.isAbsolute(pluginRoot)) throw new Error('invalid-root');
    const root = path.resolve(pluginRoot);
    let markerExists = true;
    try { fs.lstatSync(path.join(root,MARKER)); } catch (error) { if (error.code === 'ENOENT') markerExists = false; else throw error; }
    if (!markerExists) {
      let provenanceExists = true;
      try { fs.lstatSync(path.join(root,'build-provenance.json')); } catch (error) { if (error.code === 'ENOENT') provenanceExists = false; else throw error; }
      if (requireInstalled || provenanceExists) drift(MARKER,'missing-manifest');
      return result;
    }
    const marker = JSON.parse(readBounded(safeFile(root,MARKER),1024*1024).value);
    if (!marker || marker.schemaVersion !== 1 || Object.keys(marker).some(k => !['schemaVersion','files'].includes(k)) ||
        !marker.files || typeof marker.files !== 'object' || Array.isArray(marker.files)) throw new Error('invalid-manifest');
    const entries = Object.entries(marker.files);
    if (!entries.length || entries.length > 4096) throw new Error('manifest-entry-limit');
    const seen = new Set();
    for (const [relative,hash] of entries) {
      if (!validPath(relative) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash) || seen.has(relative.toLowerCase())) throw new Error('unsafe-manifest-entry');
      seen.add(relative.toLowerCase());
    }
    result.state = 'verified'; let bytes = 0;
    for (const [relative,expected] of entries) {
      if (bytes >= MAX_TOTAL) { drift(MARKER,'total-byte-limit'); result.truncated = true; break; }
      try {
        const actual = readBounded(safeFile(root,relative),Math.min(MAX_FILE,MAX_TOTAL-bytes),true,n => { bytes += n; });
        result.checkedFiles++;
        if (actual.value !== expected.toLowerCase()) drift(relative,'hash-mismatch');
      } catch (error) {
        const reason = error.code === 'ENOENT' ? 'missing-file' :
          ['unsafe-file','file-limit-or-unsafe','changed-during-check'].includes(error.message) ? error.message : 'unreadable-file';
        drift(relative,reason);
        if (reason === 'file-limit-or-unsafe') result.truncated = true;
      }
    }
  } catch { drift(MARKER,'invalid-or-unreadable-manifest'); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values,positionals} = parseArgs({options:{'plugin-root':{type:'string'},'require-installed':{type:'boolean'}},allowPositionals:false});
    if (!values['plugin-root'] || positionals.length) throw new Error('usage');
    const result = inspectInstallIntegrity(values['plugin-root'],{requireInstalled:values['require-installed'] === true});
    console.log(JSON.stringify(result)); process.exitCode = result.state === 'drift' ? 1 : 0;
  } catch { console.error('Usage: install-integrity.mjs --plugin-root ABSOLUTE_PATH [--require-installed]'); process.exitCode = 2; }
}
