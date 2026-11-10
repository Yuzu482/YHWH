import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureMetadata, supplementCatalog, preflightPrevious } from './ensure-pi-model-metadata.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kether-model-metadata-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const agent=path.join(root,'agent'),ai=path.join(agent,'node_modules','@earendil-works','pi-ai');
  const data=path.join(ai,'dist','providers','data');fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(agent,'package.json'),JSON.stringify({name:'@earendil-works/pi-coding-agent',version:'0.84.4'}));
  fs.writeFileSync(path.join(ai,'package.json'),JSON.stringify({name:'@earendil-works/pi-ai',version:'0.84.4'}));
  const base=id=>({id,name:id,api:'openai-codex-responses',provider:'openai-codex',baseUrl:'https://chatgpt.com/backend-api',
    reasoning:true,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:128000,
    thinkingLevelMap:{xhigh:'xhigh',max:'max',minimal:'low'},compat:{supportsAdditionalTools:true}});
  const provider={'gpt-5.5':{...base('gpt-5.5'),compat:{supportsOpenAIGrammarTools:true,supportsToolSearch:true}},
    'gpt-5.6-luna':base('gpt-5.6-luna'),'gpt-5.6-sol':base('gpt-5.6-sol'),'gpt-5.6-terra':base('gpt-5.6-terra'),
    'user-existing-model':{id:'user-existing-model',custom:true}};
  const catalog={'openai-codex-responses':provider,otherProvider:{keep:'unchanged'}};
  const target=path.join(data,'openai-codex.json'),before=Buffer.from(JSON.stringify(catalog,null,2)+'\n');
  fs.writeFileSync(target,before);
  return {root,agent,ai,target,before,catalog,backup:path.join(root,'catalog.backup.json')};
}

test('adds only missing entries, retains the old bytes for rollback, and is idempotent',t=>{
  const f=fixture(t);
  assert.throws(()=>ensureMetadata(f.agent,{check:true}),/missing_model_metadata/);
  const result=ensureMetadata(f.agent,{backup:f.backup});
  assert.equal(result.status,'updated');
  assert.deepEqual(result.added,['gpt-6-luna','gpt-6-sol','gpt-6.1-terra']);
  assert.deepEqual(fs.readFileSync(f.backup),f.before);
  const updated=fs.readFileSync(f.target),actual=JSON.parse(updated);
  for(const [id,value] of Object.entries(f.catalog['openai-codex-responses'])) assert.deepEqual(actual['openai-codex-responses'][id],value);
  assert.deepEqual(actual.otherProvider,f.catalog.otherProvider);
  assert.equal(actual['openai-codex-responses']['gpt-6.1-terra'].contextWindow,500000);
  assert.equal(actual['openai-codex-responses']['gpt-6.1-terra'].compat.supportsToolSearch,true);
  const second=ensureMetadata(f.agent,{check:true});assert.equal(second.status,'unchanged');
  assert.deepEqual(fs.readFileSync(f.target),updated);
  fs.copyFileSync(f.backup,f.target);
  assert.deepEqual(fs.readFileSync(f.target),f.before);
  assert.throws(()=>ensureMetadata(f.agent,{check:true}),/missing_model_metadata/);
});

test('conflicts and unsupported package versions fail without touching the catalog or backup',t=>{
  const f=fixture(t),p=f.catalog['openai-codex-responses'];
  p['gpt-6-luna']={id:'gpt-6-luna',custom:'preserve'};
  const conflict=Buffer.from(JSON.stringify(f.catalog));fs.writeFileSync(f.target,conflict);
  assert.throws(()=>ensureMetadata(f.agent,{backup:f.backup}),/conflicting_model_metadata:gpt-6-luna/);
  assert.deepEqual(fs.readFileSync(f.target),conflict);assert.equal(fs.existsSync(f.backup),false);
  fs.writeFileSync(path.join(f.ai,'package.json'),JSON.stringify({name:'@earendil-works/pi-ai',version:'0.85.0'}));
  assert.throws(()=>ensureMetadata(f.agent,{backup:f.backup}),/unsupported_pi_version/);
  assert.deepEqual(fs.readFileSync(f.target),conflict);
});

test('rejects unsafe hard links, pre-existing backups and incomplete templates before writing',t=>{
  const f=fixture(t);
  fs.writeFileSync(f.backup,'existing');
  assert.throws(()=>ensureMetadata(f.agent,{backup:f.backup}),/backup_path_already_exists/);
  assert.deepEqual(fs.readFileSync(f.target),f.before);
  fs.unlinkSync(f.backup);
  const link=path.join(f.root,'catalog-hardlink.json');fs.linkSync(f.target,link);
  assert.throws(()=>ensureMetadata(f.agent,{backup:f.backup}),/unsafe_file/);
  fs.unlinkSync(link);
  const invalid=JSON.parse(f.before);delete invalid['openai-codex-responses']['gpt-5.6-terra'];
  assert.throws(()=>supplementCatalog(Buffer.from(JSON.stringify(invalid))),/unsupported_model_template/);
  assert.deepEqual(fs.readFileSync(f.target),f.before);assert.equal(fs.existsSync(f.backup),false);
});

