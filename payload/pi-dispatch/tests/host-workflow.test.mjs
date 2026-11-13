import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
  primaryPolicy,
  registerHostWorkflow,
  workflowInstructions,
  workflowTopic,
} from '../scripts/host-workflow.mjs';

const catalog=JSON.parse(readFileSync(new URL('../workflow/catalog.json',import.meta.url),'utf8'));

test('returns host-selected primary policy without changing Pi admission',()=>{
  assert.equal(Object.isFrozen(primaryPolicy),true);
  assert.deepEqual(primaryPolicy,{
    mode:'host-selected',
    implementationOwner:'primary-or-delegate',
    directCoding:false,
    directCodingScope:'legacy Pi coordinator-only channel; not a statement of primary host permissions',
    hostDirectCoding:'determined by current host instructions and user authorization',
    unavailableWorkerAction:'continue-authorized-work',
    enforcement:'host-instructions',
  });
  assert.deepEqual(workflowTopic('primary').primaryPolicy,primaryPolicy);
  assert.match(workflowInstructions,/may work directly or delegate/i);
  assert.match(workflowInstructions,/Pi calls remain subject to their advertised role, tier, review and ledger checks/i);
  assert.match(workflowInstructions,/Preserve existing task identity, history and explicit limits/i);
});

test('packaged primary and Pi references preserve optional routing and Pi safety',()=>{
  assert.match(catalog.topics.primary,/Pi provides optional governed execution/i);
  assert.match(catalog.topics.primary,/primary may work directly or delegate/i);
  assert.match(catalog.topics.primary,/T2 approved pre\+worker\+bound host proof\+post/i);
  assert.match(catalog.topics['coordinator-only'],/does not prohibit ordinary primary-host work/i);
  assert.match(catalog.topics['task-tiers'],/actual Pi-governed tasks/i);
  assert.match(catalog.topics['delegation'],/do not change backend to evade/i);
  assert.match(catalog.topics['skill:kether-governance'],/Pi T2 pre-review precedes writes/i);
});

test('exposes only the governance skill as a skill topic',()=>{
  assert.deepEqual(workflowTopic('primary').availableTopics.filter(topic=>topic.startsWith('skill:')),['skill:kether-governance']);
});

test('preserves catalog content and hash fields',()=>{
  const response=workflowTopic('primary');
  const content=catalog.topics.primary;
  assert.equal(response.version,catalog.version);
  assert.equal(response.content,content);
  assert.equal(response.sha256,createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(response.availableTopics,Object.keys(catalog.topics));
  assert.equal(response.enforcement,'Pi invocation checks only; host compliance is not attested');
});

test('always-visible primary index and Pi dispatch skill stay within the context budget',()=>{
  const skill=readFileSync(new URL('../skills/pi-dispatch/SKILL.md',import.meta.url),'utf8');
  const primary=catalog.topics.primary;
  assert.ok(Buffer.byteLength(primary,'utf8')+Buffer.byteLength(skill,'utf8')<=8000);
  assert.match(primary,/\| Trigger \| Topic \|/);
  assert.match(primary,/host has not injected it/);
  assert.match(primary,/Before Pi routing or execution, call `list_capabilities`/);
  assert.doesNotMatch(primary,/api_key_dpapi envelopes/);
});

test('rejects an unknown workflow topic',()=>{
  assert.throws(()=>workflowTopic('unknown-topic'),/Unknown workflow topic/);
});

test('registered MCP handler returns the workflow response',async()=>{
  let registration;
  const server={
    registerTool(name,options,handler){registration={name,options,handler};},
  };
  registerHostWorkflow(server);
  assert.equal(registration.name,'get_workflow');
  const result=await registration.handler({topic:'primary'});
  assert.equal(result.content.length,1);
  assert.equal(result.content[0].type,'text');
  assert.deepEqual(JSON.parse(result.content[0].text),workflowTopic('primary'));
});
