import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimePreflight, summarizeRuntimePreflight} from '../scripts/runtime-preflight.mjs';
import {buildAuditRecord} from '../extensions/audit-log.js';

test('warnings are advisory, bounded and do not mutate or disclose the packet', () => {
  const task={objective:'Generate an output file containing PRIVATE_PAYLOAD',writeScope:['data.mjs','parse.mjs','cli.mjs'],context:['Use a subprocess'],acceptance:['Return patch']};
  const before=structuredClone(task);
  const result=runtimePreflight(task);
  assert.deepEqual(result.warnings.map(w=>w.code),['script_without_real_run','output_without_parent_path','mixed_layers','missing_interface_contract']);
  assert.equal(result.advisory,true);assert.equal(result.warnings.length,4);
  assert.deepEqual(task,before);assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'),false);
  for(const count of Object.values(result.counts)) assert.equal(count,1);
  const audit=buildAuditRecord({requestId:'preflight-case',operation:'dispatch_subagent',task,result:{ok:true,preflight:result},durationMs:1});
  assert.equal(audit.outcome,'completed');assert.deepEqual(audit.preflight.counts,result.counts);
  assert.equal(audit.preflight.warnings,undefined);
});
test('real run, qualified output and interface section remove corresponding warnings', () => {
  for(const acceptance of ['Run node tests/smoke.mjs','真实运行脚本并检查输出','Real interpreter execution and smoke check']) {
    const task={objective:'Generate output file out/result.json',context:['接口约定: named arguments and cleanup'],writeScope:['cli.mjs'],acceptance:[acceptance]};
    assert.deepEqual(runtimePreflight(task).warnings,[]);
  }
  assert.deepEqual(runtimePreflight({objective:'Edit documentation',writeScope:['README.md']}).warnings,[]);
});
test('malformed tasks do not turn the advisory into a new validation gate', () => {
  for(const value of [null,undefined,{}, {writeScope:null,acceptance:7,context:[null]}]) assert.doesNotThrow(()=>runtimePreflight(value));
});
test('audit whitelists codes and regenerates messages/counts, ignoring forged fields', () => {
  const result=summarizeRuntimePreflight({warnings:[{code:'missing_interface_contract',message:'PRIVATE'}, {code:'unknown-secret'}, {code:'missing_interface_contract'}],counts:{PRIVATE:99}});
  assert.deepEqual(result.counts,{missing_interface_contract:1});
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
  const audit=buildAuditRecord({requestId:'safe',operation:'dispatch_subagent',result:{ok:false,preflight:{warnings:[{code:'missing_interface_contract',message:'PRIVATE'}]}}});
  assert.equal(JSON.stringify(audit.preflight).includes('PRIVATE'),false);
});
