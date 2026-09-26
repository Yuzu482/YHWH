import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflowReceipts} from '../scripts/workflow-receipts.mjs';

test('receipts are unique, topic- and digest-bound, and expire',()=>{
  let time=1000;
  const receipts=createWorkflowReceipts({ttlMs:100,maxEntries:2,now:()=>time});
  const first=receipts.issue('project-memory','a');
  const second=receipts.issue('project-memory','a');
  assert.notEqual(first.receipt,second.receipt);
  assert.equal(receipts.check('project-memory','a',first.receipt),true);
  assert.equal(receipts.check('code-graph','a',first.receipt),false);
  assert.equal(receipts.check('project-memory','b',first.receipt),false);
  assert.equal(receipts.check('project-memory','a',''),false);
  time=1100;
  assert.equal(receipts.check('project-memory','a',first.receipt),false);
  assert.equal(receipts.check('project-memory','a',second.receipt),false);
});

test('receipt store is bounded and clears on shutdown',()=>{
  const receipts=createWorkflowReceipts({maxEntries:2});
  const first=receipts.issue('a','a').receipt;
  const second=receipts.issue('a','a').receipt;
  assert.equal(receipts.check('a','a',first),true);
  const third=receipts.issue('a','a').receipt;
  assert.equal(receipts.check('a','a',first),false);
  assert.equal(receipts.check('a','a',second),true);
  assert.equal(receipts.check('a','a',third),true);
  receipts.clear();
  assert.equal(receipts.check('a','a',third),false);
});

test('invalid receipt limits fail before gateway admission',()=>{
  assert.throws(()=>createWorkflowReceipts({maxEntries:0}),/Invalid workflow receipt limits/);
  assert.throws(()=>createWorkflowReceipts({ttlMs:0}),/Invalid workflow receipt limits/);
});
