import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';
import {createCandidateCheckConfiguration} from '../../scripts/run-check-broker.mjs';
const node='/opt/node/bin/node',distro='Ubuntu-24.04';
const sha=data=>createHash('sha256').update(data).digest('hex');
export function wslNode(code,input,{timeout=30000,maxBuffer=1048576}={}){
  return new Promise((resolve,reject)=>{
    const child=execFile('wsl.exe',['--distribution',distro,'--user','root','--cd','/','--exec',node,'--input-type=module','-e',code],{windowsHide:true,timeout,maxBuffer},(error,stdout,stderr)=>{
      if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});
    });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input??{}));
  });
}
const readInput="let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>16777216)throw Error('test input limit');}const data=JSON.parse(input);";
const productionProgram=String.raw`import fs from 'node:fs';import{createHash}from'node:crypto';
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),files={};
const walk=p=>{for(const x of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+x.name;if(x.isDirectory())walk(f);else if(x.isFile())files[f]=hash(f);else throw Error('production nonregular entry');}};
for(const p of ['/opt/pi-kether/scripts','/opt/pi-kether/extensions'])walk(p);
for(const p of ['/usr/local/libexec/pi-kether-sandbox','/opt/pi-kether/package.json','/opt/pi-kether/package-lock.json','/opt/node/bin/node'])if(fs.existsSync(p))files[p]=hash(p);
console.log(JSON.stringify({files,cgroups:fs.readdirSync('/sys/fs/cgroup').filter(s=>s.startsWith('pi-kether-')).sort(),at:new Date().toISOString()}));`;
export async function productionSnapshot(){return JSON.parse((await wslNode(productionProgram)).stdout);}
export async function prepareCandidate({policyPath,projectFiles=[]}){
  if(process.platform!=='win32')throw Error('candidate host must be Windows');
  const root=fileURLToPath(new URL('../../',import.meta.url)),files=[];
  const walk=(folder,prefix)=>{
    for(const x of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const rel=prefix+x.name,file=path.join(folder,x.name);if(x.isSymbolicLink())throw Error('candidate link');
      if(x.isDirectory())walk(file,rel+'/');
      else if(x.isFile()&&/\.(?:mjs|js|py|json)$/.test(x.name)){const content=fs.readFileSync(file);files.push({path:rel,sha256:sha(content),content:content.toString('base64')});}
    }
  };
  walk(path.join(root,'scripts'),'scripts/');walk(path.join(root,'extensions'),'extensions/');
  const launcher=fs.readFileSync(path.join(root,'sandbox/pi-kether-sandbox'));
  files.push({path:'sandbox/pi-kether-sandbox',sha256:sha(launcher),content:launcher.toString('base64')});
  const nodeSha256=JSON.parse((await wslNode("import fs from 'node:fs';import{createHash}from'node:crypto';console.log(JSON.stringify(createHash('sha256').update(fs.readFileSync('/opt/node/bin/node')).digest('hex')));")).stdout);
  const candidateSha256=sha(JSON.stringify({files:files.map(({path,sha256})=>({path,sha256})),projectFiles,nodeSha256,version:2}));
  const prefix='/var/lib/pi-kether-candidates/'+candidateSha256+'/root';
  const program=String.raw`import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';`+readInput+String.raw`
    const hash=v=>createHash('sha256').update(v).digest('hex'),base='/var/lib/pi-kether-candidates/'+data.candidateSha256+'/root';
    if(process.getuid()!==0||!/^[a-f0-9]{64}$/.test(data.candidateSha256)||hash(JSON.stringify({files:data.files.map(({path,sha256})=>({path,sha256})),projectFiles:data.projectFiles,nodeSha256:data.nodeSha256,version:2}))!==data.candidateSha256)throw Error('candidate identity');
    fs.mkdirSync(base,{recursive:true,mode:0o755});
    for(const f of data.files){
      if(!/^(?:scripts|extensions|sandbox)\/[-a-zA-Z0-9_./]+$/.test(f.path)||f.path.split('/').some(s=>s==='.'||s==='..'))throw Error('candidate path');
      const content=Buffer.from(f.content,'base64'),target=base+'/'+f.path;
      if(hash(content)!==f.sha256)throw Error('candidate hash');fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});
      if(fs.existsSync(target)){if(hash(fs.readFileSync(target))!==f.sha256)throw Error('candidate drift');}
      else fs.writeFileSync(target,content,{mode:f.path.startsWith('sandbox/')?0o755:0o644,flag:'wx'});
    }
    fs.mkdirSync(base+'/jobs',{mode:0o755,recursive:true});fs.mkdirSync(base+'/trust/caches/empty',{mode:0o755,recursive:true});
    fs.mkdirSync(base+'/trust/runners',{recursive:true,mode:0o755});
    const runner=fs.readFileSync('/opt/node/bin/node');if(hash(runner)!==data.nodeSha256)throw Error('runner source drift');
    const runnerPath=base+'/trust/runners/node';
    if(fs.existsSync(runnerPath)){if(hash(fs.readFileSync(runnerPath))!==data.nodeSha256)throw Error('runner copy drift');}
    else fs.writeFileSync(runnerPath,runner,{flag:'wx',mode:0o755});
    const libraries=execFileSync('/usr/bin/ldd',[runnerPath],{encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin'}});
    if(libraries.includes('not found'))throw Error('candidate runner library absent');
    for(const entry of libraries.match(/\/[A-Za-z0-9_./+-]+/g)??[]){const physical=fs.realpathSync(entry);let part='';for(const s of physical.split('/').filter(Boolean)){part+='/'+s;const st=fs.lstatSync(part);if(st.uid!==0||(st.mode&0o022)||st.isSymbolicLink())throw Error('candidate runner library permissions');}}
    const trust={version:1,runners:[{id:'node',path:runnerPath,sha256:data.nodeSha256}],caches:[{id:'empty',path:base+'/trust/caches/empty',files:[],projectFiles:data.projectFiles}]};
    const bytes=JSON.stringify(trust),target=base+'/trust/manifest.json';
    if(fs.existsSync(target)&&fs.readFileSync(target,'utf8')!==bytes)throw Error('candidate cache manifest drift');
    fs.writeFileSync(target,bytes,{mode:0o644});console.log(JSON.stringify({prefix:base,trustSha256:hash(bytes)}));`;
  const result=JSON.parse((await wslNode(program,{candidateSha256,files,projectFiles,nodeSha256},{maxBuffer:4096})).stdout);
  const configuration=createCandidateCheckConfiguration({candidateSha256,policyPath,trustSha256:result.trustSha256});
  return{candidateSha256,configuration,root,prefix,files:files.map(({path,sha256})=>({path,sha256}))};
}
export async function directCandidateChecks(candidate,{commands,files,timeout=180000}){
  const program=String.raw`import fs from'node:fs';import{randomUUID,randomBytes,createHash}from'node:crypto';import{execFileSync}from'node:child_process';`+readInput+String.raw`
    const base=data.prefix;
    if(!/^\/var\/lib\/pi-kether-candidates\/[a-f0-9]{64}\/root$/.test(base))throw Error('candidate prefix');
    const {runRootCheck}=await import(base+'/scripts/run-check-broker.mjs');
    const id=randomUUID(),job=base+'/jobs/'+id,group='/sys/fs/cgroup/yhwh-check-test-'+base.split('/')[4].slice(0,12)+'-'+id;
    const results=[];let mounted=false;
    try{
    fs.mkdirSync(job,{mode:0o711});execFileSync('/usr/bin/mount',['-t','tmpfs','-o','size=16M,nosuid,nodev,mode=0711','tmpfs',job]);mounted=true;
    fs.mkdirSync(job+'/workspace',{mode:0o700});const uid=Number(execFileSync('/usr/bin/id',['-u','pi-sandbox'],{encoding:'utf8'})),gid=Number(execFileSync('/usr/bin/id',['-g','pi-sandbox'],{encoding:'utf8'}));
    fs.chownSync(job+'/workspace',uid,gid);
    for(const [p,content] of Object.entries(data.files)){
      if(p.split('/').some(x=>!x||x==='.'||x==='..')||p.startsWith('/')||p.includes('\\'))throw Error('fixture path');
      fs.mkdirSync(job+'/workspace/'+p.split('/').slice(0,-1).join('/'),{recursive:true,mode:0o755});fs.writeFileSync(job+'/workspace/'+p,content,{mode:0o600});fs.chownSync(job+'/workspace/'+p,uid,gid);
    }
    // Same transient controller activation as the existing launcher, no permission/config edits.
    fs.writeFileSync('/sys/fs/cgroup/cgroup.subtree_control','+memory +cpu +pids\n');
    fs.mkdirSync(group);for(const [name,value]of Object.entries({'memory.max':'3221225472','memory.swap.max':'0','memory.oom.group':'1','pids.max':'128','cpu.max':'100000 100000','cgroup.subtree_control':'+memory +cpu +pids'}))fs.writeFileSync(group+'/'+name,value+'\n');fs.mkdirSync(group+'/model');
    const key=randomBytes(32).toString('hex'),trust=fs.readFileSync(base+'/trust/manifest.json');
    const secret={version:1,key,requestId:'candidate-check-'+id,jobId:id,taskSha256:'a'.repeat(64),policySha256:'b'.repeat(64),trustSha256:createHash('sha256').update(trust).digest('hex'),trustRoot:base+'/trust',deadline:Date.now()+data.timeout,commands:data.commands};
    fs.writeFileSync(job+'/check-secret.json',JSON.stringify(secret),{mode:0o600});fs.writeFileSync(job+'/check-state.json',JSON.stringify({attempts:0,receipts:0,chain:'0'.repeat(64),cleanupOk:true}),{mode:0o600});
      for(let i=0;i<data.commands.length;i++){
        const before=createHash('sha256').update(JSON.stringify(Object.entries(data.files).map(([p])=>[p,fs.readFileSync(job+'/workspace/'+p).toString('base64')]))).digest('hex');
        const result=await runRootCheck({secretFile:job+'/check-secret.json',stateFile:job+'/check-state.json',workspace:job+'/workspace',group,request:{checkId:i+1,commandId:data.commands[i].id},signal:new AbortController().signal});
        const after=createHash('sha256').update(JSON.stringify(Object.entries(data.files).map(([p])=>[p,fs.readFileSync(job+'/workspace/'+p).toString('base64')]))).digest('hex');
        results.push({...result,originalUnchanged:before===after,checkGroupRemoved:!fs.existsSync(group+'/check-'+(i+1))});
      }
    }finally{
      if(fs.existsSync(group)){if(fs.existsSync(group+'/cgroup.kill'))fs.writeFileSync(group+'/cgroup.kill','1\n');for(const name of fs.readdirSync(group).filter(n=>n==='model'||n.startsWith('check-')))fs.rmdirSync(group+'/'+name);fs.rmdirSync(group);}
      if(mounted)execFileSync('/usr/bin/umount',[job]);if(fs.existsSync(job))fs.rmSync(job,{recursive:true});
    }
    console.log('CANDIDATE_RESULTS='+JSON.stringify({results,parentRemoved:!fs.existsSync(group)}));`;
  const result=await wslNode(program,{prefix:candidate.prefix,commands,files,timeout},{timeout:timeout+20000,maxBuffer:3*1024*1024});
  const summary=result.stdout.split('\n').find(l=>l.startsWith('CANDIDATE_RESULTS='));
  if(!summary)throw Error('candidate results missing');return{...JSON.parse(summary.slice(18)),wire:result.stdout,stderr:result.stderr};
}