test('preserves non-conflicting old custom models and fails closed on conflicting old metadata',t=>{
  const f=fixture(t),previous=structuredClone(f.catalog);
  previous['openai-codex-responses']['custom-model']={id:'custom-model',contextWindow:1234};
  previous['custom-group']={'custom-other':{id:'custom-other'}};
  const prior=path.join(f.root,'previous.json');fs.writeFileSync(prior,JSON.stringify(previous));
  assert.equal(preflightPrevious(fs.readFileSync(prior)).status,'compatible');
  const result=ensureMetadata(f.agent,{backup:f.backup,previous:prior});assert.equal(result.preservedCount,2);
  const merged=JSON.parse(fs.readFileSync(f.target));
  assert.deepEqual(merged['openai-codex-responses']['custom-model'],previous['openai-codex-responses']['custom-model']);
  assert.deepEqual(merged['custom-group'],previous['custom-group']);

  const g=fixture(t),changed=structuredClone(g.catalog);
  changed['openai-codex-responses']['gpt-5.6-luna'].contextWindow=42;
  const old=path.join(g.root,'previous.json');fs.writeFileSync(old,JSON.stringify(changed));
  assert.throws(()=>ensureMetadata(g.agent,{backup:g.backup,previous:old}),/conflicting_previous_model_metadata:gpt-5.6-luna/);
  assert.deepEqual(fs.readFileSync(g.target),g.before);assert.equal(fs.existsSync(g.backup),false);
  const conflicting=JSON.parse(supplementCatalog(g.before).contents);
  conflicting['openai-codex-responses']['gpt-6-luna'].contextWindow=42;
  assert.throws(()=>preflightPrevious(Buffer.from(JSON.stringify(conflicting))),/conflicting_model_metadata:gpt-6-luna/);
});

test('preserves POSIX owner and mode for an isolated catalog', {skip:process.platform==='win32'}, t=>{
  const f=fixture(t);fs.chmodSync(f.target,0o640);
  const before=fs.statSync(f.target);ensureMetadata(f.agent,{backup:f.backup});const after=fs.statSync(f.target);
  assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);assert.equal(after.mode & 0o7777,before.mode & 0o7777);
});

test('preserves protected Windows ACL and owner in both replacement and backup', {skip:process.platform!=='win32'}, t=>{
  const f=fixture(t),script=path.join(f.root,'acl.ps1');
  fs.writeFileSync(script,`param([string]$File,[string]$Action)\n$ErrorActionPreference='Stop'\n$a=Get-Acl -LiteralPath $File\nif($Action -eq 'protect'){$a.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $File -AclObject $a;$a=Get-Acl -LiteralPath $File}\n[Console]::Write($a.Sddl)`);
  const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const acl=(file,action)=>execFileSync(ps,['-NoProfile','-NonInteractive','-File',script,file,action],{env,windowsHide:true}).toString();
  const before=acl(f.target,'protect');ensureMetadata(f.agent,{backup:f.backup});
  assert.equal(acl(f.target,'read'),before);assert.equal(acl(f.backup,'read'),before);
});

test('Windows ACL assignment failure occurs before the original catalog is replaced', {skip:process.platform!=='win32'}, t=>{
  const f=fixture(t),candidate=path.join(path.dirname(f.target),'candidate.json');
  fs.writeFileSync(candidate,supplementCatalog(f.before).contents);
  const wrapper=path.join(f.root,'deny-acl.ps1');
  fs.writeFileSync(wrapper,`param($Helper,$Target,$Candidate,$Backup,$Before,$After)\nfunction global:Set-Acl { throw 'simulated_owner_assignment_denied' }\n& $Helper -Target $Target -Candidate $Candidate -Backup $Backup -BeforeSha256 $Before -AfterSha256 $After\nif(-not $?) { exit 1 }`);
  const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const helper=path.join(path.dirname(fileURLToPath(import.meta.url)),'replace-pi-model-catalog.ps1');
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.throws(()=>execFileSync(ps,['-NoProfile','-NonInteractive','-File',wrapper,helper,f.target,candidate,f.backup,sha(f.before),sha(fs.readFileSync(candidate))],{env,windowsHide:true,stdio:'pipe'}));
  assert.deepEqual(fs.readFileSync(f.target),f.before);assert.equal(fs.existsSync(f.backup),false);
});

test('both installers back up the old catalog before npm ci and supplement the new catalog afterward',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const win=fs.readFileSync(path.join(here,'Install-PiKether.ps1'),'utf8');
  const wsl=fs.readFileSync(path.join(here,'provision-wsl.sh'),'utf8');
  const host=win.slice(win.indexOf('$hostPiRoot ='));
  const winBackup=host.indexOf("'windows-before-npm-ci.json'");
  const winCi=host.indexOf("'npm.cmd') ci --omit=dev");
  const winPreflight=host.indexOf('--preflight');
  const winEnsure=host.indexOf("'install\\ensure-pi-model-metadata.mjs'",winCi);
  assert(winBackup>=0 && winBackup<winPreflight && winPreflight<winCi && winCi<winEnsure);
  assert(winPreflight<host.indexOf('$hostPackage ='));
  assert.match(win,/ensure-pi-model-metadata\.mjs'\)='\/tmp\/pi-kether-install\/ensure-pi-model-metadata\.mjs'/);
  const wslBackup=wsl.indexOf('wsl-before-npm-ci.json'),wslCi=wsl.indexOf('npm ci --omit=dev');
  const wslPreflight=wsl.indexOf('--preflight'),wslEnsure=wsl.indexOf('/tmp/pi-kether-install/ensure-pi-model-metadata.mjs',wslCi);
  assert(wslBackup>=0 && wslBackup<wslPreflight && wslPreflight<wslCi && wslCi<wslEnsure);
  assert(wslPreflight<wsl.indexOf('cat >/opt/pi-kether/package.json'));
  assert.match(host,/--previous/);assert.match(wsl,/--previous/);
  const replacement=fs.readFileSync(path.join(here,'replace-pi-model-catalog.ps1'),'utf8');
  assert(replacement.indexOf('Set-Acl -LiteralPath $Candidate') < replacement.indexOf('[IO.File]::Replace('));
});
