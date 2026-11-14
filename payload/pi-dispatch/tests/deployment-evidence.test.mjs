import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {captureDeploymentEvidence,previewDeploymentEvidence,verifyDeploymentEvidence,EVIDENCE_LIMITS} from '../scripts/deployment-evidence.mjs';
import {createRequestLedger,previewRequestLedgerRetention} from '../extensions/request-ledger.js';
import {createAuditLogger,previewAuditRetention} from '../extensions/audit-log.js';

const script=fileURLToPath(new URL('../scripts/deployment-evidence.mjs',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-evidence-')),stateRoot=path.join(root,'state');
  fs.mkdirSync(stateRoot);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(rel,value)=>{const p=path.join(stateRoot,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));return p;};
  const old='2000-01-01T00:00:00Z',done={state:'completed',completedAt:old,result:{response:{ok:true}}};
  put('request-ledger/'+'a'.repeat(64)+'/final.json',done);
  put('request-ledger/'+'b'.repeat(64)+'/started.json',{state:'unknown',startedAt:old});
  put('request-ledger/'+'c'.repeat(64)+'/final.json',{...done,state:'failed'});
  put('request-ledger/'+'d'.repeat(64)+'/final.json',done);
  put('request-ledger/host-verification/'+'d'.repeat(64)+'/proof.json',{immutable:true});
  put('request-ledger/result-cache/'+'e'.repeat(64)+'.json',{state:'completed',completedAt:old});
  put('request-ledger/outcomes/'+'f'.repeat(64)+'.json',{state:'completed',contract:{mode:'linked'},completedAt:old});
  put('audit.jsonl','current\n');put('audit.jsonl.critical','critical\n');
  const rotated=put('audit.jsonl.1000000000000-0.jsonl','old audit\n');fs.utimesSync(rotated,new Date(old),new Date(old));
  put('installation-records/failed.json',{status:'failed',rollback:'retain'});
  put('gateway-silent.json',{requestLedgerDir:path.join(stateRoot,'request-ledger'),auditFile:path.join(stateRoot,'audit.jsonl'),token:'private-do-not-copy'});
  put('http-token.txt','private-do-not-copy');
  return {root,stateRoot,put,backupRoot:path.join(root,'backup')};
}
function tree(root) {
  const out={};function visit(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),s=fs.lstatSync(p);out[path.relative(root,p)]={mtime:s.mtimeMs,mode:s.mode,...(s.isFile()?{sha:hash(fs.readFileSync(p))}: {})};if(s.isDirectory())visit(p);}}visit(root);return out;
}
test('preview writes nothing and snapshot retains every expiring/protected/failed byte',t=>{
  const f=fixture(t),before=tree(f.stateRoot),preview=previewDeploymentEvidence(f);
  assert.deepEqual(tree(f.stateRoot),before);assert.equal(preview.cleanupPreview.ledger.deletedEntries,2);assert.equal(preview.cleanupPreview.audit.completed.deletedFiles,1);
  const receipt=captureDeploymentEvidence(f),manifest=JSON.parse(fs.readFileSync(path.join(f.backupRoot,'manifest.json')));
  assert.equal(receipt.fileCount,11);assert.equal(manifest.configurationHashes.length,1);
  assert.equal(fs.existsSync(path.join(f.backupRoot,'data/http-token.txt')),false);
  assert.equal(fs.existsSync(path.join(f.backupRoot,'data/gateway-silent.json')),false);
  for(const item of manifest.files)assert.equal(hash(fs.readFileSync(path.join(f.backupRoot,'data',item.path))),item.sha256);
  const ledger=createRequestLedger(path.join(f.stateRoot,'request-ledger'));ledger.close();
  const audit=createAuditLogger(path.join(f.stateRoot,'audit.jsonl'));audit.close();
  assert.equal(fs.existsSync(path.join(f.stateRoot,'request-ledger/'+'a'.repeat(64))),false);
  for(const id of ['b','c','d'])assert.equal(fs.existsSync(path.join(f.stateRoot,'request-ledger/'+id.repeat(64))),true);
  assert.equal(verifyDeploymentEvidence({...receipt,stateRoot:f.stateRoot}).fileCount,11);
  assert.throws(()=>verifyDeploymentEvidence({...receipt,stateRoot:f.stateRoot,verifySource:true}),/source_changed/);
});
test('snapshot verification detects changed source, archive tamper and manifest tamper',t=>{
  const f=fixture(t),r=captureDeploymentEvidence(f);
  f.put('installation-records/new.json',{status:'failed'});
  assert.throws(()=>verifyDeploymentEvidence({...r,stateRoot:f.stateRoot,verifySource:true}),/source_changed/);
  fs.writeFileSync(path.join(f.backupRoot,'data/audit.jsonl'),'tampered');
  assert.throws(()=>verifyDeploymentEvidence({...r,stateRoot:f.stateRoot}),/copy_mismatch/);
  fs.writeFileSync(path.join(f.backupRoot,'manifest.json'),'{}');
  assert.throws(()=>verifyDeploymentEvidence({...r,stateRoot:f.stateRoot}),/manifest_mismatch/);
});
test('explicit runtime config filenames are hash-bound without copying secrets or expanding evidence roots',t=>{
  const f=fixture(t),runtime=f.put('runtime.json',{requestLedgerDir:path.join(f.stateRoot,'request-ledger'),auditFile:path.join(f.stateRoot,'audit.jsonl')}),settings=f.put('settings.json',{gatewayConfig:runtime,token:'private-do-not-copy'}),configurationPaths=[settings,runtime];
  const r=captureDeploymentEvidence({...f,configurationPaths}),manifest=JSON.parse(fs.readFileSync(path.join(f.backupRoot,'manifest.json')));
  assert.equal(manifest.configurationHashes.length,3);assert.equal(fs.existsSync(path.join(f.backupRoot,'data/settings.json')),false);assert.equal(JSON.stringify(manifest).includes('private-do-not-copy'),false);
  assert.equal(verifyDeploymentEvidence({...r,stateRoot:f.stateRoot,configurationPaths,verifySource:true}).status,'complete');
  assert.throws(()=>previewDeploymentEvidence({...f,configurationPaths:[path.join(f.root,'outside.json')]}),/uncovered_configuration/);
  assert.throws(()=>previewDeploymentEvidence({...f,configurationPaths:[path.join(f.stateRoot,'missing.json')]}),/configuration_missing/);
});
test('safe capture refuses links, hardlinks, oversize, overlap and existing destinations',t=>{
  const f=fixture(t);
  assert.throws(()=>captureDeploymentEvidence({...f,backupRoot:f.stateRoot}),/overlapping/);
  assert.throws(()=>captureDeploymentEvidence({...f,backupRoot:path.join(f.stateRoot,'request-ledger/archive')}),/overlapping/);
  fs.mkdirSync(f.backupRoot);assert.throws(()=>captureDeploymentEvidence(f),/destination_exists/);
  const linked=path.join(f.stateRoot,'request-ledger/hardlink');fs.linkSync(path.join(f.stateRoot,'audit.jsonl'),linked);
  assert.throws(()=>previewDeploymentEvidence(f),/unsafe_path/);fs.unlinkSync(linked);
  const alias=path.join(f.stateRoot,'request-ledger/junction');fs.symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>previewDeploymentEvidence(f),/unsafe_path/);fs.unlinkSync(alias);
  const large=f.put('request-ledger/large','');fs.truncateSync(large,EVIDENCE_LIMITS.fileBytes+1);
  assert.throws(()=>previewDeploymentEvidence(f),/byte_limit/);
});
test('corrupt config blocks capture with retained failure record, without a complete backup',t=>{
  const f=fixture(t);f.put('gateway-silent.json','{ broken');
  assert.throws(()=>captureDeploymentEvidence(f));
  assert.equal(fs.existsSync(path.join(f.backupRoot,'failure.json')),true);
  assert.equal(fs.existsSync(path.join(f.backupRoot,'manifest.json')),false);
});
test('a source file added or modified during capture leaves a failed archive and no usable completion',t=>{
  for(const mode of ['added','modified']) {
    const f=fixture(t),write=fs.writeFileSync;let changed=false;
    fs.writeFileSync=function(file,...args){const result=write.call(fs,file,...args);if(!changed&&String(file).startsWith(path.join(f.backupRoot,'data')+path.sep)){changed=true;f.put(mode==='added'?'installation-records/new.json':'audit.jsonl','concurrent change');}return result;};
    try {assert.throws(()=>captureDeploymentEvidence(f),/source_changed/);}finally{fs.writeFileSync=write;}
    assert(changed);assert.equal(fs.existsSync(path.join(f.backupRoot,'failure.json')),true);assert.equal(fs.existsSync(path.join(f.backupRoot,'manifest.json')),false);
  }
});
test('real CLI preview/snapshot, invalid arguments, corrupt input and missing interpreter',t=>{
  const f=fixture(t),run=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  const empty=path.join(f.root,'no-home/state');
  assert.equal(run(['--state-root',empty,'--preview']).status,0);assert.equal(fs.existsSync(path.dirname(empty)),false);
  for(const args of [[],['--unknown'],['--state-root',f.stateRoot,'--snapshot'],['--state-root',f.stateRoot,'--preview','--snapshot'],['--state-root',f.stateRoot,'--preview','--config-file','relative.json']])assert.equal(run(args).status,2);
  const snap=run(['--state-root',f.stateRoot,'--snapshot','--backup-root',f.backupRoot]);assert.equal(snap.status,0,snap.stderr);assert.equal(JSON.parse(snap.stdout).status,'complete');
  f.put('gateway-silent.json','{invalid');assert.equal(run(['--state-root',f.stateRoot,'--preview']).status,1);
  assert.equal(spawnSync(path.join(f.root,'missing-node'),[script,'--preview']).error.code,'ENOENT');
});
test('real installer PlanOnly previews without creating target home; snapshot precedes replacement', {skip:process.platform!=='win32'},t=>{
  const f=fixture(t),home=path.join(f.root,'empty-home'),installer=fileURLToPath(new URL('../../../install/Install-PiKether.ps1',import.meta.url));
  const r=spawnSync('pwsh',['-NoProfile','-File',installer,'-PlanOnly','-TargetHome',home,'-WorkspaceRoots',f.root,'-SkipWsl','-SkipTunnel','-SkipCodexRegistration'],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/cleanupPreview/);assert.equal(fs.existsSync(home),false);
  const source=fs.readFileSync(installer,'utf8');
  assert(source.indexOf('--snapshot --backup-root')<source.indexOf('$installationSource ='));
  assert(source.indexOf("throw 'Evidence backup failed")<source.indexOf('Copy-WithBackup $installationSource'));
});
test('ledger and audit pure previews share actual age/capacity decisions; malformed state stays protected',t=>{
  const f=fixture(t);f.put('request-ledger/'+'9'.repeat(64)+'/final.json','malformed');
  const root=path.join(f.stateRoot,'request-ledger'),plan=previewRequestLedgerRetention(root,{retention:{totalBytes:0}}),ledger=createRequestLedger(root,{retention:{totalBytes:0}});
  const {candidates,...summary}=plan;assert.deepEqual(ledger.startupRetention,summary);ledger.close();
  assert.equal(fs.existsSync(path.join(root,'9'.repeat(64)+'/final.json')),true);
  const auditPath=path.join(f.stateRoot,'audit.jsonl'),ap=previewAuditRetention(auditPath,{totalBytes:0,criticalTotalBytes:0}),audit=createAuditLogger(auditPath,{totalBytes:0,criticalTotalBytes:0});
  for(const name of ['completed','protectedRecords']){const {candidates,...summary}=ap[name];assert.deepEqual(audit.startupRetention[name],summary);}audit.close();
});
