// Trusted Windows admission + Linux root broker. Never imported by model extensions.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {authorizeRunChecks,validateVerify} from './check-policy.mjs';
import {redactSensitiveText} from '../extensions/audit-log.js';
const exec=promisify(execFile);
export const CHECK_FRAME='YHWH_RUN_CHECK_RPC=';
export const RECEIPT_FRAME='PI_RUN_CHECK_RECEIPT_V1=';
export const CHECK_LIMITS=Object.freeze({timeMs:120000,outputBytes:262144,pids:64,calls:8,receiptBytes:16384,frames:9});
const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v);
const requestId=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const rel=v=>typeof v==='string'&&v.length<=1024&&!v.includes('\\')&&!v.includes(':')&&!/[\x00-\x1f\x7f]/.test(v)&&v.split('/').every(s=>s&&s!=='.'&&s!=='..');
const sign=(key,payload)=>createHmac('sha256',key).update(JSON.stringify(payload)).digest('hex');
export function validateCheckRequest(v){
  if(!exact(v,['checkId','commandId'])||!Number.isSafeInteger(v.checkId)||v.checkId<1||v.checkId>8||!id(v.commandId))throw Error('CHECK_RPC_REJECTED');
  return v;
}
export function createReceiptCollector({key,requestId:rid,jobId}){
  let pending='',sequence=0,chain='0'.repeat(64),terminal=null,failure=null,bytes=0;
  const receipts=[];
  const reject=()=>{failure='PI_CHECK_EVIDENCE_INVALID';};
  const line=line=>{
    try{
      if(!line.startsWith(RECEIPT_FRAME))throw Error();
      if(Buffer.byteLength(line)>CHECK_LIMITS.receiptBytes)throw Error();
      const frame=JSON.parse(line.slice(RECEIPT_FRAME.length));
      if(!exact(frame,['payload','signature'])||!digest(frame.signature)||!frame.payload)throw Error();
      const p=frame.payload,signature=sign(key,p);
      if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(frame.signature,'hex'))||p.version!==1||p.requestId!==rid||p.jobId!==jobId||p.evidenceKind!=='sandboxEvidence'||terminal)throw Error();
      if(p.type==='terminal'){
        if(!exact(p,['version','requestId','jobId','evidenceKind','type','attempts','chain','cleanupOk','brokerExitCode'])||p.attempts!==sequence||p.chain!==chain||typeof p.cleanupOk!=='boolean'||!Number.isInteger(p.brokerExitCode))throw Error();
        terminal=p;if(!p.cleanupOk||p.brokerExitCode!==0)failure='PI_CHECK_EVIDENCE_INCOMPLETE';
      }else{
        const keys=['version','requestId','jobId','evidenceKind','type','callId','commandId','argv','cwd','taskSha256','policySha256','trustSha256','cacheSha256','snapshotSha256','startedAt','endedAt','exitCode','signal','reason','outputBytes','outputSha256','outputSummary','cleanupOk'];
        if(!exact(p,keys)||p.type!=='call'||p.callId!==sequence+1||++sequence>8||!id(p.commandId)||!Array.isArray(p.argv)||p.argv.length>32||p.argv.some(s=>typeof s!=='string'||Buffer.byteLength(s)>2048)||typeof p.cwd!=='string'||p.cwd.length>1024||!['taskSha256','policySha256','trustSha256','cacheSha256','snapshotSha256','outputSha256'].every(k=>digest(p[k])||(['snapshotSha256','cacheSha256'].includes(k)&&p[k]===null))||![p.startedAt,p.endedAt].every(s=>typeof s==='string'&&Number.isFinite(Date.parse(s)))||(p.exitCode!==null&&!Number.isInteger(p.exitCode))||(p.signal!==null&&typeof p.signal!=='string')||(p.reason!==null&&typeof p.reason!=='string')||!Number.isSafeInteger(p.outputBytes)||p.outputBytes<0||typeof p.outputSummary!=='string'||Buffer.byteLength(p.outputSummary)>4096||typeof p.cleanupOk!=='boolean')throw Error();
        chain=hash(chain+JSON.stringify(frame));receipts.push(p);if(!p.cleanupOk)failure='PI_CHECK_EVIDENCE_INCOMPLETE';
      }
    }catch{reject();}
  };
  return{
    feed(chunk){
      if(failure)return;
      bytes+=Buffer.byteLength(chunk);pending+=chunk;
      if(bytes>131072){reject();return;}
      let at;while((at=pending.indexOf('\n'))>=0){line(pending.slice(0,at));pending=pending.slice(at+1);}
      if(Buffer.byteLength(pending)>CHECK_LIMITS.receiptBytes)reject();
    },
    close(){if(pending||!terminal)failure??='PI_CHECK_EVIDENCE_INCOMPLETE';key.fill(0);return{ok:!failure,evidenceKind:'sandboxEvidence',receipts,terminal,failure};},
  };
}
const candidateConfigs=new WeakSet();
export function createCandidateCheckConfiguration({candidateSha256,policyPath,trustSha256}){
  if(!digest(candidateSha256)||!digest(trustSha256)||typeof policyPath!=='string'||!path.isAbsolute(policyPath))throw Error('CHECK_CANDIDATE_CONFIGURATION');
  const prefix='/var/lib/pi-kether-candidates/'+candidateSha256+'/root';
  const config=Object.freeze({prefix,launcher:prefix+'/sandbox/pi-kether-sandbox',trustRoot:prefix+'/trust',policyPath,trustSha256,groupPrefix:'yhwh-check-test-'+candidateSha256.slice(0,12)+'-',jobs:prefix+'/jobs'});
  candidateConfigs.add(config);return config;
}
export function trustedCheckConfiguration(candidate){
  if(candidate!==undefined&&!candidateConfigs.has(candidate))throw Error('CHECK_CANDIDATE_CONFIGURATION');
  return candidate??Object.freeze({launcher:'/usr/local/libexec/pi-kether-sandbox',trustRoot:'/var/lib/pi-kether-run-check/trust',policyPath:'C:/Users/asus/.local/state/pi-kether/run-check/check-policy.json',groupPrefix:'pi-kether-',jobs:'/var/lib/pi-kether/jobs'});
}
export function parsePolicyReadResult(stdout,expectedPath){
  if(typeof stdout!=='string'||stdout.charCodeAt(0)===0xfeff)throw Error('CHECK_POLICY_RESPONSE');
  const v=JSON.parse(stdout);
  if(!exact(v,['canonicalPath','sha256','contentBase64'])||!digest(v.sha256)||typeof v.contentBase64!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.contentBase64)||typeof v.canonicalPath!=='string'||path.resolve(v.canonicalPath).toLowerCase()!==path.resolve(expectedPath).toLowerCase())throw Error('CHECK_POLICY_RESPONSE');
  // Duplicate keys are never emitted by the fixed helper; reject them nonetheless.
  for(const k of ['canonicalPath','sha256','contentBase64'])if((stdout.match(new RegExp('"'+k+'"\\s*:','g'))??[]).length!==1)throw Error('CHECK_POLICY_RESPONSE');
  const bytes=Buffer.from(v.contentBase64,'base64');
  if(bytes.length>131072||bytes.toString('base64')!==v.contentBase64||hash(bytes)!==v.sha256)throw Error('CHECK_POLICY_RESPONSE');
  return bytes;
}
// Native helper reads ACL, owner, identity and contents through held, share-locked handles.
export async function loadHostCheckContext({task,cwd,requestId:rid,access,workerRuntime='pi',candidate,distro='Ubuntu-24.04'}){
  if(!task?.verify)return{available:false,reason:'not-declared'};
  if(task.role!=='Chesed'||access!=='workspace-write'||workerRuntime!=='pi'||process.platform!=='win32')return{available:false,reason:'unsupported-route'};
  const config=trustedCheckConfiguration(candidate);
  try{
    if(!fs.existsSync(config.policyPath))return{available:false,reason:'policy-absent'};
    const canonical=fs.realpathSync(cwd),policyReal=fs.realpathSync(config.policyPath);
    if(path.resolve(policyReal).toLowerCase()!==path.resolve(config.policyPath).toLowerCase())throw Error('policy-alias');
    const safeEnv={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',PATH:'C:\\Windows\\System32',USERPROFILE:process.env.USERPROFILE,TEMP:process.env.TEMP,TMP:process.env.TMP};
    const {runProcess}=await import('./headless-host.mjs');
    const result=await runProcess('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./read-check-policy.ps1',import.meta.url)),'-PolicyPath',config.policyPath],{cwd:'C:/Windows/System32',timeoutMs:20000,maxOutputBytes:196608,processTreeMode:'job-object',jobMemoryBytes:268435456,env:safeEnv});
    if(result.failure||result.exitCode!==0)throw Error('policy-read');
    const bytes=parsePolicyReadResult(result.stdout,config.policyPath);
    const commands=authorizeRunChecks({verify:task.verify,policy:JSON.parse(bytes),workspace:canonical.replaceAll('\\','/')});
    let trustSha256=config.trustSha256;
    if(!trustSha256){
      const v=await exec('wsl.exe',['--distribution',distro,'--user','root','--exec','/usr/bin/sha256sum',config.trustRoot+'/manifest.json'],{timeout:10000,maxBuffer:4096,windowsHide:true});
      trustSha256=v.stdout.trim().split(/\s+/)[0];
    }
    if(!digest(trustSha256)||!requestId(rid))throw Error('trust-unavailable');
    return{available:true,config,manifest:{version:1,requestId:rid,taskSha256:hash(JSON.stringify(task)),policySha256:hash(bytes),trustSha256,commands}};
  }catch{return{available:false,reason:'policy-or-trust-rejected'};}
}

