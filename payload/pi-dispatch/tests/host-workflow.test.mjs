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

test('distinguishes host discretion from the legacy Pi direct-coding flag',()=>{
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
  assert.match(workflowInstructions,/Pi is optional/i);
  assert.match(workflowInstructions,/Pi calls remain subject/i);
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

test('Pi delegation guidance does not require Pi for direct host work',()=>{
  for(const topic of ['delegation','skill:kether-governance']) {
    const content=workflowTopic(topic).content;
    assert.match(content,/do not govern direct host work/i);
    assert.match(content,/preserve existing task identities, quotas and history/i);
  }
});

test('legacy topic context distinguishes Pi rules from direct host permissions',()=>{
  for(const topic of ['primary','coordinator-only','task-tiers']) {
    assert.match(workflowTopic(topic).content,/do not govern (?:ordinary )?direct host work/i);
    assert.match(workflowTopic(topic).content,/preserve existing task identities, quotas and history/i);
  }
  for(const topic of ['coordinator-only','task-tiers']) {
    assert.match(workflowTopic(topic).content,/historical maintenance records remain subject to their own host requirements and explicitly user-authorized quotas/i);
  }
  assert.match(workflowTopic('coordinator-only').content,/historical native adapter/);
  assert.match(workflowTopic('task-tiers').content,/legacy controlled reviewer API/);
});
