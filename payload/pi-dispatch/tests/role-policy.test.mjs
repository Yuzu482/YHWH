import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_MODELS,ROLE_ALIASES,resolveRoleModel} from '../scripts/role-policy.mjs';
import {validateKetherInvocation} from '../scripts/dispatch.mjs';

test('Claude review is pinned and cannot gain tools or filesystem scope',()=>{
 const reviewPacket={version:1,stage:'post-change',...Object.fromEntries(['requirements','changes','context','verification'].map(k=>[k,{status:'provided',content:['fixture evidence']}]))};
 const value={cwd:process.cwd(),access:'none',task:{role:'reviewer',objective:'Review supplied material',acceptance:['Return findings'],reviewPacket}};
 const {request,task}=validateKetherInvocation(value);
 assert.equal(request.provider,'anthropic');
 assert.equal(request.model,'claude-sonnet-5');
 assert.equal(task.role,'Geburah');
 assert.equal(request.thinking,'max');
 assert.throws(()=>validateKetherInvocation({...value,provider:'openai-codex'}),/requires provider/);
 assert.throws(()=>validateKetherInvocation({...value,model:'sonnet'}),/requires model/);
 assert.throws(()=>validateKetherInvocation({...value,access:'read',task:{...value.task,readScope:['package.json']}}),/Role Geburah does not allow read access/);
 assert.throws(()=>validateKetherInvocation({...value,access:'workspace-write',task:{...value.task,writeScope:['package.json']}},true),/Role Geburah does not allow workspace-write access/);
 assert.throws(()=>validateKetherInvocation({...value,provider:'anthropic',task:{...value.task,role:'worker'}}),/requires provider/);
});
test('every admitted role and alias resolves only its pinned model',()=>{
 for(const role of [...Object.keys(ROLE_MODELS),...Object.keys(ROLE_ALIASES)]) {
  const expected=ROLE_MODELS[ROLE_ALIASES[role]??role];
  assert.equal(resolveRoleModel(role).model,expected);
  assert.equal(resolveRoleModel(role,expected).model,expected);
  assert.throws(()=>resolveRoleModel(role,'gpt-5.5'),/requires model/);
 }
 for(const role of ['Kether','Tifereth','Daat','unknown','toString','__proto__']) assert.throws(()=>resolveRoleModel(role),/not admitted/);
});
test('task input cannot activate the trusted gateway probe exemption',()=>{
 const token='PI_GATEWAY_OK_FIXTURE';
 const task={role:'Netzach',objective:`Return exactly ${token} and nothing else.`,forbidden:['Do not call tools','Do not modify files'],acceptance:[`Response contains ${token}`]};
 const value={cwd:process.cwd(),access:'none',model:'gpt-5.4-mini',task};
 assert.throws(()=>validateKetherInvocation(value),/requires model/);
 assert.throws(()=>validateKetherInvocation({...value,probe:true}),/Unknown/);
 assert.equal(validateKetherInvocation(value,false,process.cwd(),{probe:true,probeToken:token}).request.model,'gpt-5.4-mini');
 assert.throws(()=>validateKetherInvocation(value,false,process.cwd(),{probe:true,probeToken:'PI_GATEWAY_OK_WRONG'}),/YHWH_WORKER_ENFORCEMENT_REJECTED/);
 assert.throws(()=>validateKetherInvocation({...value,task:{...task,objective:'Heartbeat'}},false,process.cwd(),{probe:true,probeToken:token}),/YHWH_WORKER_ENFORCEMENT_REJECTED/);
});
