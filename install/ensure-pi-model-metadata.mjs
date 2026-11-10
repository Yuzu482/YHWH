// SPDX-License-Identifier: Apache-2.0
// Reapply local compatibility metadata after the pinned Pi package is installed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const version = '0.84.4';
const providerKey = 'openai-codex-responses';
const specs = [
  { id:'gpt-6-luna', name:'GPT-6 Luna', base:'gpt-5.6-luna', contextWindow:272000,
    cost:{input:0.1,output:0.5,cacheRead:0.01,cacheWrite:0.125,tiers:[{inputTokensAbove:272000,input:0.2,output:0.75,cacheRead:0.02,cacheWrite:0.25}]} },
  { id:'gpt-6-sol', name:'GPT-6 Sol', base:'gpt-5.6-sol', contextWindow:272000,
    cost:{input:2,output:10,cacheRead:0.2,cacheWrite:2.5,tiers:[{inputTokensAbove:272000,input:4,output:15,cacheRead:0.4,cacheWrite:5}]} },
  { id:'gpt-6.1-terra', name:'GPT-6.1 Terra', base:'gpt-5.6-terra', contextWindow:500000,
    cost:{input:1,output:5,cacheRead:0.05,cacheWrite:1.25,tiers:[{inputTokensAbove:272000,input:2,output:7.5,cacheRead:0.1,cacheWrite:2.5}]} },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) { throw new Error(message); }

// Preserve existing entries verbatim. A conflicting entry requires operator review.
export function supplementCatalog(bytes, previousBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) fail('invalid_catalog_size');
  const catalog = JSON.parse(bytes.toString('utf8'));
  const provider = catalog?.[providerKey];
  const compat = provider?.['gpt-5.5']?.compat;
  if (!object(catalog) || !object(provider) || !object(compat) || compat.supportsToolSearch !== true) fail('unsupported_catalog');
  const additions=[];
  for (const spec of specs) {
    const base=provider[spec.base];
    if (!object(base) || base.id !== spec.base || base.api !== providerKey || base.provider !== 'openai-codex' ||
        base.baseUrl !== 'https://chatgpt.com/backend-api' || base.reasoning !== true || !Array.isArray(base.input)) fail('unsupported_model_template:'+spec.base);
    const expected={...structuredClone(base),id:spec.id,name:spec.name,cost:structuredClone(spec.cost),
      contextWindow:spec.contextWindow,maxTokens:128000,compat:structuredClone(compat)};
    if (Object.hasOwn(provider,spec.id)) {
      if (!isDeepStrictEqual(provider[spec.id],expected)) fail('conflicting_model_metadata:'+spec.id);
    } else {
      provider[spec.id]=expected;
      additions.push(spec.id);
    }
  }
  let preservedCount=0;
  if (previousBytes !== undefined) {
    if (!Buffer.isBuffer(previousBytes) || previousBytes.length > 1024 * 1024) fail('invalid_previous_catalog_size');
    const previous=JSON.parse(previousBytes.toString('utf8'));
    if (!object(previous)) fail('unsupported_previous_catalog');
    for (const [group,entries] of Object.entries(previous)) {
      if (!object(entries)) fail('unsupported_previous_catalog_group');
      if (!Object.hasOwn(catalog,group)) {
        Object.defineProperty(catalog,group,{value:structuredClone(entries),enumerable:true,writable:true,configurable:true});
        preservedCount+=Object.keys(entries).length;
        continue;
      }
      if (!object(catalog[group])) fail('conflicting_catalog_group');
      for (const [id,value] of Object.entries(entries)) {
        if (Object.hasOwn(catalog[group],id)) {
          if (!isDeepStrictEqual(catalog[group][id],value)) fail('conflicting_previous_model_metadata:'+id);
        } else {
          Object.defineProperty(catalog[group],id,{value:structuredClone(value),enumerable:true,writable:true,configurable:true});
          preservedCount++;
        }
      }
    }
  }
  return { additions, preservedCount, contents: additions.length || preservedCount ? Buffer.from(JSON.stringify(catalog)+'\n') : bytes };
}

export function preflightPrevious(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024) fail('invalid_previous_catalog_size');
  const catalog=JSON.parse(bytes.toString('utf8'));
  const provider=catalog?.[providerKey];
  if (!object(catalog) || !object(provider)) fail('unsupported_previous_catalog');
  const present=specs.filter(spec=>Object.hasOwn(provider,spec.id)).map(spec=>spec.id);
  if (present.length) supplementCatalog(bytes);
  return {status:'compatible',knownModels:present};
}

