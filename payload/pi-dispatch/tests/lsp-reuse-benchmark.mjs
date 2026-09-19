// Deterministic real-server comparison inside the test task's bounded cgroup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createProbeSessions,runProbe} from '../scripts/lsp-sandbox-broker.mjs';
const workspace=process.argv[2];
fs.writeFileSync(path.join(workspace,'check.ts'),'const value: number = "wrong";\nconsole.log(value);\n');
const queries=['diagnostics','hover','symbols','definition','references','diagnostics'].map((method,i)=>({lspId:i+1,tool:'lsp_'+method,
  params:{path:'check.ts',...(['diagnostics','symbols'].includes(method)?{}:{line:2,character:13})}}));
const samples=[];
for(let round=0;round<2;round++){
  const comparable={};
  for(const mode of (round===0?['cold','warm']:['warm','cold'])){
    const sessions=mode==='warm'?createProbeSessions(workspace):null;
    const values=[],times=[];const started=performance.now();
    try{
      for(const request of queries){
        const before=performance.now();
        const result=await (sessions?sessions.run(request,new AbortController().signal):runProbe(workspace,request,new AbortController().signal));
        times.push(Math.round(performance.now()-before));
        assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.modelCalls,0);
        if(sessions)assert.equal(result.serverSession.reused,values.length>0);
        else assert.equal(result.serverCleanup.ok,true);
        if(request.tool==='lsp_diagnostics')assert.ok(result.result.details.data.some(d=>d.code===2322));
        values.push(result.result.details.data);
      }
    }finally{if(sessions)assert.equal((await sessions.close()).ok,true);}
    comparable[mode]=values;
    const sample={round:round+1,mode,calls:times.length,queryMs:times,totalIncludingCleanupMs:Math.round(performance.now()-started)};
    samples.push(sample);console.log(JSON.stringify(sample));
  }
  assert.deepEqual(comparable.cold,comparable.warm,'reuse must preserve semantic results');
}
// Also prove a real server can expire while idle, then start again.
const idle=createProbeSessions(workspace,{idleMs:100});
assert.equal((await idle.run(queries[1],new AbortController().signal)).ok,true);
const deadline=Date.now()+10000;
while(fs.readdirSync(path.dirname(workspace)).some(p=>p.startsWith('lsp-probe-'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
assert.ok(!fs.readdirSync(path.dirname(workspace)).some(p=>p.startsWith('lsp-probe-')));
const restarted=await idle.run(queries[1],new AbortController().signal);assert.equal(restarted.serverSession.generation,2);assert.equal(restarted.serverSession.reused,false);
assert.equal((await idle.close()).ok,true);
const sum=mode=>samples.filter(s=>s.mode===mode).reduce((n,s)=>n+s.totalIncludingCleanupMs,0);
console.log(JSON.stringify({benchmarkPassed:true,equivalentResults:true,realIdleCleanup:true,coldMs:sum('cold'),warmMs:sum('warm'),speedup:Number((sum('cold')/sum('warm')).toFixed(2)),modelCalls:0}));
assert.ok(sum('warm')<sum('cold'),'real repeated queries must improve total time');
