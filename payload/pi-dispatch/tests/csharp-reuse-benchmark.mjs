// Compare old and exit-aware csharp cleanup with identical commands and limits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createProbeSessions,probeSandboxArgs} from '../scripts/lsp-sandbox-broker.mjs';
const workspace=process.argv[2],parent=path.dirname(workspace),stage=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const group=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(s=>s.startsWith('0::')).slice(3);
assert.match(group,/^\/pi-kether-[a-f0-9-]{36}$/);
const cgroup='/sys/fs/cgroup'+group;
const metric=name=>Number(fs.readFileSync(cgroup+'/'+name,'utf8'));
const cpu=()=>Number(fs.readFileSync(cgroup+'/cpu.stat','utf8').match(/usage_usec (\d+)/)[1]);
const snapshots=()=>fs.readdirSync(parent).filter(p=>p.startsWith('lsp-probe-')).length;
const samples=[];
for(const language of ['csharp']){
  const filename='check.cs';
  const text='class Sample {\n  static int Answer() { return 42; }\n  static int Run() { int value = "wrong"; return Answer() + value; }\n}\n';
  fs.writeFileSync(path.join(workspace,filename),text);
  const character=text.split('\n')[2].indexOf('Answer')+1;
  const methods=['diagnostics','hover','definition','references','symbols','completions','code_actions','diagnostics'];
  const requests=methods.map((method,i)=>({lspId:i+1,tool:'lsp_'+method,params:{path:filename,...(['diagnostics','symbols'].includes(method)?{}:{line:3,character})}}));
  for(let round=1;round<=2;round++){
    const comparable={};
    for(const mode of (round===1?['baseline','tuned']:['tuned','baseline'])){
      const sessions=createProbeSessions(workspace,{launch:snapshot=>{
        const args=probeSandboxArgs(snapshot,filename),at=args.lastIndexOf('--');
        args.splice(at,0,'--ro-bind',path.join(stage,'csharp-'+mode+'.py'),'/opt/pi-kether/scripts/multilspy-probe.py');
        return spawn('/usr/bin/setpriv',[...args,'--session'],{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin'},windowsHide:true});
      }});
      const values=[],queryMs=[];let peakMemory=metric('memory.current'),peakTasks=metric('pids.current'),cleanupMs=0;
      const sample=()=>{peakMemory=Math.max(peakMemory,metric('memory.current'));peakTasks=Math.max(peakTasks,metric('pids.current'));};
      const timer=setInterval(sample,10),start=performance.now(),cpuStart=cpu();
      try{
        for(const [i,request] of requests.entries()){
          const begin=performance.now(),result=await sessions.run(request,new AbortController().signal);
          queryMs.push(Math.round(performance.now()-begin));sample();
          assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.modelCalls,0);
          assert.equal(result.adapter,'controlled-protocol');assert.equal(result.serverSession.reused,i>0);
          assert.equal(result.serverSession.poolCapacity,1);assert.equal(snapshots(),1);
          if(methods[i]==='diagnostics'){assert.equal(result.diagnosticsPublished,true);assert.ok(result.result.details.data.some(d=>d.code==='CS0029'));}
          if(['hover','definition','references','symbols','completions'].includes(methods[i]))assert.equal(result.status,'success');
          let data=result.result.details.data;
          if(methods[i]==='completions'){
            // csharp-ls creates per-process completion resolve handles. Compare
            // every suggestion field, while validating/removing only that UUID.
            const clean=item=>{assert.match(item.data,/^[a-f0-9-]{36}$/);const {data,...semantic}=item;return semantic;};
            data=Array.isArray(data)?data.map(clean):{...data,items:data.items.map(clean)};
          }
          values.push(data);
        }
      }finally{clearInterval(timer);const closing=performance.now();assert.equal((await sessions.close()).ok,true);cleanupMs=Math.round(performance.now()-closing);}
      assert.equal(snapshots(),0);
      comparable[mode]=values;
      const row={language,round,mode,calls:requests.length,queryMs,cleanupMs,totalMs:Math.round(performance.now()-start),cpuUsec:cpu()-cpuStart,peakMemoryBytes:peakMemory,peakTasks};
      samples.push(row);console.log(JSON.stringify(row));
    }
    assert.deepEqual(comparable.baseline,comparable.tuned,'csharp profiles must preserve semantic results');
  }
}
const summaries=['csharp'].map(language=>{
  const rows=mode=>samples.filter(s=>s.language===language&&s.mode===mode);
  const sum=(mode,key)=>rows(mode).reduce((n,s)=>n+s[key],0);
  const peak=(mode,key)=>Math.max(...rows(mode).map(s=>s[key]));
  return {language,baselineMs:sum('baseline','totalMs'),tunedMs:sum('tuned','totalMs'),speedup:Number((sum('baseline','totalMs')/sum('tuned','totalMs')).toFixed(2)),baselinePeakTasks:peak('baseline','peakTasks'),tunedPeakTasks:peak('tuned','peakTasks'),baselinePeakMemory:peak('baseline','peakMemoryBytes'),tunedPeakMemory:peak('tuned','peakMemoryBytes')};
});

console.log(JSON.stringify({csharpBenchmarkPassed:true,equivalentResults:true,normalizedCompletionHandles:true,summaries,modelCalls:0}));
