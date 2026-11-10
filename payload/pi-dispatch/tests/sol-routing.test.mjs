import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {resolveRoleModel} from '../scripts/role-policy.mjs';
import {validateKetherInvocation,dispatch} from '../scripts/dispatch.mjs';
import {enforceWorkerExecution,editorRouteAllowed} from '../scripts/worker-enforcement.mjs';
import {planCooperativeRun} from '../scripts/cooperative-run.mjs';
import {createGatewayRuntime} from '../scripts/gateway.mjs';
import {isSingleShotArgs} from '../scripts/pi-single-shot-lifecycle.mjs';
import {buildPiArgs} from '../scripts/worker-runtime/pi/args.mjs';

const cwd=process.cwd();
const task={role:'Chesed',objective:'Update one scoped source file',acceptance:['The output contains the requested result'],readScope:['src/a.js'],writeScope:['src/a.js']};
const invoke=(model,role='Chesed')=>validateKetherInvocation({cwd,access:'workspace-write',provider:'openai-codex',...(model?{model}:{}),task:{...task,role}},true,cwd);

test('code worker defaults to Terra; explicit Luna stays available without changing other roles',()=>{
 assert.equal(resolveRoleModel('worker').model,'gpt-6.1-terra');
 assert.equal(invoke().request.model,'gpt-6.1-terra');
 assert.equal(invoke('gpt-6-luna').request.model,'gpt-6-luna');
 assert.equal(invoke('gpt-6.1-terra').request.model,'gpt-6.1-terra');
 assert.equal(resolveRoleModel('Malkuth').model,'gpt-6-luna');
 assert.throws(()=>resolveRoleModel('Malkuth','gpt-6-sol'),/requires model/);
 assert.throws(()=>resolveRoleModel('Chesed','gpt-6-sol'),/requires model/);
 assert.throws(()=>resolveRoleModel('Chesed','gpt-5.5'),/requires model/);
});

test('Terra code access remains role-bound and Sol stays reviewer-only',()=>{
 const base={provider:'openai-codex',model:'gpt-6.1-terra'};
 assert.doesNotThrow(()=>enforceWorkerExecution({...base,access:'workspace-write',task:{role:'Chesed'}}));
 assert.throws(()=>enforceWorkerExecution({...base,access:'workspace-write',task:{role:'Malkuth'}}),{code:'YHWH_WORKER_ENFORCEMENT_REJECTED'});
 assert.throws(()=>enforceWorkerExecution({...base,access:'none',task:{role:'Geburah'}}),{code:'YHWH_WORKER_ENFORCEMENT_REJECTED'});
 assert.throws(()=>enforceWorkerExecution({...base,access:'workspace-write'}),{code:'YHWH_WORKER_ENFORCEMENT_REJECTED'});
 const sol={provider:'openai-codex',model:'gpt-6-sol'};
 assert.throws(()=>enforceWorkerExecution({...sol,access:'workspace-write',task:{role:'Chesed'}}),{code:'YHWH_WORKER_ENFORCEMENT_REJECTED'});
 assert.doesNotThrow(()=>enforceWorkerExecution({...sol,access:'none',reviewerValidated:true,task:{role:'Geburah'}}));
 assert.equal(editorRouteAllowed('openai-codex','gpt-6.1-terra'),false);
 assert.equal(editorRouteAllowed('openai-codex','gpt-6-luna'),true);
});

test('a no-tools Terra code worker does not enter the reviewer-only validation branch',async()=>{
 const input=validateKetherInvocation({cwd,access:'none',provider:'openai-codex',model:'gpt-6.1-terra',task:{role:'Chesed',objective:'Produce a concise code sketch',acceptance:['Output contains a sketch']}},false,cwd);
 const original=process.env.PI_DISPATCH_SANDBOX;process.env.PI_DISPATCH_SANDBOX='wsl2-bwrap';let authenticated=0;
 const fake={id:'fixture',prepareAuthentication:async()=>{authenticated++;return {authentication:{ok:true}};},prepare:()=>({}),run:async()=>({phaseTimings:{}}),summarize:()=>({ok:true})};
 try{const result=await dispatch(input.request,undefined,input.task,{runtimeResolver:()=>fake});assert.equal(result.ok,true);assert.equal(authenticated,1);}
 finally{if(original===undefined)delete process.env.PI_DISPATCH_SANDBOX;else process.env.PI_DISPATCH_SANDBOX=original;}
});

