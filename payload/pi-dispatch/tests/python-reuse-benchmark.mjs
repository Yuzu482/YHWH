// Compare the previous single-slot policy with two bounded Python backend slots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createProbeSessions} from '../scripts/lsp-sandbox-broker.mjs';
const workspace=process.argv[2],parent=path.dirname(workspace);
const group=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(s=>s.startsWith('0::')).slice(3);
assert.match(group,/^\/pi-kether-[a-f0-9-]{36}$/);
const cgroup='/sys/fs/cgroup'+group;
const memory=()=>Number(fs.readFileSync(cgroup+'/memory.current','utf8'));
const snapshots=()=>fs.readdirSync(parent).filter(p=>p.startsWith('lsp-probe-')).length;
const content='def answer() -> int:\n    return 42\nvalue: int = "wrong"\nanswer()\n';
fs.writeFileSync(path.join(workspace,'check.py'),content);
const methods=['diagnostics','hover','diagnostics','definition','diagnostics','references','diagnostics','symbols'];
const requests=methods.map((method,i)=>({lspId:i+1,tool:'lsp_'+method,params:{path:'check.py',...(['diagnostics','symbols'].includes(method)?{}:{line:4,character:2})}}));
const samples=[];
for(let round=0;round<2;round++){
  const comparable={};
  for(const mode of (round===0?['single','dual']:['dual','single'])){
    const sessions=createProbeSessions(workspace,{pythonDual:mode==='dual'});
    const values=[],queryMs=[];let peak=memory(),maxSnapshots=0,retainedMemoryBytes=0;
    const timer=setInterval(()=>{peak=Math.max(peak,memory());maxSnapshots=Math.max(maxSnapshots,snapshots());},25);
    const started=performance.now();
    try{
      for(let i=0;i<requests.length;i++){
        const begin=performance.now(),result=await sessions.run(requests[i],new AbortController().signal);
        queryMs.push(Math.round(performance.now()-begin));
        assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.modelCalls,0);
        assert.equal(result.serverSession.reused,mode==='dual'&&i>=2);
        assert.equal(result.adapter,methods[i]==='diagnostics'?'controlled-protocol':'official-jedi');
        if(methods[i]==='diagnostics')assert.ok(result.result.details.data.length>0,'intentional Python type error must be diagnosed');
        values.push(result.result.details.data);
      }
      retainedMemoryBytes=memory();peak=Math.max(peak,retainedMemoryBytes);maxSnapshots=Math.max(maxSnapshots,snapshots());
    }finally{clearInterval(timer);assert.equal((await sessions.close()).ok,true);}
    assert.equal(snapshots(),0);
    assert.equal(maxSnapshots,mode==='dual'?2:1);
    assert.ok(peak<Number(fs.readFileSync(cgroup+'/memory.max','utf8')));
    comparable[mode]=values;
    const sample={round:round+1,mode,calls:requests.length,queryMs,totalIncludingCleanupMs:Math.round(performance.now()-started),sampledPeakCgroupBytes:peak,retainedCgroupBytes:retainedMemoryBytes,maxSnapshots};
    samples.push(sample);console.log(JSON.stringify(sample));
  }
  assert.deepEqual(comparable.single,comparable.dual,'both policies must return identical semantic data');
}
const sum=mode=>samples.filter(s=>s.mode===mode).reduce((n,s)=>n+s.totalIncludingCleanupMs,0);
console.log(JSON.stringify({pythonBenchmarkPassed:true,equivalentResults:true,singleMs:sum('single'),dualMs:sum('dual'),speedup:Number((sum('single')/sum('dual')).toFixed(2)),resourceLimitBytes:Number(fs.readFileSync(cgroup+'/memory.max','utf8')),modelCalls:0}));
assert.ok(sum('dual')<sum('single'),'retaining both Python backends must improve the measured total');

// Both backend snapshots must expire; the next call starts a fresh server.
const idle=createProbeSessions(workspace,{idleMs:500});
try{
  assert.equal((await idle.run(requests[0],new AbortController().signal)).ok,true);
  assert.equal((await idle.run(requests[1],new AbortController().signal)).ok,true);
  const deadline=Date.now()+10000;
  while(snapshots()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  assert.equal(snapshots(),0);
  const result=await idle.run(requests[0],new AbortController().signal);assert.equal(result.serverSession.reused,false);
}finally{assert.equal((await idle.close()).ok,true);}
console.log(JSON.stringify({pythonIdleCleanup:true,modelCalls:0}));
