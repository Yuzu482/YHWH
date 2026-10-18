import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {captureFrozenPatch,verifyFrozenPatch,verifyFrozenFiles} from '../scripts/frozen-patch.mjs';
import {projectHostEvidence} from '../scripts/host-evidence-state.mjs';
import {inspectCheckCoverage} from '../scripts/check-coverage.mjs';
import {createHostPending,createHostAttestation} from '../extensions/host-verification.js';
const sha=s=>createHash('sha256').update(s).digest('hex'),start='2026-10-13T01:00:00Z',at='2026-10-13T02:00:00Z',until='2026-10-14T00:00:00Z';
const file=(path,before,after)=>({path,before,after,beforeSha256:before===null?null:sha(before),afterSha256:after===null?null:sha(after)});
function fixture(id,exitCode=0){
 const artifact=sha(id),workspace='E:\\fixture',parentRunId='parent';
 const pending=createHostPending({requestId:id,artifactSha256:artifact,resultSha256:sha('result'),workspace,parentRunId,goal:'fixture',phase:1,requiredCheckNames:['host']});
 const attestation=createHostAttestation(pending,{requestId:id,artifactSha256:artifact,commands:[{checkName:'host',command:'fixture',exitCode,outputSummary:'actual fixture output'}]},{timestamp:Date.parse(at)});
 const dispatch={requestId:id,parentRunId,workspaceSha256:sha(workspace),startedAt:start,patch:{sha256:artifact},outcome:'awaiting-host-verification'};
 const host={requestId:id,parentRunId,workspaceSha256:sha(workspace),operation:'record_host_verification',timestamp:at,hostVerification:{outcome:exitCode?'failed':'completed',artifactSha256:artifact,recordSha256:attestation.recordSha256}};
 const accepted={...dispatch,operation:'task_accepted',timestamp:at,verification:{state:'completed',artifactSha256:artifact,recordSha256:attestation.recordSha256}};
 return {pending,attestation,dispatch,host,accepted};
}
test('20 deliveries: seven failed and seven abandoned are not active pending; two host failures remain visible; include both host failures',()=>{
 const dispatches=[],events=[],hostRecords=[];
 for(let i=0;i<20;i++){const f=fixture('r'+i,i>=18?1:0);dispatches.push(f.dispatch);if(i<7)f.dispatch.outcome='failed';else{hostRecords.push(f);if(i<14)events.push({requestId:f.dispatch.requestId,parentRunId:f.dispatch.parentRunId,workspaceSha256:f.dispatch.workspaceSha256,operation:'abandon_artifact',timestamp:at,artifactSha256:f.pending.artifactSha256});else{events.push(f.host);if(i<18)events.push(f.accepted);}}}
 const input={dispatches:[...dispatches,...dispatches],events:[...events,...events],hostRecords,until},before=JSON.stringify(input),p=projectHostEvidence(input);
 assert.equal(p.rows.length,20);assert.equal(p.rows.filter(r=>r.state==='delivery-failed').length,7);assert.equal(p.rows.filter(r=>r.state==='abandoned').length,7);assert.equal(p.rows.filter(r=>r.state==='accepted-recorded').length,4);assert.equal(p.rows.filter(r=>r.state==='host-failed').length,2);assert.deepEqual(p.firstHost,{passed:4,denominator:6,missing:14,unverified:0});assert.equal(JSON.stringify(input),before);assert.equal(p.acceptanceAuthority,false);
});
test('wrong identities, fingerprints, earlier/future events and forged pending never close a candidate',()=>{
 const f=fixture('r'),run=(events,hostRecords=[f])=>projectHostEvidence({dispatches:[f.dispatch],events,hostRecords,until}).rows[0];
 for(const e of [{...f.host,parentRunId:'foreign'},{...f.host,workspaceSha256:sha('foreign')},{...f.host,timestamp:'2026-10-12T00:00:00Z'},{...f.host,timestamp:'2026-10-15T00:00:00Z'},{...f.host,hostVerification:{...f.host.hostVerification,artifactSha256:sha('foreign')}}])assert.equal(run([e]).state,'awaiting-host-verification');
 assert.equal(run([f.host],[{...f,pending:{...f.pending,workspace:'foreign'}}]).state,'evidence-missing');
 assert.equal(run([f.host],[{...f,attestation:{...f.attestation,recordSha256:sha('forged')}}]).state,'host-proof-unverified');
 assert.equal(run([{...f.host,hostVerification:{...f.host.hostVerification,outcome:'failed'}}]).state,'host-proof-unverified');
 assert.equal(run([f.host,f.accepted,{requestId:'r',parentRunId:f.dispatch.parentRunId,workspaceSha256:f.dispatch.workspaceSha256,timestamp:at,operation:'abandon_artifact',artifactSha256:f.pending.artifactSha256}]).state,'evidence-conflict');
 const p=projectHostEvidence({dispatches:[f.dispatch,{...f.dispatch,patch:{sha256:sha('other')}}],events:[],until});assert.equal(p.rows[0].state,'evidence-conflict');
});
test('legacy missing identity binds only through a globally unique immutable pending',()=>{
 const f=fixture('shared'),other=fixture('shared');
 other.pending=createHostPending({requestId:'shared',artifactSha256:f.pending.artifactSha256,resultSha256:sha('result'),workspace:'E:\\foreign',parentRunId:'foreign',goal:'fixture',phase:1,requiredCheckNames:['host']});
 const legacyHost={...f.host};delete legacyHost.parentRunId;delete legacyHost.workspaceSha256;
 assert.equal(projectHostEvidence({dispatches:[f.dispatch],hostRecords:[f],events:[legacyHost],until}).firstHost.denominator,0);
 const abandoned={requestId:'shared',operation:'abandon_artifact',timestamp:at,artifactSha256:f.pending.artifactSha256};
 const run=(dispatches,hostRecords,events)=>projectHostEvidence({dispatches,hostRecords,events,until,legacyScopeComplete:true});
 // Missing identity without immutable binding cannot supply a host result or close a task.
 assert.equal(run([f.dispatch],[],[legacyHost,abandoned]).rows[0].state,'evidence-missing');
 const foreign={...f.dispatch,parentRunId:'foreign',workspaceSha256:sha('foreign')};
 for(const events of [[legacyHost],[abandoned],[f.host,f.accepted]]){
  const p=run([f.dispatch,foreign],[f],events);assert.ok(p.rows.every(r=>r.state==='evidence-conflict'));assert.equal(p.firstHost.denominator,0);
  assert.equal(run([f.dispatch],[f,other],events).rows[0].state,'evidence-conflict');
 }
 assert.equal(run([f.dispatch],[f,f],[f.host]).rows[0].state,'evidence-conflict');
 assert.equal(run([f.dispatch],[f],[legacyHost]).rows[0].firstHostOutcome,'completed');
});

