import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeWorkflowDisclosure} from '../scripts/workflow-disclosure-report.mjs';

test('disclosure report counts retrieval and gate outcomes without confusing them with model recall',()=>{
  const result=summarizeWorkflowDisclosure([
    {operation:'get_workflow',topic:'project-memory'},
    {operation:'workflow_topic_required',topic:'project-memory'},
    {operation:'workflow_topic_admitted',topic:'project-memory'},
    {operation:'workflow_topic_admitted',topic:'code-graph'},
    {operation:'dispatch_subagent',topic:'project-memory'},
    {operation:'get_workflow',topic:'bad/secret'},
  ]);
  assert.equal(result.metric,'gateway gate attempts; not model trigger recall');
  assert.deepEqual(result.topics['project-memory'],{reads:1,admitted:1,blocked:1,gatePassRate:0.5});
  assert.deepEqual(result.topics['code-graph'],{reads:0,admitted:1,blocked:0,gatePassRate:1});
  assert.equal(result.topics['bad/secret'],undefined);
});