function regularFile(file) {
  const stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('unsafe_file:'+file);
  return stat;
}
function directory(dir) {
  const stat=fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_directory:'+dir);
}
function packageFile(file, expectedName) {
  regularFile(file);
  const pkg=JSON.parse(fs.readFileSync(file,'utf8'));
  if (pkg.name !== expectedName || pkg.version !== version) fail('unsupported_pi_version:'+expectedName);
}
function run(file,args) {
  const env={...process.env};
  if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toLowerCase()==='psmodulepath') delete env[key];
  const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true,env});
  if (result.error || result.status !== 0) fail('metadata_replace_failed:'+(result.error?.message || result.stderr.trim() || result.status));
}
function writeSynced(file,contents,flags) {
  const fd=fs.openSync(file,flags);
  try { fs.ftruncateSync(fd,0);fs.writeFileSync(fd,contents);fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function ensureMetadata(agentRoot, {check=false, backup, previous}={}) {
  if (!path.isAbsolute(agentRoot)) fail('agent_root_must_be_absolute');
  const root=path.resolve(agentRoot);
  const ai=path.join(root,'node_modules','@earendil-works','pi-ai');
  for (const dir of [root,path.join(root,'node_modules'),path.join(root,'node_modules','@earendil-works'),ai,
    path.join(ai,'dist'),path.join(ai,'dist','providers'),path.join(ai,'dist','providers','data')]) directory(dir);
  packageFile(path.join(root,'package.json'),'@earendil-works/pi-coding-agent');
  packageFile(path.join(ai,'package.json'),'@earendil-works/pi-ai');
  const target=path.join(ai,'dist','providers','data','openai-codex.json');
  const stat=regularFile(target), before=fs.readFileSync(target);
  if (previous !== undefined) { if (!path.isAbsolute(previous)) fail('absolute_previous_path_required');regularFile(previous); }
  const planned=supplementCatalog(before,previous === undefined ? undefined : fs.readFileSync(previous));
  if (!planned.additions.length && !planned.preservedCount) return {status:'unchanged',sha256:sha(before),models:specs.map(s=>s.id)};
  if (check) fail('missing_model_metadata:'+planned.additions.join(','));
  if (!backup || !path.isAbsolute(backup)) fail('absolute_backup_path_required');
  const backupPath=path.resolve(backup);
  directory(path.dirname(backupPath));
  try { fs.lstatSync(backupPath); fail('backup_path_already_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (backupPath === target) fail('backup_path_already_exists');
  const temporary=path.join(path.dirname(target),`.kether-models-${randomUUID()}.tmp`);
  let madeTemporary=false;
  try {
    if (process.platform === 'win32') {
      writeSynced(temporary,planned.contents,'wx');madeTemporary=true;
      const helper=path.join(path.dirname(fileURLToPath(import.meta.url)),'replace-pi-model-catalog.ps1');
      const powershell=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,
        '-Target',target,'-Candidate',temporary,'-Backup',backupPath,'-BeforeSha256',sha(before),'-AfterSha256',sha(planned.contents)]);
      madeTemporary=false;
    } else {
      // GNU cp carries mode, ownership and extended ACL metadata into the replacement.
      madeTemporary=true;
      run('cp',['--archive','--no-clobber','--',target,temporary]);
      regularFile(temporary);
      if (sha(fs.readFileSync(temporary)) !== sha(before)) fail('temporary_copy_mismatch');
      writeSynced(temporary,planned.contents,'r+');
      const copied=fs.statSync(temporary);
      if (copied.uid !== stat.uid || copied.gid !== stat.gid || (copied.mode & 0o7777) !== (stat.mode & 0o7777)) fail('replacement_metadata_changed');
      const current=regularFile(target);
      if (current.dev !== stat.dev || current.ino !== stat.ino || sha(fs.readFileSync(target)) !== sha(before)) fail('catalog_changed_before_switch');
      run('cp',['--archive','--no-clobber','--',target,backupPath]);
      if (sha(fs.readFileSync(backupPath)) !== sha(before)) fail('backup_readback_mismatch');
      fs.renameSync(temporary,target);madeTemporary=false;
    }
    if (sha(fs.readFileSync(target)) !== sha(planned.contents) || sha(fs.readFileSync(backupPath)) !== sha(before)) fail('catalog_postcheck_failed');
    return {status:'updated',added:planned.additions,preservedCount:planned.preservedCount,sha256:sha(planned.contents),backup:backupPath,backupSha256:sha(before)};
  } finally {
    if (madeTemporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if (args[0] === '--preflight' && args.length === 2) {
      if (!path.isAbsolute(args[1])) fail('absolute_previous_path_required');
      regularFile(args[1]);console.log(JSON.stringify(preflightPrevious(fs.readFileSync(args[1]))));
    } else if (args[0] === '--check' && args.length === 2) {
      console.log(JSON.stringify(ensureMetadata(args[1],{check:true})));
    } else {
      if (!(args.length === 2 || (args.length === 4 && args[2] === '--previous'))) fail('usage: ensure-pi-model-metadata.mjs [--check] <agent-root> [backup-path] [--previous <old-catalog>]');
      console.log(JSON.stringify(ensureMetadata(args[0],{backup:args[1],previous:args[3]})));
    }
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
