// SPDX-License-Identifier: Apache-2.0
// Trusted launcher-side broker. This process shares the parent's task cgroup;
// its probes get separate PID/network namespaces and never receive auth FD3.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readSync,readFileSync,mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareCsharpSnapshot} from './csharp-probe-project.mjs';

export const LSP_FRAME = 'YHWH_LSP_RPC=';
const methods = new Set(['diagnostics','hover','definition','references','symbols','completions','code_actions'].map(m => 'lsp_'+m));
const failure = reason => ({ok:false,status:'failed',reason,executionMode:'direct',modelCalls:0});

export function validateProbeRequest(request) {
  if (!request || Object.keys(request).sort().join(',') !== 'lspId,params,tool' || !Number.isSafeInteger(request.lspId) || request.lspId < 1 || !methods.has(request.tool)) throw Error('invalid-request');
  const p = request.params;
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['path','line','character','query'].includes(k)) || typeof p.path !== 'string' || !p.path || p.path.length > 4096) throw Error('invalid-parameters');
  const file = p.path.startsWith('/workspace/') ? p.path.slice(11) : p.path;
  if (file.startsWith('/') || file.includes('\\') || file.includes(':') || file.includes('\0') || file.split('/').some(s => !s || s === '.' || s === '..') || !/\.(py|js|jsx|ts|tsx|java|c|h|cpp|cc|cxx|hpp|cs|go|rs)$/i.test(file)) throw Error('invalid-path');
  const positioned = !['lsp_diagnostics','lsp_symbols'].includes(request.tool);
  const hasPosition = p.line !== undefined || p.character !== undefined;
  if (hasPosition && (!positioned || !Number.isSafeInteger(p.line) || p.line < 1 || !Number.isSafeInteger(p.character) || p.character < 1)) throw Error('invalid-position');
  if (p.query !== undefined && (typeof p.query !== 'string' || !p.query.trim() || p.query.length > 4000 || request.tool === 'lsp_diagnostics')) throw Error('invalid-query');
  if (positioned && ((!hasPosition && p.query === undefined) || (hasPosition && p.query !== undefined))) throw Error('position-or-query-required');
  return {tool:request.tool,params:{...p,path:'/workspace/'+file},file};
}

