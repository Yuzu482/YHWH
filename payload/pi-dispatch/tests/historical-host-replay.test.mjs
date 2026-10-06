import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {evaluateHostVerificationCandidate} from '../extensions/result-format-validator.js';
import {createRequestLedger} from '../extensions/request-ledger.js';
import {hostRecordDigest} from '../extensions/host-verification.js';
import {resultDigest} from '../extensions/role-contract.js';
import {trustedPatchProof} from '../scripts/gateway.mjs';

const fixtures=[
  'infalsus-chart-probe-test-validation-repair-20261002.json',
  'review-effort-20261002-chesed-3-authorized.json',
  'infalsus-spc-semantic-20261002-parameter-repair.json',
];
const fixtureRoot=process.env.YHWH_REPLAY_FIXTURE_DIR;
function hasReplayProvenance(fixture){
  const response=fixture?.originalRecord?.result?.response;
  const requestId=fixture?.provenance?.requestId;
  const scope=fixture?.reconstructedWriteScope??fixture?.provenance?.writeScope;
  return fixture?.provenance?.scopeRecovered===true&&fixture?.provenance?.patchHashMatches===true&&
    typeof requestId==='string'&&response?.patchValidation?.requestId===requestId&&
    typeof response?.patch==='string'&&createHash('sha256').update(response.patch,'utf8').digest('hex')===response.patchValidation?.patchSha256&&
    Array.isArray(scope)&&scope.length>0;
}
test('historical host-pending replay preserves original records and scopes', {skip:!fixtureRoot&&'private historical replay fixtures are not available'},async t=>{
  assert.ok(fixtureRoot,'YHWH_REPLAY_FIXTURE_DIR is required for a requested replay');
  for(const name of fixtures){
    await t.test(name,()=>{
      const fixture=JSON.parse(readFileSync(join(fixtureRoot,name),'utf8'));
      const original=fixture.originalRecord;
      const response=original?.result?.response;
      const requestId=fixture.provenance?.requestId;
      const scope=fixture.reconstructedWriteScope??fixture.provenance?.writeScope;
      assert.equal(hasReplayProvenance(fixture),true,name);
      assert.equal(fixture.provenance?.scopeRecovered,true,name);
      assert.equal(fixture.provenance?.patchHashMatches,true,name);
      assert.equal(response?.patchValidation?.requestId,requestId,name);
      assert.equal(createHash('sha256').update(response.patch,'utf8').digest('hex'),response.patchValidation.patchSha256,name);
      assert.ok(Array.isArray(scope)&&scope.length>0,name);
      assert.equal(trustedPatchProof(response,requestId,scope),true,`${name}: original patch proof and recovered scope`);
      const parsed=JSON.parse(response.text.slice('KETHER_RESULT_JSON='.length));
      assert.equal(parsed.status,'unverified',name);
      assert.deepEqual([...parsed.changedFiles].sort(),[...response.patchValidation.changedFiles].sort(),name);
      const rawText=response.text, rawPatch=response.patch, rawValidation=structuredClone(response.patchValidation), originalCopy=structuredClone(original);

      // Isolated pre-gateway transport reconstruction: remove only the observed
      // historical gateway rejection, retaining genuine patch/process/error facts.
      // This is never written back to the original or a production ledger.
      assert.equal(response.code,'PI_HOST_VERIFICATION_REQUIRED',name);
      assert.equal(response.failure,'PI_HOST_VERIFICATION_REQUIRED',name);
      assert.equal(response.exitCode,0,name);
      assert.equal(response.cleanup?.ok,true,name);
      assert.equal(response.unrecoveredErrors,0,name);
      assert.ok(!response.failureCode,name);
      const raw={...structuredClone(response),ok:true};
      delete raw.code;delete raw.failure;delete raw.status;
      const candidate=evaluateHostVerificationCandidate({
        task:{role:'Chesed',requestId,provider:response.requestedProvider,model:response.requestedModel},
        access:'workspace-write',raw,value:parsed,
        patchProof:{...response.patchValidation,trusted:true},forceHost:true,
      });
      assert.equal(candidate.eligible,true,name);
      assert.deepEqual(candidate.requiredCheckNames,parsed.deliverable.checks.map(check=>check.name),name);
      const directory=mkdtempSync(join(tmpdir(),'pi-historical-replay-'));
      try {
        const ledger=createRequestLedger(directory);
        const originalResult={...raw,structuredResult:parsed};
        const workspace=fixtureRoot;
        const contractTemplate={version:2,role:'Chesed',stage:'implementing',mode:'standalone',parentRunId:null,
          workspaceSha256:createHash('sha256').update(workspace).digest('hex'),resultSha256:resultDigest(parsed)};
        ledger.registerHostPending({requestId,artifactSha256:response.patchValidation.patchSha256,
          resultSha256:hostRecordDigest(originalResult),workspace,parentRunId:null,
          goal:'Isolated historical replay; no model execution or final acceptance',phase:1,
          requiredCheckNames:candidate.requiredCheckNames},{originalResult,contractTemplate});
        const reopened=createRequestLedger(directory);
        assert.equal(reopened.getEffectiveResult(requestId).state,'awaiting-host-verification',name);
        assert.equal(reopened.getEffectiveResult(requestId).ok,false,name);
        assert.deepEqual(reopened.listHostPending()[0].requiredCheckNames,candidate.requiredCheckNames,name);
        assert.equal(reopened.getEffectiveResult(requestId).verificationRecordSha256,undefined,name);
      } finally { rmSync(directory,{recursive:true,force:true}); }
      assert.equal(rawText,response.text,name);
      assert.equal(rawPatch,response.patch,name);
      assert.deepEqual(rawValidation,response.patchValidation,name);
      assert.deepEqual(original,originalCopy,name);
      assert.equal(original.state,'completed',name);
      assert.equal(original.result.response.code,'PI_HOST_VERIFICATION_REQUIRED',name);
      assert.equal(original.result.response.status,'failed',name);
    });
  }
  await t.test('missing or corrupted provenance never qualifies',()=>{
    const fixture=JSON.parse(readFileSync(join(fixtureRoot,fixtures[0]),'utf8'));
    const response=fixture.originalRecord.result.response;
    assert.equal(hasReplayProvenance({...fixture,provenance:{...fixture.provenance,scopeRecovered:false}}),false);
    assert.equal(hasReplayProvenance({...fixture,provenance:{...fixture.provenance,requestId:undefined}}),false);
    const corruptFixture={...fixture,originalRecord:{...fixture.originalRecord,result:{...fixture.originalRecord.result,response:{...response,patch:response.patch+'tampered'}}}};
    assert.equal(hasReplayProvenance(corruptFixture),false);
    const corrupt={...response,patch:response.patch+'tampered'};
    assert.equal(trustedPatchProof(corrupt,fixture.provenance.requestId,fixture.reconstructedWriteScope),false);
    assert.equal(trustedPatchProof(response,fixture.provenance.requestId,[]),false);
    const missingReference={...response,patchValidation:{...response.patchValidation,requestId:'missing-reference'}};
    assert.equal(trustedPatchProof(missingReference,fixture.provenance.requestId,fixture.reconstructedWriteScope),false);
  });
});
