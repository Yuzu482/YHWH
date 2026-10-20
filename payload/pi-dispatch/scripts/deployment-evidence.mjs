import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {previewRequestLedgerRetention} from '../extensions/request-ledger.js';
import {previewAuditRetention} from '../extensions/audit-log.js';

export const EVIDENCE_LIMITS = Object.freeze({files: 50000, fileBytes: 16 * 1024 * 1024, totalBytes: 512 * 1024 * 1024});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const within = (root, p) => { const r=path.relative(root,p); return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep)); };
const fail = reason => { throw Error(reason); };
const relativeName = p => typeof p==='string' && p.length<=1000 && !/[\\:\x00-\x1f]/.test(p) && p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&!/[. ]$/.test(s)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s));
const auditName = p => /^audit\.jsonl(?:\.critical)?(?:\.\d{13}-\d+\.jsonl)?$/.test(p);
const included = p => relativeName(p) && (p.startsWith('request-ledger/') || p.startsWith('installation-records/') || auditName(p));

// Check every existing component, including parents of a not-yet-created output.
function checked(absolute) {
  if(typeof absolute!=='string'||!path.isAbsolute(absolute))fail('evidence_absolute_path_required');
  if(absolute.split(/[\\/]/).some(p=>p==='..'||p==='.'))fail('evidence_unsafe_path');
  const normalized=path.resolve(absolute), parsed=path.parse(normalized);
  let cursor=parsed.root, missing=false, info=fs.lstatSync(parsed.root);
  for(const part of normalized.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);
    if(missing)continue;
    try { info=fs.lstatSync(cursor); }
    catch(e){if(e.code==='ENOENT'){missing=true;continue;}throw e;}
    if(info.isSymbolicLink()||(!info.isDirectory()&&(!info.isFile()||info.nlink!==1)))fail('evidence_unsafe_path');
  }
  return {path:normalized,exists:!missing,info:missing?null:info};
}
function read(file, maximum=EVIDENCE_LIMITS.fileBytes) {
  const before=checked(file).info;
  if(!before?.isFile()||before.size>maximum)fail('evidence_file_invalid_or_too_large');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
  try {
    const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>maximum||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs||opened.ctimeMs!==before.ctimeMs)fail('evidence_source_changed');
    const bytes=Buffer.alloc(opened.size+1), length=fs.readSync(fd,bytes,0,bytes.length,0), after=fs.fstatSync(fd), named=checked(file).info;
    if(length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||!named||named.dev!==after.dev||named.ino!==after.ino)fail('evidence_source_changed');
    return bytes.subarray(0,length);
  } finally {fs.closeSync(fd);}
}
function walk(root, prefix, output, budget, depth=0) {
  if(depth>128)fail('evidence_depth_limit');
  const location=checked(path.join(root,prefix));
  if(!location.exists)return;
  if(!location.info.isDirectory())fail('evidence_directory_required');
  const names=fs.readdirSync(location.path).sort();
  if(names.length>EVIDENCE_LIMITS.files)fail('evidence_file_count_limit');
  for(const name of names) {
    if(++budget.visited>100000)fail('evidence_entry_count_limit');
    const rel=prefix ? prefix+'/'+name : name;
    if(!relativeName(rel))fail('evidence_unsafe_relative_path');
    const item=checked(path.join(root,rel));
    if(!item.exists)fail('evidence_source_changed');
    if(item.info.isDirectory())walk(root,rel,output,budget,depth+1);
    else add(root,rel,output,budget);
  }
}
function add(root, rel, output, budget) {
  if(output.length>=EVIDENCE_LIMITS.files)fail('evidence_file_count_limit');
  const before=checked(path.join(root,rel)).info, size=before?.size;
  if(!Number.isSafeInteger(size)||size>EVIDENCE_LIMITS.fileBytes||budget.bytes+size>EVIDENCE_LIMITS.totalBytes)fail('evidence_byte_limit');
  const bytes=read(path.join(root,rel)); budget.bytes+=bytes.length;
  const after=checked(path.join(root,rel)).info;
  if(!after||after.dev!==before.dev||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('evidence_source_changed');
  output.push({path:rel,bytes:bytes.length,sha256:hash(bytes),sourceFileId:{dev:after.dev,ino:after.ino,mtimeMs:after.mtimeMs,ctimeMs:after.ctimeMs}});
}
function inventory(stateRoot,configurationPaths=[]) {
  const root=checked(stateRoot);
  if(root.exists&&!root.info.isDirectory())fail('evidence_directory_required');
  const files=[],budget={bytes:0,visited:0}, configurationHashes=[];
  for(const dir of ['request-ledger','installation-records'])walk(root.path,dir,files,budget);
  if(root.exists) {
    const names=fs.readdirSync(root.path).sort();
    if(names.length>100000)fail('evidence_file_count_limit');
    for(const name of names.filter(auditName))add(root.path,name,files,budget);
  }
  let ledgerRetention, auditRetention;
  if(!Array.isArray(configurationPaths)||configurationPaths.length>4)fail('evidence_configuration_limit');
  const configFiles=[...new Set(['silent-runtime.json','gateway-silent.json','gateway.json'].map(n=>path.join(root.path,n)).concat(configurationPaths.map(file=>{
    const safe=checked(file);if(!within(root.path,safe.path)||!relativeName(path.relative(root.path,safe.path).split(path.sep).join('/')))fail('evidence_uncovered_configuration');if(!safe.exists||!safe.info.isFile())fail('evidence_active_configuration_missing');return safe.path;
  })))];
  let activeConfig=path.join(root.path,checked(path.join(root.path,'gateway-silent.json')).exists?'gateway-silent.json':'gateway.json');
  for(const file of configFiles) {
    const name=path.relative(root.path,file).split(path.sep).join('/');if(!checked(file).exists)continue;
    const bytes=read(file,1024*1024);let config;
    try{config=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));if(!config||typeof config!=='object'||Array.isArray(config))throw Error();}catch{fail('evidence_configuration_invalid');}
    const info=checked(file).info;
    configurationHashes.push({path:name,bytes:bytes.length,sha256:hash(bytes),sourceFileId:{dev:info.dev,ino:info.ino,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs}});
    if(config.gatewayConfig) {
      if(typeof config.gatewayConfig!=='string'||!path.isAbsolute(config.gatewayConfig)||!configFiles.some(p=>key(p)===key(path.resolve(config.gatewayConfig))))fail('evidence_uncovered_configuration');
      activeConfig=path.resolve(config.gatewayConfig);if(!checked(activeConfig).exists)fail('evidence_active_configuration_missing');
    }
    if(key(file)===key(activeConfig)) {
      if(config.requestLedgerDir && key(path.resolve(config.requestLedgerDir))!==key(path.join(root.path,'request-ledger')))fail('evidence_uncovered_ledger');
      if(config.auditFile && key(path.resolve(config.auditFile))!==key(path.join(root.path,'audit.jsonl')))fail('evidence_uncovered_audit');
      ledgerRetention=config.ledgerRetention; auditRetention=config.auditRetention;
    }
  }
  return {stateRoot:root.path,files:files.sort((a,b)=>a.path.localeCompare(b.path)),totalBytes:budget.bytes,configurationHashes,ledgerRetention,auditRetention};
}
export function previewDeploymentEvidence({stateRoot, now=Date.now(),configurationPaths=[]}={}) {
  const source=inventory(stateRoot,configurationPaths);
  return {readOnly:true,stateRoot:source.stateRoot,fileCount:source.files.length,totalBytes:source.totalBytes,configurationHashes:source.configurationHashes,
    cleanupPreview:{advisory:true,now,inFlight:'not inspected; capture only after idle pause or with runtime stopped',
      ledger:previewRequestLedgerRetention(path.join(source.stateRoot,'request-ledger'),{now,retention:source.ledgerRetention}),
      audit:previewAuditRetention(path.join(source.stateRoot,'audit.jsonl'),{now,...source.auditRetention})}};
}
function destination(stateRoot, backupRoot) {
  const dest=checked(backupRoot), source=checked(stateRoot).path;
  if(within(dest.path,source)||within(path.join(source,'request-ledger'),dest.path)||within(path.join(source,'installation-records'),dest.path)||auditName(path.relative(source,dest.path)))fail('evidence_overlapping_destination');
  return dest;
}
export function captureDeploymentEvidence({stateRoot,backupRoot,configurationPaths=[]}={}) {
  const dest=destination(stateRoot,backupRoot);
  if(dest.exists)fail('evidence_destination_exists');
  fs.mkdirSync(path.dirname(dest.path),{recursive:true,mode:0o700}); checked(path.dirname(dest.path));
  fs.mkdirSync(dest.path,{mode:0o700});
  try {
    const source=inventory(stateRoot,configurationPaths), preview=previewDeploymentEvidence({stateRoot,configurationPaths});
    for(const item of source.files) {
      const bytes=read(path.join(source.stateRoot,item.path));
      if(hash(bytes)!==item.sha256)fail('evidence_source_changed');
      const target=path.join(dest.path,'data',item.path);
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700}); checked(path.dirname(target));
      fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
      if(hash(read(target))!==item.sha256)fail('evidence_copy_mismatch');
    }
    // An inventory comparison catches additions/removals as well as modifications.
    if(JSON.stringify(inventory(stateRoot,configurationPaths))!==JSON.stringify(source))fail('evidence_source_changed');
    const manifest={schemaVersion:1,status:'complete',createdAt:new Date().toISOString(),stateRoot:source.stateRoot,files:source.files,totalBytes:source.totalBytes,configurationHashes:source.configurationHashes,cleanupPreview:preview.cleanupPreview};
    const bytes=JSON.stringify(manifest,null,2)+'\n', temporary=path.join(dest.path,'manifest.pending.json');
    fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});
    fs.renameSync(temporary,path.join(dest.path,'manifest.json'));
    const receipt={status:'complete',backupRoot:dest.path,manifestSha256:hash(bytes),fileCount:source.files.length,totalBytes:source.totalBytes};
    verifyDeploymentEvidence({...receipt,stateRoot,configurationPaths,verifySource:true});
    return receipt;
  } catch(e) {
    // Preserve failed copies. A failure marker always invalidates any manifest.
    try{fs.writeFileSync(path.join(dest.path,'failure.json'),JSON.stringify({status:'failed',reason:e.message,at:new Date().toISOString()}),{flag:'wx',mode:0o600});}catch{}
    throw e;
  }
}
export function verifyDeploymentEvidence({backupRoot,stateRoot,manifestSha256,verifySource=false,configurationPaths=[]}={}) {
  const dest=destination(stateRoot,backupRoot);
  if(checked(path.join(dest.path,'failure.json')).exists)fail('evidence_incomplete');
  const bytes=read(path.join(dest.path,'manifest.json'),16*1024*1024);
  if(!/^[a-f0-9]{64}$/.test(manifestSha256??'')||hash(bytes)!==manifestSha256)fail('evidence_manifest_mismatch');
  const m=JSON.parse(bytes);
  if(m.schemaVersion!==1||m.status!=='complete'||key(m.stateRoot)!==key(path.resolve(stateRoot))||!Array.isArray(m.files)||m.files.length>EVIDENCE_LIMITS.files||!Array.isArray(m.configurationHashes))fail('evidence_manifest_invalid');
  let totalBytes=0; const seen=new Set();
  for(const item of m.files) {
    if(!included(item.path)||seen.has(key(item.path))||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>EVIDENCE_LIMITS.fileBytes||!/^[a-f0-9]{64}$/.test(item.sha256))fail('evidence_manifest_invalid');
    seen.add(key(item.path)); totalBytes+=item.bytes;
    if(totalBytes>EVIDENCE_LIMITS.totalBytes)fail('evidence_byte_limit');
    const data=read(path.join(dest.path,'data',item.path));
    if(data.length!==item.bytes||hash(data)!==item.sha256)fail('evidence_copy_mismatch');
  }
  if(totalBytes!==m.totalBytes)fail('evidence_manifest_invalid');
  if(verifySource) {
    const source=inventory(stateRoot,configurationPaths);
    if(JSON.stringify(source.files)!==JSON.stringify(m.files)||JSON.stringify(source.configurationHashes)!==JSON.stringify(m.configurationHashes))fail('evidence_source_changed');
  }
  return {status:'complete',backupRoot:dest.path,manifestSha256,fileCount:m.files.length,totalBytes};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let values;
  try {
    ({values}=parseArgs({options:{'state-root':{type:'string'},'backup-root':{type:'string'},'config-file':{type:'string',multiple:true},preview:{type:'boolean'},snapshot:{type:'boolean'}},strict:true}));
    if(!values['state-root']||!path.isAbsolute(values['state-root'])||!!values.preview===!!values.snapshot||(values.snapshot&&(!values['backup-root']||!path.isAbsolute(values['backup-root'])))||(values.preview&&values['backup-root']))throw Error();
    if((values['config-file']??[]).length>4||(values['config-file']??[]).some(file=>!path.isAbsolute(file)))throw Error();
  } catch {console.error('Usage: node deployment-evidence.mjs --state-root ABS [--config-file ABS_JSON] (--preview | --snapshot --backup-root NEW_ABS)');process.exitCode=2;}
  if(values&&process.exitCode!==2)try {
    const options={stateRoot:values['state-root'],configurationPaths:values['config-file']??[]};
    console.log(JSON.stringify(values.preview?previewDeploymentEvidence(options):captureDeploymentEvidence({...options,backupRoot:values['backup-root']}),null,2));
  } catch(e) {console.error(JSON.stringify({status:'blocked',reason:e.message}));process.exitCode=1;}
}
