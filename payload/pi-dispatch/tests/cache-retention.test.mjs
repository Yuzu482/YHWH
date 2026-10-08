import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {hostRecordDigest} from '../extensions/host-verification.js';

const day=86_400_000;
const key=id=>createHash('sha256').update(id,'utf8').digest('hex');
function temp(t){const dir=mkdtempSync(join(tmpdir(),'yhwh-cache-retention-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('prune expires ordinary cache while preserving standalone outcomes and linked cache',t=>{
 const dir=temp(t),ledger=createRequestLedger(dir);
 for(const [id,mode] of [['ordinary-cache','standalone'],['linked-cache','linked']]){
  ledger.recordOutcome(id,{ok:true,contract:{mode}});
  assert.equal(ledger.saveMonitorResult(id,{state:'completed',result:{ok:true,text:`result ${id}`}}),true);
 }
 const cachePath=id=>join(dir,'result-cache',`${key(id)}.json`),outcomePath=id=>join(dir,'outcomes',`${key(id)}.json`);
 assert.ok(existsSync(cachePath('ordinary-cache')));assert.ok(existsSync(outcomePath('ordinary-cache')));
 const report=ledger.prune(Date.now()+15*day);
 assert.ok(report.deletedEntries>=1);assert.equal(existsSync(cachePath('ordinary-cache')),false);
 assert.equal(existsSync(outcomePath('ordinary-cache')),true);
 assert.equal(ledger.getOutcome('ordinary-cache').contract.mode,'standalone');
 assert.equal(existsSync(cachePath('linked-cache')),true);
 assert.equal(ledger.readMonitorResult('linked-cache').result.text,'result linked-cache');
});

test('failed result cache uses critical retention window: survives 15 days and expires after 91',t=>{
 const dir=temp(t),ledger=createRequestLedger(dir),id='failed-cache';
 assert.equal(ledger.saveMonitorResult(id,{state:'failed',result:{ok:false,error:'synthetic failure'}}),true);
 const path=join(dir,'result-cache',`${key(id)}.json`);assert.ok(existsSync(path));
 ledger.prune(Date.now()+15*day);assert.ok(existsSync(path));
 ledger.prune(Date.now()+91*day);assert.equal(existsSync(path),false);
});

test('host pending subtree bytes are protected and reported when capacity is exceeded',t=>{
 const dir=temp(t),ledger=createRequestLedger(dir,{retention:{totalBytes:1}}),id='synthetic-host-pending';
 const originalResult={response:{ok:true,text:'protected host source'}};
 const workspace='/synthetic-workspace';
 const contractTemplate={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,workspaceSha256:createHash('sha256').update(workspace).digest('hex'),resultSha256:'a'.repeat(64)};
 const pending={requestId:id,artifactSha256:'b'.repeat(64),resultSha256:createHash('sha256').update(JSON.stringify(originalResult)).digest('hex'),workspace,parentRunId:null,goal:'synthetic retention fixture',phase:1,requiredCheckNames:['synthetic check']};
 pending.resultSha256=hostRecordDigest(originalResult);
 ledger.registerHostPending(pending,{originalResult,contractTemplate});
 const dirPath=join(dir,'host-verification',key(id));
 const before=['pending.json','original.json'].reduce((n,name)=>n+statSync(join(dirPath,name)).size,0);
 assert.ok(before>0);assert.equal(ledger.listHostPending().length,1);
 const report=ledger.prune(Date.now()+120*day);
 assert.ok(report.capacityExceededByProtectedRecords>0);
 assert.equal(existsSync(join(dirPath,'pending.json')),true);assert.equal(existsSync(join(dirPath,'original.json')),true);
 assert.equal(ledger.listHostPending()[0].requestId,id);
});
