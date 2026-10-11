import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=readFileSync(new URL('../sandbox/pi-kether-sandbox',import.meta.url),'utf8');
const candidates=process.platform==='win32'?[join(process.env.ProgramFiles??'C:/Program Files','Git','bin','bash.exe'),join(process.env.ProgramFiles??'C:/Program Files','Git','usr','bin','bash.exe')]:['/bin/bash','/usr/bin/bash'];
if(process.platform==='win32'){
  const git=spawnSync('git',['--exec-path'],{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true,shell:false});
  if(!git.error&&git.signal===null&&git.status===0&&git.stdout.trim()){
    candidates.push(join(git.stdout.trim(),'../../../bin/bash.exe'),join(git.stdout.trim(),'../../../usr/bin/bash.exe'));
  }
}
const bash=candidates.find(existsSync);
const caseMarker='\ncase "${1:-}" in',index=source.lastIndexOf(caseMarker);
assert.ok(index>0,'Missing launcher command dispatcher');
const tripwire=`
phase2_unexpected_side_effect() { echo PHASE2_UNEXPECTED_SIDE_EFFECT >&2; return 99; }
mkdir() { phase2_unexpected_side_effect; }
mount() { phase2_unexpected_side_effect; }
umount() { phase2_unexpected_side_effect; }
install() { phase2_unexpected_side_effect; }
chmod() { phase2_unexpected_side_effect; }
chown() { phase2_unexpected_side_effect; }
runuser() { phase2_unexpected_side_effect; }
setpriv() { phase2_unexpected_side_effect; }
select_native_issued_token() { phase2_unexpected_side_effect; }
select_api_issued_token() { phase2_unexpected_side_effect; }
`;
function invoke(args,body=source.slice(0,index)+'\n'+tripwire+source.slice(index),env={}) {
  assert.ok(bash,'A real Bash interpreter is required; existing Git Bash is expected on Windows');
  // Preserve exact fixture bytes across the Windows/MSYS argv translation.
  const quote=value=>"'"+value.replaceAll("'", "'\"'\"'")+"'";
  const actual=spawnSync(bash,['--noprofile','--norc','-s'],{input:'set -- '+args.map(quote).join(' ')+'\n'+body,encoding:'utf8',timeout:10000,maxBuffer:65536,windowsHide:true,shell:false,env:{...process.env,...env}});
  assert.equal(actual.error,undefined,actual.error?.message);assert.equal(actual.signal,null);
  assert.doesNotMatch(actual.stdout+actual.stderr,/PHASE2_UNEXPECTED_SIDE_EFFECT|unbound variable/);
  return actual;
}
const positionals=['invalid-job','C','fixture','read','small','10','fixture-user','scope-fixture','00000000-0000-0000-0000-000000000000','1'];

test('real Bash parses the unchanged launcher body and explicit pi runtime selection',()=>{
  assert.ok(bash,'Missing Bash interpreter');
  const syntax=spawnSync(bash,['--noprofile','--norc','-n'],{input:source,encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:65536});
  assert.equal(syntax.error,undefined);assert.equal(syntax.signal,null);assert.equal(syntax.status,0,syntax.stderr);
  const inspect=source.slice(0,index)+'\nselect_worker_runtime pi\nprintf "%s\\n" "$WORKER_ENTRY" "$WORKER_BOOTSTRAP"\n';
  const result=invoke([],inspect,{PI_ENTRY:'/tmp/forged',PI_WORKER_RUNTIME:'evil',WORKER_ENTRY:'/tmp/forged',WORKER_BOOTSTRAP:'/tmp/forged'});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),'/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js\n/opt/pi-kether/scripts/secure-pi-bootstrap.mjs');
});

test('missing, empty and unknown launcher runtime markers fail before any side effects',()=>{
  for(const args of [[],positionals.slice(0,3),positionals,[...positionals,'--worker-runtime']]){
    const actual=invoke(['run',...args]);assert.equal(actual.status,2);assert.match(actual.stderr,/missing run arguments or worker runtime/);
  }
  const missing=invoke(['run',...positionals,'--provider','openai-codex']);assert.equal(missing.status,2);assert.match(missing.stderr,/missing worker runtime/);
  for(const runtime of ['', 'Pi','pi ',' pi','claude-code-cli','/tmp/pi','pi; exit 0','pi\n','--worker-runtime=pi']){
    const actual=invoke(['run',...positionals,'--worker-runtime',runtime,'--provider','openai-codex']);
    assert.equal(actual.status,2,JSON.stringify(runtime));assert.match(actual.stderr,/invalid worker runtime/);
  }
  const equals=invoke(['run',...positionals,'--worker-runtime=pi','--provider','openai-codex']);assert.equal(equals.status,2);assert.match(equals.stderr,/missing worker runtime/);
});

test('a later duplicate runtime marker is rejected even after Pi or API/editor flags',()=>{
  for(const tail of [['--worker-runtime','pi'],['--worker-runtime=pi'],['--api-pipe','--provider','anthropic','--worker-runtime','pi'],['--editor-bridge','--provider','openai-codex','--worker-runtime=evil']]){
    const actual=invoke(['run',...positionals,'--worker-runtime','pi',...tail]);assert.equal(actual.status,2);assert.match(actual.stderr,/duplicate worker runtime/);
  }
});

test('pi preserves provider/API/editor/direct-LSP argument positions and validation',()=>{
  for(const tail of [['--provider','openai-codex'],['--api-pipe','--provider','anthropic'],['--editor-bridge','--provider','openai-codex'],['--direct-lsp']]){
    const fields=[...positionals];if(tail.includes('anthropic'))fields[3]='none';
    const actual=invoke(['run',...fields,'--worker-runtime','pi',...tail],undefined,{PI_WORKER_RUNTIME:'evil'});
    assert.equal(actual.status,2);assert.match(actual.stderr,/invalid job id/);assert.doesNotMatch(actual.stderr,/invalid provider|invalid API pipe/);
  }
  const missingPipe=invoke(['run',...positionals,'--worker-runtime','pi','--provider','anthropic']);assert.equal(missingPipe.status,4);assert.match(missingPipe.stderr,/PI_AUTH_ENCRYPTED_PIPE_REQUIRED/);
  const directWrite=[...positionals];directWrite[3]='workspace-write';
  const invalid=invoke(['run',...directWrite,'--worker-runtime','pi','--direct-lsp']);assert.equal(invalid.status,2);assert.match(invalid.stderr,/direct LSP requires read access/);
});