function rootPath(file,{directory=false}={}){
  if(process.getuid?.()!==0||typeof file!=='string'||!file.startsWith('/')||file.startsWith('/mnt/')||file.split('/').some(s=>s==='..'||s==='.')||file.includes('\0'))throw Error('CHECK_TRUST_PATH');
  let current='';
  for(const part of file.split('/').filter(Boolean)){
    current+='/'+part;const st=fs.lstatSync(current);
    if(st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))throw Error('CHECK_TRUST_PERMISSIONS');
  }
  const st=fs.statSync(file);if(directory?!st.isDirectory():!st.isFile())throw Error('CHECK_TRUST_TYPE');
  return file;
}
function readTrust(root,expected){
  rootPath(root,{directory:true});const file=rootPath(root+'/manifest.json');
  const data=fs.readFileSync(file);if(data.length>1048576||hash(data)!==expected)throw Error('CHECK_TRUST_DIGEST');
  const v=JSON.parse(data);
  if(!exact(v,['version','runners','caches'])||v.version!==1||!Array.isArray(v.runners)||v.runners.length>16||!Array.isArray(v.caches)||v.caches.length>64)throw Error('CHECK_TRUST_SCHEMA');
  for(const r of v.runners){
    if(!exact(r,['id','path','sha256'])||r.id!=='node'||!digest(r.sha256))throw Error('CHECK_RUNNER_UNSUPPORTED');
    rootPath(r.path);if(hash(fs.readFileSync(r.path))!==r.sha256)throw Error('CHECK_RUNNER_DRIFT');
  }
  if(new Set(v.runners.map(x=>x.id)).size!==v.runners.length||new Set(v.caches.map(x=>x.id)).size!==v.caches.length)throw Error('CHECK_TRUST_DUPLICATE');
  return v;
}
function treeHashes(dir){
  rootPath(dir,{directory:true});const files=[];let total=0;
  const walk=(base,prefix='')=>{
    for(const entry of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const relative=prefix+entry.name,file=base+'/'+entry.name;
      if(!rel(relative))throw Error('CHECK_CACHE_NAME');
      rootPath(file,{directory:entry.isDirectory()});
      if(entry.isDirectory())walk(file,relative+'/');
      else{
        const st=fs.statSync(file);
        if(st.nlink!==1||st.size>64*1024*1024||files.length>=32768||(total+=st.size)>512*1024*1024)throw Error('CHECK_CACHE_SIZE');
        files.push({path:relative,sha256:hash(fs.readFileSync(file))});
      }
    }
  };walk(dir);return files;
}
function resolveCache(trust,command,snapshot,root){
  const c=trust.caches.find(x=>x.id===command.cacheId);
  if(!c||!exact(c,['id','path','files','projectFiles'])||!id(c.id)||!c.path.startsWith(root+'/caches/')||!Array.isArray(c.files)||c.files.length>32768||!Array.isArray(c.projectFiles)||c.projectFiles.length>16)throw Error('CHECK_CACHE_UNAVAILABLE');
  if(c.files.some(f=>!exact(f,['path','sha256'])||!rel(f.path)||!digest(f.sha256))||c.projectFiles.some(f=>!exact(f,['path','sha256'])||!rel(f.path)||!digest(f.sha256)))throw Error('CHECK_CACHE_MANIFEST');
  if(JSON.stringify(treeHashes(c.path))!==JSON.stringify(c.files))throw Error('CHECK_CACHE_DRIFT');
  for(const p of c.projectFiles){
    // Snapshot is immutable to the model. No untrusted source pathname is read here.
    const file=path.join(snapshot,p.path),st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||hash(fs.readFileSync(file))!==p.sha256)throw Error('CHECK_PROJECT_MANIFEST_DRIFT');
  }
  const available=fs.readdirSync(snapshot).filter(x=>/^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pyproject\.toml|requirements.*|Cargo\.(?:lock|toml)|go\.(?:mod|sum)|pom\.xml|build\.gradle|.*\.csproj|packages\.lock\.json)$/.test(x));
  if(available.some(p=>!c.projectFiles.some(f=>f.path===p)))throw Error('CHECK_PROJECT_MANIFEST_MISSING');
  return{...c,sha256:hash(JSON.stringify(c))};
}
export function checkSandboxArgs({snapshot,runner,cache,cwd}){
  return['--reuid=pi-sandbox','--regid=pi-sandbox','--init-groups','/usr/bin/bwrap',
    '--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-net','--unshare-uts','--unshare-ipc','--cap-drop','ALL',
    '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
    '--dir','/runner','--ro-bind',runner.path,'/runner/node','--dev','/dev','--proc','/proc','--remount-ro','/proc',
    '--size','16777216','--tmpfs','/tmp','--dir','/home/check','--bind',snapshot,'/workspace',
    '--ro-bind',cache.path,'/workspace/node_modules','--clearenv','--setenv','HOME','/home/check',
    '--setenv','PATH','/runner:/usr/bin:/bin','--setenv','npm_config_offline','true','--setenv','npm_config_cache','/tmp/npm',
    '--chdir',cwd==='.'?'/workspace':'/workspace/'+cwd,'--','/runner/node'];
}
async function removeCheckGroup(group){
  if(!fs.existsSync(group))return true;
  try{
    fs.writeFileSync(group+'/cgroup.kill','1\n');
    for(let i=0;i<100;i++){
      try{fs.rmdirSync(group);return true;}catch{}
      await new Promise(r=>setTimeout(r,20));
    }
  }catch{}
  return false;
}
function emitSigned(secret,payload){
  const frame={payload,signature:sign(Buffer.from(secret.key,'hex'),payload)};
  process.stdout.write(RECEIPT_FRAME+JSON.stringify(frame)+'\n');return frame;
}
function updateState(file,transform){
  const state=JSON.parse(fs.readFileSync(file,'utf8'));transform(state);
  const tmp=file+'.next';fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});fs.renameSync(tmp,file);return state;
}
export function checkMemoryBudget(parent,current){
  const mib=1024*1024;
  if(!Number.isSafeInteger(parent)||!Number.isSafeInteger(current)||parent<=0||current<0||current>parent)throw Error('CHECK_RESOURCE_UNAVAILABLE');
  const modelReserve=Math.min(1024*mib,Math.floor(parent*0.75));
  // Preserve model headroom as well as the existing fixed reserve. Admission is
  // conservative; the parent cgroup remains authoritative if usage later grows.
  const memory=Math.min(512*mib,parent-modelReserve,parent-current-128*mib);
  if(memory<128*mib)throw Error('CHECK_RESOURCE_UNAVAILABLE');
  return memory;
}
export async function runRootCheck({secretFile,stateFile,workspace,group,request,signal}){
  validateCheckRequest(request);
  const secret=JSON.parse(fs.readFileSync(rootPath(secretFile),'utf8'));
  const state=updateState(stateFile,s=>{if(s.attempts+1!==request.checkId||s.attempts>=8)throw Error('CHECK_SEQUENCE');s.attempts++;});
  const command=secret.commands.find(x=>x.id===request.commandId);
  const started=Date.now(),checkGroup=group+'/check-'+request.checkId,copy=path.dirname(secretFile)+'/check-'+request.checkId;
  let cache=null,snapshot=null,exitCode=null,exitSignal=null,reason=null,cleanupOk=true,outputBytes=0,output='';
  const outputHash=createHash('sha256');
  try{
    if(!command)throw Error('CHECK_COMMAND_DENIED');
    const trust=readTrust(secret.trustRoot,secret.trustSha256),runner=trust.runners.find(x=>x.id===command.runnerId);
    if(!runner||command.argv[0]!=='node')throw Error('CHECK_RUNNER_UNAVAILABLE');
    const memory=checkMemoryBudget(Number(fs.readFileSync(group+'/memory.max','utf8').trim()),Number(fs.readFileSync(group+'/memory.current','utf8').trim()));
    if(!Number.isSafeInteger(memory)||memory<128*1024*1024||!fs.existsSync(group+'/cgroup.kill'))throw Error('CHECK_RESOURCE_UNAVAILABLE');
    fs.mkdirSync(checkGroup);
    for(const [name,value] of Object.entries({'pids.max':'64','memory.max':String(memory),'memory.swap.max':'0','memory.oom.group':'1'})){
      fs.writeFileSync(checkGroup+'/'+name,value+'\n');if(fs.readFileSync(checkGroup+'/'+name,'utf8').trim()!==value)throw Error('CHECK_RESOURCE_REJECTED');
    }
    if(!fs.existsSync(checkGroup+'/cgroup.kill'))throw Error('CHECK_KILL_UNAVAILABLE');
    fs.mkdirSync(copy,{mode:0o711});
    await exec('/usr/bin/mount',['-t','tmpfs','-o','size=96M,nr_inodes=8192,nosuid,nodev,mode=0711','tmpfs',copy],{timeout:10000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin'}});
    const destination=copy+'/workspace';fs.mkdirSync(destination,{mode:0o700});
    const identity=(await exec('/usr/bin/id',['-u','pi-sandbox'],{timeout:1000,maxBuffer:100})).stdout.trim();
    const identityGroup=(await exec('/usr/bin/id',['-g','pi-sandbox'],{timeout:1000,maxBuffer:100})).stdout.trim();
    const s=await exec('/usr/bin/python3',[fileURLToPath(new URL('./check-snapshot.py',import.meta.url)),workspace,destination,identity,identityGroup],{timeout:15000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin'}});
    snapshot=JSON.parse(s.stdout);if(!digest(snapshot.sha256)||snapshot.files>4096||snapshot.bytes>64*1024*1024)throw Error('CHECK_SNAPSHOT_INVALID');
    cache=resolveCache(trust,command,destination,secret.trustRoot);
    // cwd must exist within the snapshot; traversal was rejected before admission.
    if(command.cwd!=='.'&&!fs.statSync(path.join(destination,command.cwd)).isDirectory())throw Error('CHECK_CWD_UNAVAILABLE');
    const remaining=Math.min(CHECK_LIMITS.timeMs-(Date.now()-started),secret.deadline-Date.now());
    if(remaining<=0||signal.aborted)throw Error('CHECK_TIMEOUT_OR_CANCELLED');
    const args=checkSandboxArgs({snapshot:destination,runner,cache,cwd:command.cwd}).concat(command.argv.slice(1));
    await new Promise(resolve=>{
      // Trusted root joins the cgroup before setpriv/bwrap/command can fork.
      const child=spawn('/bin/sh',['-c','printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"','yhwh-check',checkGroup,'/usr/bin/setpriv',...args],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'},windowsHide:true});
      let stopped=false;
      const stop=why=>{if(stopped)return;stopped=true;reason??=why;try{fs.writeFileSync(checkGroup+'/cgroup.kill','1\n');}catch{cleanupOk=false;child.kill('SIGKILL');}};
      const timer=setTimeout(()=>stop('check-timeout'),remaining),abort=()=>stop('cancelled');
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      const capture=chunk=>{outputBytes+=chunk.length;outputHash.update(chunk);if(outputBytes>CHECK_LIMITS.outputBytes)stop('output-limit');else output+=chunk.toString('utf8');};
      child.stdout.on('data',capture);child.stderr.on('data',capture);
      child.on('error',()=>{reason='check-launch-failed';});
      child.on('close',(code,sig)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);exitCode=code;exitSignal=sig;resolve();});
    });
    // The cache is never a writable mount; still verify bytes after execution.
    if(JSON.stringify(treeHashes(cache.path))!==JSON.stringify(cache.files))throw Error('CHECK_CACHE_CHANGED');
  }catch(error){reason??=/^CHECK_[A-Z_]+$/.test(error.message)?error.message:'CHECK_REJECTED';}
  finally{
    cleanupOk=(await removeCheckGroup(checkGroup))&&cleanupOk;
    if(fs.existsSync(copy)){
      try{await exec('/usr/bin/umount',[copy],{timeout:5000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin'}});fs.rmSync(copy,{recursive:true});}catch{cleanupOk=false;}
    }
  }
  const payload={version:1,requestId:secret.requestId,jobId:secret.jobId,evidenceKind:'sandboxEvidence',type:'call',callId:request.checkId,commandId:request.commandId,
    argv:command?.argv??[],cwd:command?.cwd??'.',taskSha256:secret.taskSha256,policySha256:secret.policySha256,trustSha256:secret.trustSha256,
    cacheSha256:cache?.sha256??null,snapshotSha256:snapshot?.sha256??null,startedAt:new Date(started).toISOString(),endedAt:new Date().toISOString(),exitCode,signal:exitSignal,reason,
    outputBytes,outputSha256:outputHash.digest('hex'),outputSummary:Buffer.from(redactSensitiveText(output,{compact:false})).subarray(0,4000).toString('utf8'),cleanupOk};
  const frame=emitSigned(secret,payload);
  updateState(stateFile,s=>{s.chain=hash(s.chain+JSON.stringify(frame));s.receipts++;s.cleanupOk&&=cleanupOk;});
  return{ok:!reason&&cleanupOk&&exitCode===0,evidenceKind:'sandboxEvidence',commandId:request.commandId,exitCode,signal:exitSignal,reason,output,outputBytes,cleanupOk};
}
export function createCheckFrames({workspace,group,secretFile,stateFile,send,onOutput,onFailure,otherFrames}){
  let pending='',active=null,closed=false,failed=false;
  const fail=()=>{if(!failed){failed=true;active?.abort();onFailure();}};
  const line=text=>{
    if(text.startsWith(RECEIPT_FRAME)){fail();return;}
    if(!text.startsWith(CHECK_FRAME)){
      if(active&&text.startsWith('YHWH_LSP_RPC=')&&!text.startsWith('YHWH_LSP_RPC={"lspCancel"')){fail();return;}
      otherFrames?otherFrames.feed(text+'\n'):onOutput(text+'\n');return;
    }
    try{
      const r=JSON.parse(text.slice(CHECK_FRAME.length));
      if(exact(r,['checkCancel'])){if(r.checkCancel!==active?.id)throw Error();active.abort();return;}
      validateCheckRequest(r);
      if(closed||failed||active||otherFrames?.busy?.())throw Error();
      const controller=new AbortController();controller.id=r.checkId;active=controller;
      controller.work=runRootCheck({secretFile,stateFile,workspace,group,request:r,signal:controller.signal}).then(result=>{
        if(!closed)send(JSON.stringify({checkId:r.checkId,result})+'\n');
        if(!result.cleanupOk)fail();
      }).catch(fail).finally(()=>{active=null;});
    }catch{fail();}
  };
  return{
    feed(chunk){if(closed||failed)return;pending+=chunk;if(Buffer.byteLength(pending)>8388608){fail();return;}let at;while((at=pending.indexOf('\n'))>=0){line(pending.slice(0,at));pending=pending.slice(at+1);}},
    async close(){closed=true;active?.abort();await active?.work;if(pending){if(pending.startsWith(CHECK_FRAME)||pending.startsWith(RECEIPT_FRAME))fail();else onOutput(pending);}pending='';const c=await otherFrames?.close();return{ok:!failed&&c?.ok!==false};},
  };
}
async function brokerMain(){
  if(process.getuid?.()!==0)throw Error('CHECK_ROOT_REQUIRED');
  const [action,...args]=process.argv.slice(2);
  if(action==='--accept'){
    const [secretFile,trustRoot,jobId,deadlineText]=args;let data='';
    for await(const chunk of process.stdin){data+=chunk;if(Buffer.byteLength(data)>131072)throw Error('CHECK_PREAMBLE_SIZE');}
    const v=JSON.parse(data);
    if(!exact(v,['version','requestId','jobId','taskSha256','policySha256','trustSha256','commands','key'])||v.version!==1||!requestId(v.requestId)||v.jobId!==jobId||!/^[a-f0-9-]{36}$/.test(jobId)||!digest(v.key)||!['taskSha256','policySha256','trustSha256'].every(k=>digest(v[k]))||!Array.isArray(v.commands)||v.commands.length>16)throw Error('CHECK_PREAMBLE_INVALID');
    validateVerify({commands:v.commands.map(c=>({id:c.id,argv:c.argv,cwd:c.cwd}))});
    if(v.commands.some(c=>!exact(c,['id','argv','cwd','runnerId','cacheId'])||!id(c.runnerId)||!id(c.cacheId)))throw Error('CHECK_COMMAND_INVALID');
    const deadline=Number(deadlineText);if(!Number.isSafeInteger(deadline)||deadline<Date.now()||deadline>Date.now()+900000)throw Error('CHECK_DEADLINE');
    readTrust(trustRoot,v.trustSha256);
    fs.writeFileSync(secretFile,JSON.stringify({...v,trustRoot,deadline}),{flag:'wx',mode:0o600});
    fs.writeFileSync(path.dirname(secretFile)+'/check-state.json',JSON.stringify({attempts:0,receipts:0,chain:'0'.repeat(64),cleanupOk:true}),{flag:'wx',mode:0o600});
  }else if(action==='--export-terminal'){
    const [secretFile,stateFile,code]=args,secret=JSON.parse(fs.readFileSync(rootPath(secretFile))),s=JSON.parse(fs.readFileSync(rootPath(stateFile)));
    process.stdout.write(JSON.stringify({secret:{key:secret.key,requestId:secret.requestId,jobId:secret.jobId},state:s,code:Number(code)}));
  }else if(action==='--emit-terminal'){
    let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>16384)throw Error('CHECK_TERMINAL_SIZE');}
    const [stateText,cleanupText]=data.trim().split('\n'),{secret,state,code}=JSON.parse(stateText);
    emitSigned(secret,{version:1,requestId:secret.requestId,jobId:secret.jobId,evidenceKind:'sandboxEvidence',type:'terminal',attempts:state.attempts,chain:state.chain,cleanupOk:cleanupText==='0'&&state.cleanupOk&&state.receipts===state.attempts,brokerExitCode:code});
    secret.key='';
  }else throw Error('CHECK_ACTION');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))brokerMain().catch(()=>{console.error('YHWH_CHECK_BROKER_REJECTED');process.exitCode=2;});


