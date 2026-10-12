import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVerify,validateCheckPolicy,authorizeRunChecks} from '../scripts/check-policy.mjs';
import {validateKetherTask,compileKetherTask} from '../extensions/kether-envelope.js';

const verify={commands:[{id:'unit-test',argv:['npm','test'],cwd:'.'}]};
const policy={version:1,projects:[{workspace:'/work/project',commands:[{argv:['npm','test'],cwd:'.',runnerId:'node-runner',cacheId:'npm-cache'}]}]};

test('compiled Chesed guidance bounds names and allows only explicit same-turn schema corrections',()=>{
  const task={role:'Chesed',objective:'Bounded fixture',writeScope:['file.js'],acceptance:['host regression']};
  const prompt=compileKetherTask(task,{structuredResultTool:true});
  assert.match(prompt,/at most 128 UTF-16 units/);assert.match(prompt,/unique, nonblank, non-NUL names/);
  assert.match(prompt,/exactly one successful yhwh_submit_result submission/);
  assert.match(prompt,/Only an explicit kether_result_rejection \/ RESULT_ROLE_SCHEMA_INVALID response/);
  assert.match(prompt,/error, timeout, unknown outcome, or successful submission does not permit retry/);
  const schema=JSON.parse(prompt.split('\n').find(l=>l.startsWith('RESULT_SCHEMA_JSON=')).slice('RESULT_SCHEMA_JSON='.length));
  assert.equal(schema.properties.deliverable.properties.checks.items.properties.name.maxLength,128);
  assert.equal(schema.properties.deliverable.properties.checks.maxItems,32);
});
test('verify is strict and rejects malicious shapes and command aliases',()=>{
  assert.equal(validateVerify(undefined),undefined);
  assert.deepEqual(validateVerify(verify),verify);
  for(const bad of [null,{}, {commands:[]}, {...verify,extra:true}, {commands:[{...verify.commands[0],id:'bad id'}]}, {commands:[verify.commands[0],verify.commands[0]]}, ...['sh','bash','dash','zsh','cmd','powershell','pwsh','env','sudo'].map(exe=>({commands:[{...verify.commands[0],argv:[exe,'-c','echo ok']}]})), {commands:[{...verify.commands[0],argv:['npm','../secret']}]}, {commands:[{...verify.commands[0],argv:['npm','; touch file']}]}, {commands:[{...verify.commands[0],cwd:'../'}]}, {commands:[{...verify.commands[0],extra:1}]}]) assert.throws(()=>validateVerify(bad));
});
test('policy intersection is exact, fail closed, and returns defensive copies',()=>{
  assert.deepEqual(validateCheckPolicy(policy),policy);
  const windowsPolicy={...policy,projects:[{...policy.projects[0],workspace:'E:/Projects/example'}]};
  assert.deepEqual(validateCheckPolicy(windowsPolicy),windowsPolicy);
  for(const workspace of ['//server/share','E:/Projects/../other','E:/Projects/name.','E:/Projects/name ']) assert.throws(()=>validateCheckPolicy({...policy,projects:[{...policy.projects[0],workspace}]}));
  const admitted=authorizeRunChecks({verify,policy,workspace:'/work/project'});
  assert.deepEqual(admitted,[{id:'unit-test',argv:['npm','test'],cwd:'.',runnerId:'node-runner',cacheId:'npm-cache'}]);
  admitted[0].argv[0]='changed';
  assert.equal(policy.projects[0].commands[0].argv[0],'npm');
  assert.throws(()=>authorizeRunChecks({verify,policy,workspace:'/work/other'}),e=>e.code==='PI_CHECK_POLICY_UNAVAILABLE');
  assert.throws(()=>authorizeRunChecks({verify:{commands:[{id:'other',argv:['npm','run','build'],cwd:'.'}]},policy,workspace:'/work/project'}),e=>e.code==='PI_CHECK_COMMAND_DENIED');
  assert.throws(()=>authorizeRunChecks({verify,policy:{...policy,extra:true},workspace:'/work/project'}),e=>e.code==='PI_CHECK_POLICY_UNAVAILABLE');
  assert.throws(()=>validateCheckPolicy({version:1,projects:[...policy.projects,policy.projects[0]]}));
});
test('verify envelope preserves legacy shape and adds sandbox warning only when requested',()=>{
  const old={role:'Chesed',objective:'legacy',writeScope:['file.js']};
  assert.equal(Object.hasOwn(validateKetherTask(old),'verify'),false);
  assert.equal(compileKetherTask(old).includes('TASK_PACKET_JSON='+JSON.stringify(validateKetherTask(old))),true);
  const task={...old,verify};
  assert.deepEqual(validateKetherTask(task).verify,verify);
  assert.match(compileKetherTask(task),/sandbox check tool does not replace required host checks/);
});
