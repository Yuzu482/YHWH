import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../scripts/headless-adapters.mjs';
import { acceptHeadless } from '../scripts/headless-acceptance.mjs';

function fixture(t,wait=true) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-acceptance-test-'));
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true})});
 const script=path.join(root,'cli.mjs');
 fs.writeFileSync(script,`const args=process.argv.slice(2);if(args.includes('--version'))console.log('fixture 1');else if(args.includes('--help'))console.log(${JSON.stringify(adapters.codex.requiredFlags.join(' '))});else{let s='';for await(const c of process.stdin)s+=c;if(${wait}&&s.includes('cancellation test'))await new Promise(()=>{setInterval(()=>{},1000)});const text=s.match(/YHWH_OK_[a-f0-9]{32}/)?.[0]??'missing';console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));console.log(JSON.stringify({type:'turn.completed'}));}`);
 return {schemaVersion:1,workspaceRoots:[root],timeoutSeconds:10,maxOutputBytes:65536,clients:{codex:{enabled:true,executable:process.execPath,nodeScript:script,expectedVersion:'fixture 1',model:'fixture',policy:'read-only'}}};
}
test('live cancellation starts only after CLI launch and confirms the requested stop',async t=>{
 const result=await acceptHeadless(fixture(t),{live:true,cancel:true});
 assert.equal(result.clients.codex.response,'passed');assert.equal(result.clients.codex.cancellation,'passed');
 assert.equal(result.clients.codex.cancellationEvidence.started,true);assert.equal(result.clients.codex.cancellationEvidence.cancelRequested,true);
 assert.equal(result.complete,false);assert.equal(result.clients.codex.permissions,'unverified');
});
test('completion before the cancellation timer is not a successful cancellation',async t=>{
 const result=await acceptHeadless(fixture(t,false),{live:true,cancel:true});
 assert.equal(result.clients.codex.cancellation,'unverified');assert.equal(result.clients.codex.cancellationEvidence.reason,'completed_before_cancel');
});
test('cancellation cannot silently turn offline acceptance into a model call',async t=>{
 await assert.rejects(acceptHeadless(fixture(t),{cancel:true}),/live_required/);
});
test('fixture setup failure is a failed live check rather than an unverified success',async t=>{
 const config=fixture(t),original=process.env.PATH;
 try{process.env.PATH='';const result=await acceptHeadless(config,{live:true});assert.equal(result.clients.codex.response,'failed');assert.equal(result.clients.codex.reason,'fixture_or_launch_failed')}
 finally{process.env.PATH=original}
});