export function snapshotProbeFile(workspace, file) {
  // Walk with directory descriptors and O_NOFOLLOW. A worker cannot redirect a
  // privileged open by swapping a parent directory or symlink during validation.
  const fds = [];
  try {
    let fd = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(fd);
    const parts = file.split('/');
    for (let i = 0; i < parts.length; i++) {
      fd = openSync(`/proc/self/fd/${fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | (i < parts.length-1 ? constants.O_DIRECTORY : constants.O_NONBLOCK)); fds.push(fd);
    }
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 4194304) throw Error('file-size-or-type');
    const data = Buffer.alloc(4194305); let length = 0, count;
    while (length < data.length && (count = readSync(fd, data, length, data.length-length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length > 4194304 || before.size !== length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('file-changed-or-too-large');
    return data.subarray(0,length);
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}

export function probeSandboxArgs(snapshot,file='') {
  return ['--reuid=pi-sandbox','--regid=pi-sandbox','--init-groups','/usr/bin/bwrap',
    '--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-net','--unshare-uts','--unshare-ipc','--cap-drop','ALL',
    '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
    '--ro-bind','/opt','/opt',...(/\.java$/i.test(file)?['--ro-bind','/etc/java-21-openjdk/security','/etc/java-21-openjdk/security']:[]),'--dev','/dev','--tmpfs','/tmp',...(/\.(cs|go)$/i.test(file)?['--proc','/proc','--remount-ro','/proc']:['--dir','/proc']),'--ro-bind',snapshot,'/workspace',
    '--dir','/home/pi-sandbox','--chdir','/workspace','--clearenv','--setenv','HOME','/home/pi-sandbox',
    '--setenv','PATH','/opt/node/bin:/opt/pi-kether/node_modules/.bin:/opt/pi-kether/dotnet-tools:/usr/local/bin:/usr/bin:/bin',
    '--','/opt/pi-kether/multilspy-venv/bin/python','-I','/opt/pi-kether/scripts/multilspy-probe.py'];
}

export async function runProbe(workspace, request, signal) {
  let snapshot;
  try {
    const validated = validateProbeRequest(request);
    if (signal.aborted) return failure('cancelled');
    const data = snapshotProbeFile(workspace, validated.file);
    snapshot = mkdtempSync(join(dirname(workspace),'lsp-probe-')); chmodSync(snapshot,0o755);
    const file = join(snapshot,validated.file); mkdirSync(dirname(file),{recursive:true,mode:0o755}); writeFileSync(file,data,{mode:0o444});
    if(/\.cs$/i.test(validated.file))prepareCsharpSnapshot(snapshot,validated.file);
    const args = probeSandboxArgs(snapshot,validated.file);
    return await new Promise(resolveResult => {
      const child = spawn('/usr/bin/setpriv',args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'},windowsHide:true});
      const chunks=[]; let bytes=0, reason=null;
      const stop = why => { reason ??= why; child.kill('SIGKILL'); };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('probe-timeout'),60000);
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) abort();
      child.stdin.on('error',() => {}); child.stderr.on('data',() => {});
      child.stdout.on('data',chunk => { bytes += chunk.length; if (bytes > 2097152) stop('output-size-limit'); else chunks.push(chunk); });
      child.on('error',() => { reason='probe-launch-failed'; });
      child.on('close',code => {
        clearTimeout(timer); signal.removeEventListener('abort',abort);
        if (reason) return resolveResult(failure(reason));
        try {
          const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value.engine !== 'multilspy' || value.requestedTool !== validated.tool || value.modelCalls !== 0 || !value.serverCleanup?.ok || (value.ok && code !== 0) || (value.ok && (!['success','no-match'].includes(value.status) || value.backend !== 'lsp'))) throw Error();
          if (value.ok && validated.tool === 'lsp_diagnostics' && !value.diagnosticsPublished) throw Error();
          if (value.ok && /\.(?:[jt]sx?|go|rs)$/i.test(validated.file) && ['lsp_diagnostics','lsp_code_actions'].includes(validated.tool) && !value.diagnosticCompletion?.complete) throw Error();
          resolveResult({...value,probeIsolation:{network:false,credentials:false,workspace:'single-file-read-only',resourceBudget:'shared-parent-task',processView:/\.(cs|go)$/i.test(validated.file)?'private-pid-read-only':'empty'}});
        } catch { resolveResult(failure('invalid-probe-response')); }
      });
      child.stdin.end(JSON.stringify({tool:validated.tool,params:validated.params}));
    });
  } catch { return failure('probe-request-rejected'); }
  finally { if (snapshot) rmSync(snapshot,{recursive:true,force:true}); }
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const isolation = {network:false,credentials:false,workspace:'single-file-read-only',resourceBudget:'shared-parent-task'};

function launchSession(snapshot,file) {
  return spawn('/usr/bin/setpriv',[...probeSandboxArgs(snapshot,file),'--session'],{
    stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'},windowsHide:true});
}

function sessionTransport(child) {
  let buffer='',pending=null,ended=false,closing=false,ack=null,forced=false,fault=null;
  let resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const kill=reason=>{fault??=reason;forced=true;child.kill('SIGKILL');};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>2097152){kill('output-size-limit');return;}
    let at;
    while((at=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
      try {
        const value=JSON.parse(line);
        if(value.sessionClosed===true){
          if(!closing||ack!==null)throw Error();
          ack=value.serverCleanup?.ok===true;
        } else {
          if(!pending||closing)throw Error();
          const receiver=pending;pending=null;receiver.resolve(value);
        }
      } catch {kill('invalid-session-response');}
    }
  });
  child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>kill('session-channel-closed'));
  child.on('error',()=>{fault='probe-launch-failed';});
  child.on('close',code=>{
    ended=true;
    if(pending){pending.reject(Error(fault??'session-channel-closed'));pending=null;}
    resolveClosed({ok:forced || (code===0&&ack===true&&!buffer),mode:forced?'namespace-terminated':'graceful',fault});
  });
  return {
    get ended(){return ended;},
    async query(request,signal){
      if(ended||closing||pending||fault)throw Error('session-channel-closed');
      let timer;
      const abort=()=>kill('cancelled');
      try {
        return await new Promise((resolveResult,reject)=>{
          pending={resolve:resolveResult,reject};
          timer=setTimeout(()=>kill('probe-timeout'),60000);
          signal.addEventListener('abort',abort,{once:true});
          child.stdin.write(JSON.stringify(request)+'\n');
          if(signal.aborted)abort();
        });
      } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
    },
    async stop(force=false){
      closing=true;
      if(!ended){
        if(force||pending)kill('session-stopped');
        else child.stdin.end('{"close":true}\n');
      }
      const timer=setTimeout(()=>kill('session-shutdown-timeout'),8000);
      try{return await closed;}finally{clearTimeout(timer);}
    },
  };
}

// A task owns at most one immutable snapshot/server. A content or route change
// awaits termination before creating another; results themselves are not cached.
function createSingleProbeSession(workspace,{idleMs=15000,launch=launchSession,readSnapshot=snapshotProbeFile,nextGeneration}={}) {
  let current=null,idle=null,closing=Promise.resolve({ok:true}),busy=false,closed=false,broken=false,generation=0;
  const dispose=(force=false)=>{
    clearTimeout(idle);
    if(!current)return closing;
    const previous=current;current=null;
    closing=previous.transport.stop(force).then(result=>{
      if(!result.ok)broken=true;
      return result;
    }).finally(()=>rmSync(previous.snapshot,{recursive:true,force:true}));
    return closing;
  };
  return {
    async run(request,signal){
      if(closed||broken)return failure('session-unavailable');
      if(busy)return failure('session-busy');
      busy=true;clearTimeout(idle);
      try {
        await closing;
        if(closed||broken)throw Error('session-unavailable');
        if(signal.aborted)throw Error('cancelled');
        const r=validateProbeRequest(request),data=readSnapshot(workspace,r.file),digest=sha256(data);
        const route=/\.py$/i.test(r.file)&&['lsp_diagnostics','lsp_code_actions'].includes(r.tool)?'pyright':'default';
        const key=JSON.stringify([r.file,digest,route]);
        if(current && (current.key!==key||current.transport.ended))await dispose();
        if(broken)throw Error('session-cleanup-failed');
        if(!current){
          const snapshot=mkdtempSync(join(dirname(workspace),'lsp-probe-'));chmodSync(snapshot,0o755);
          try {
            const file=join(snapshot,r.file);mkdirSync(dirname(file),{recursive:true,mode:0o755});writeFileSync(file,data,{mode:0o444});
            if(/\.cs$/i.test(r.file))prepareCsharpSnapshot(snapshot,r.file);
            current={key,snapshot,transport:sessionTransport(launch(snapshot,r.file)),generation:nextGeneration?nextGeneration():++generation,count:0};
          } catch {rmSync(snapshot,{recursive:true,force:true});throw Error('probe-launch-failed');}
        }
        const session=current,expectedReused=session.count>0;
        const value=await session.transport.query({tool:r.tool,params:r.params},signal);
        if(signal.aborted)throw Error('cancelled');
        if(value.engine!=='multilspy'||value.requestedTool!==r.tool||value.modelCalls!==0||value.backend!=='lsp')throw Error('invalid-session-response');
        if(!value.ok){await dispose(true);return {...value,serverCleanup:{ok:!broken,state:'namespace-terminated'}};}
        if(!['success','no-match'].includes(value.status)||value.serverCleanup?.ok!==null||value.serverCleanup?.state!=='retained-until-session-close'||value.serverSession?.documentSha256!==digest||value.serverSession?.documentVersion!==1||value.serverSession?.reused!==expectedReused)throw Error('invalid-session-evidence');
        if(r.tool==='lsp_diagnostics'&&!value.diagnosticsPublished)throw Error('missing-diagnostic-evidence');
        if(/\.(?:[jt]sx?|go|rs)$/i.test(r.file)&&['lsp_diagnostics','lsp_code_actions'].includes(r.tool)&&!value.diagnosticCompletion?.complete)throw Error('missing-diagnostic-evidence');
        if(sha256(readSnapshot(workspace,r.file))!==digest)throw Error('file-changed-during-probe');
        session.count++;
        idle=setTimeout(()=>{dispose().catch(()=>{broken=true;});},idleMs);
        return {...value,serverSession:{...value.serverSession,generation:session.generation},probeIsolation:{...isolation,processView:/\.(cs|go)$/i.test(r.file)?'private-pid-read-only':'empty'}};
      } catch(error) {
        await dispose(true);
        const reason=['cancelled','probe-timeout','file-changed-during-probe','invalid-session-evidence','invalid-session-response','missing-diagnostic-evidence','probe-launch-failed','session-channel-closed','output-size-limit','session-cleanup-failed','session-unavailable'].includes(error.message)?error.message:'probe-request-rejected';
        return {...failure(reason),serverCleanup:{ok:!broken,state:'namespace-terminated'}};
      } finally {busy=false;}
    },
    async close(){closed=true;return dispose(busy);},
  };
}

// Python alternates between Pyright diagnostics and Jedi symbol queries. Keep
// those two slots for one immutable file only; all other languages use one slot.
export function createProbeSessions(workspace,options={}) {
  const {pythonDual=true,readSnapshot=snapshotProbeFile}=options;
  const slots=new Map();let key=null,generation=0,busy=false,closed=false,broken=false;
  let draining=Promise.resolve({ok:true,mode:'pool-closed',sessions:0});
  const closeAll=()=>{
    if(!slots.size)return draining;
    const managers=[...slots.values()];slots.clear();key=null;
    draining=Promise.allSettled(managers.map(manager=>manager.close())).then(results=>{
      if(results.some(r=>r.status==='rejected'||!r.value.ok))broken=true;
      if(results.length===1&&results[0].status==='fulfilled')return results[0].value;
      return {ok:!broken,mode:'pool-closed',sessions:results.length};
    });
    return draining;
  };
  return {
    async run(request,signal){
      if(closed||broken)return failure('session-unavailable');
      if(busy)return failure('session-busy');
      busy=true;
      try {
        if(signal.aborted)throw Error('cancelled');
        const r=validateProbeRequest(request),digest=sha256(readSnapshot(workspace,r.file));
        const nextKey=JSON.stringify([r.file,digest]);
        if(key!==null&&key!==nextKey)await closeAll();
        await draining;
        if(closed||signal.aborted)throw Error('cancelled');
        if(broken)throw Error('session-cleanup-failed');
        key=nextKey;
        const slot=pythonDual&&/\.py$/i.test(r.file)
          ?(['lsp_diagnostics','lsp_code_actions'].includes(r.tool)?'pyright':'jedi'):'single';
        if(!slots.has(slot))slots.set(slot,createSingleProbeSession(workspace,{...options,nextGeneration:()=>++generation}));
        const result=await slots.get(slot).run(request,signal);
        if(closed||signal.aborted)throw Error('cancelled');
        if(!result.ok){const cleanup=await closeAll();return {...result,serverCleanup:{ok:cleanup.ok&&result.serverCleanup?.ok!==false,state:'pool-terminated'}};}
        if(result.serverSession?.documentSha256!==digest)throw Error('file-changed-during-probe');
        return {...result,serverSession:{...result.serverSession,poolSlot:slot,poolCapacity:pythonDual&&/\.py$/i.test(r.file)?2:1}};
      }catch(error){
        const cleanup=await closeAll();
        const reason=['cancelled','session-cleanup-failed','file-changed-during-probe'].includes(error.message)?error.message:'probe-request-rejected';
        return {...failure(reason),serverCleanup:{ok:cleanup.ok,state:'pool-terminated'}};
      }finally{busy=false;}
    },
    async close(){closed=true;return closeAll();},
  };
}

export function createProbeFrames({workspace,send,onOutput,onFailure,probe}) {
  const sessions=probe?null:createProbeSessions(workspace);
  const executeProbe=probe??((_workspace,request,signal)=>sessions.run(request,signal));
  let buffer='',sequence=0,active=null,closed=false; const pending=new Set();
  const fail=() => { if (!closed) { closed=true; active?.controller.abort(); onFailure(); } };
  function line(value) {
    if (!value.startsWith(LSP_FRAME)) { onOutput(value+'\n'); return; }
    try {
      const r=JSON.parse(value.slice(LSP_FRAME.length));
      if (Object.keys(r).join(',') === 'lspCancel') { if (active?.id === r.lspCancel) active.controller.abort(); return; }
      validateProbeRequest(r);
      if (closed || active || r.lspId !== sequence+1 || ++sequence > 64) throw Error();
      const controller=new AbortController(); active={id:r.lspId,controller};
      const work=Promise.resolve().then(() => executeProbe(workspace,r,controller.signal)).catch(() => failure('probe-failed')).then(result => {
        if (!closed) send(JSON.stringify({lspId:r.lspId,result})+'\n');
      }).catch(fail).finally(() => { active=null; pending.delete(work); }); pending.add(work);
    } catch { fail(); }
  }
  return {
    feed(chunk) { if (closed) return; buffer+=chunk; if (Buffer.byteLength(buffer)>8388608) { fail(); return; } let at; while ((at=buffer.indexOf('\n'))>=0) { const value=buffer.slice(0,at); buffer=buffer.slice(at+1); line(value); } },
    async close() { closed=true; active?.controller.abort(); if(buffer && !buffer.startsWith(LSP_FRAME))onOutput(buffer); buffer=''; await Promise.allSettled([...pending]); return sessions ? sessions.close() : {ok:true}; },
  };
}

async function main() {
  const [workspace,editorMode,separator,command,...args]=process.argv.slice(2);
  if (process.getuid?.() !== 0 || separator !== '--' || command !== '/usr/bin/setpriv' || !['true','false'].includes(editorMode) || !/^\/var\/lib\/pi-kether\/jobs\/[a-f0-9-]{36}\/workspace$/.test(workspace)) throw Error('invalid-broker-launch');
  const group='pi-kether-'+workspace.split('/').at(-2);
  if (!readFileSync('/proc/self/cgroup','utf8').split('\n').some(line=>line === '0::/'+group)) throw Error('missing-task-cgroup');
  for (const limit of ['memory.max','pids.max','cpu.max']) {
    if (!/^[1-9][0-9]*(?: [1-9][0-9]*)?$/.test(readFileSync('/sys/fs/cgroup/'+group+'/'+limit,'utf8').trim())) throw Error('missing-task-limit');
  }
  const child=spawn(command,args,{stdio:['pipe','pipe','pipe',3],env:process.env});
  closeSync(3);
  const stop=() => { child.kill('SIGTERM'); };
  const frames=createProbeFrames({workspace,send:line=>{if(!child.stdin.destroyed)child.stdin.write(line);},onOutput:chunk=>process.stdout.write(chunk),onFailure:stop});
  child.stdout.setEncoding('utf8'); child.stdout.on('data',chunk=>frames.feed(chunk)); child.stderr.pipe(process.stderr);
  child.stdin.on('error',()=>{}); child.on('error',()=>{process.exitCode=2;process.stdin.destroy();});
  child.on('close',async code=>{try{const cleanup=await frames.close();process.exitCode=cleanup.ok?(code??2):2;}catch{process.exitCode=2;}process.stdin.destroy();});
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  if (editorMode === 'true') process.stdin.pipe(child.stdin,{end:false});
  else {
    let input=''; process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>1048576)stop();});
    process.stdin.on('end',()=>child.stdin.write(JSON.stringify({prompt:input})+'\n'));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(()=>{console.error('YHWH_LSP_BROKER_FAILED');process.exitCode=2;});