test('cooperative runs route writes to Terra and read-only work to Luna',()=>{
 const spec={cwd,parentRunId:'sol-route-test',runGoal:'Check routes',runAcceptance:['Both units pass'],writeTier:'T1',tierDeclaration:{publicApiOrProtocol:false,dependencyOrLockfile:false,securityAuthOrCredentials:false,migration:false,irreversibleOrNoRollback:false},units:[{id:'write',objective:'Edit',acceptance:['The file matches'],readScope:['src/a.js'],writeScope:['src/a.js']},{id:'read',objective:'Read',acceptance:['The report contains the finding'],readScope:['src/b.js'],writeScope:[]}]};
 const p=planCooperativeRun(spec);assert.equal(p.requests[0].model,'gpt-6.1-terra');assert.equal(p.requests[1].model,'gpt-6-luna');
 const light=structuredClone(spec);light.units[0].context=['TASK_COMPLEXITY_JSON='+JSON.stringify({changeKind:'exact',uncertainty:'none',coupling:'local',reason:'Small bounded code edit'})];
 assert.equal(planCooperativeRun(light).requests[0].model,'gpt-6-luna');
});

test('gateway capabilities advertise both the code default and explicit alternate',async()=>{
 const runtime=createGatewayRuntime({roots:[cwd],sandboxStatus:{ok:false,backend:'unavailable'}});
 try{const c=runtime.capabilities();assert.equal(c.governance.roleModels.Chesed,'gpt-6.1-terra');assert.deepEqual(c.governance.roleModelAlternates.Chesed,['gpt-6-luna']);assert.equal(c.governance.roleModels.Malkuth,'gpt-6-luna');}
 finally{await runtime.shutdown({graceMs:0,abortWaitMs:0});}
});

test('offline task-plan emits the resolved model and preserves explicit Luna',t=>{
 const dir=mkdtempSync(join(tmpdir(),'kether-sol-plan-'));
 t.after(()=>{assert.equal(dirname(dir),tmpdir());assert.match(dir,/kether-sol-plan-/);rmSync(dir,{recursive:true,force:true});});
 const file=join(dir,'request.json');
 function plan(model,chosenTask=task,extras={}){
  writeFileSync(file,JSON.stringify({cwd,access:'workspace-write',...(model?{model}:{}),task:chosenTask,...extras}));
  const result=spawnSync(process.execPath,['scripts/gateway-client.mjs','task-plan',file],{cwd,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
 }
 assert.equal(plan().request.model,'gpt-6.1-terra');
 assert.equal(plan('gpt-6-luna').request.model,'gpt-6-luna');
 const light={...task,context:['TASK_COMPLEXITY_JSON='+JSON.stringify({changeKind:'exact',uncertainty:'none',coupling:'local',reason:'Small bounded code edit'})]};
 assert.equal(plan(undefined,light).request.model,'gpt-6-luna');
 assert.equal(plan('gpt-6.1-terra',light).request.model,'gpt-6.1-terra');
 assert.equal(plan(undefined,task,{editorAuthorization:{}}).request.model,'gpt-6-luna');
});

test('Terra code worker qualifies for the pinned WSL single-shot lifecycle',()=>{
 const args=buildPiArgs({rolePresetId:'Chesed',provider:'openai-codex',model:'gpt-6.1-terra',thinking:'medium',access:'workspace-write'},'wsl2',false,true,true);
 assert.equal(isSingleShotArgs(args),true);
});