test('frozen capture catches the historical missing parentheses before any application',()=>{
 const good="def main():\n return 0\nraise SystemExit(main())\n",files=[file('entry.py',null,good)],capture=captureFrozenPatch(files);
 assert.equal(verifyFrozenPatch(capture.patch,files).artifactSha256,capture.artifactSha256);
 assert.throws(()=>verifyFrozenPatch(capture.patch.replace('SystemExit(main())','SystemExit(main)'),files),/differs/);
 assert.throws(()=>captureFrozenPatch([{...files[0],after:good+'#drift'}]),/fingerprint/);
 for(const p of ['../escape','/absolute','a/../b','.git/config','a:stream','folder/bad.'])assert.throws(()=>captureFrozenPatch([file(p,null,'x')]));
 assert.throws(()=>captureFrozenPatch([file('A',null,'x'),file('a',null,'y')]),/duplicate/);assert.throws(()=>captureFrozenPatch([file('x',null,'\0')]));assert.throws(()=>captureFrozenPatch([file('x',null,'')]));assert.throws(()=>captureFrozenPatch([file('x','same','same')]));
 assert.throws(()=>captureFrozenPatch([file('x',null,'x'.repeat(4*1024*1024))]),/budget/);
});
test('default git apply accepts and reproduces additions, deletions, CRLF, Unicode and no-final-newline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-frozen-')),git=(args)=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(r.status,0,r.stderr);};
 try{git(['init','-q']);git(['config','core.autocrlf','false']);mkdirSync(join(dir,'deep'));const files=[file('deep/crlf.txt','old\r\n','new\r\n'),file('noeol','old','new'),file('删除.txt','delete\n',null),file('new file.txt',null,'新\n')];for(const f of files)if(f.before!==null)writeFileSync(join(dir,f.path),f.before);
 const capture=captureFrozenPatch(files);writeFileSync(join(dir,'patch.diff'),capture.patch);git(['apply','--check','patch.diff']);git(['apply','patch.diff']);for(const f of files)if(f.after!==null)assert.equal(readFileSync(join(dir,f.path),'utf8'),f.after);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Git checkout conversion cannot pass the frozen byte guard',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-frozen-conversion-'));try{const git=args=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(r.status,0,r.stderr);};git(['init','-q']);git(['config','core.autocrlf','true']);const files=[file('entry.py',null,'main()\n')],p=captureFrozenPatch(files);writeFileSync(join(dir,'patch.diff'),p.patch);git(['apply','--check','patch.diff']);git(['apply','patch.diff']);const text=readFileSync(join(dir,'entry.py'),'utf8');assert.equal(text,'main()\r\n');assert.throws(()=>verifyFrozenFiles(files,[{path:'entry.py',text,sha256:sha(text)}]),/drift/);assert.equal(verifyFrozenFiles(files,[{path:'entry.py',text:'main()\n',sha256:sha('main()\n')}]),true);assert.throws(()=>verifyFrozenFiles(files,[]));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('real isolated Python CLI smoke detects main vs main(), while syntax alone passes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-entry-'));const run=args=>spawnSync('python',['-I','-S','-B',join(dir,'entry.py'),...args],{encoding:'utf8',timeout:10000,windowsHide:true});
 try{const code="import argparse\ndef main():\n argparse.ArgumentParser().parse_args()\n return 0\nif __name__=='__main__': raise SystemExit(main())\n";writeFileSync(join(dir,'entry.py'),code);assert.equal(run(['--help']).status,0);assert.equal(run(['--unknown']).status,2);writeFileSync(join(dir,'entry.py'),code.replace('SystemExit(main())','SystemExit(main)'));const r=run(['--help']);assert.equal(r.status,1);assert.match(r.stderr,/function main/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('presentation success declares neither Python nor browser coverage; missing optional checks are not host inability',()=>{
 const commands=[{id:'presentation',argv:['node','--test','tests/presentation.test.mjs']}];
 const c=inspectCheckCoverage(['tools/entry.py','dist/style.css'],commands,[{path:'tools/entry.py',inspected:true,commandIds:['missing']}]);assert.deepEqual(c.uncovered,['tools/entry.py','dist/style.css']);assert.equal(c.executionProven,false);assert.equal(c.hostVerificationRequired,true);
 const explicit=inspectCheckCoverage(['dist/style.css'],commands,[{path:'dist/style.css',inspected:true,commandIds:['presentation']}]);assert.equal(explicit.files[0].status,'declared-only');assert.equal(explicit.executionProven,false);
});
