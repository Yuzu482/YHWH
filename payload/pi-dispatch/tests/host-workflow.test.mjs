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

test('returns the frozen coordinator-only primary policy',()=>{
  assert.equal(Object.isFrozen(primaryPolicy),true);
  assert.deepEqual(primaryPolicy,{
    mode:'coordinator-only',
    implementationOwner:'pi-subagents',
    directCoding:false,
    unavailableWorkerAction:'blocked',
    enforcement:'host-instructions',
  });
  assert.deepEqual(workflowTopic('primary').primaryPolicy,primaryPolicy);
  assert.match(workflowInstructions,/delegate.*Pi subagents/i);
  assert.match(workflowInstructions,/block instead/i);
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
