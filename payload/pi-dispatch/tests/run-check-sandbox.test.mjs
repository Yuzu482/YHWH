import test from 'node:test';import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';
import {createReceiptCollector,RECEIPT_FRAME,validateCheckRequest,checkSandboxArgs,createCandidateCheckConfiguration,trustedCheckConfiguration,createCheckFrames,parsePolicyReadResult,checkMemoryBudget} from '../scripts/run-check-broker.mjs';
import fs from'node:fs';import os from'node:os';import path from'node:path';import{execFileSync,spawnSync}from'node:child_process';
import {createJsonOutputCollector,validateSandboxPatch} from '../scripts/wsl-sandbox.mjs';
import {createHostPending,createHostAttestation,verifyHostAttestation} from '../extensions/host-verification.js';
import {buildPiArgs} from '../scripts/worker-runtime/pi/args.mjs';
const rid='check-test',job='6a1f2ac4-665a-4d5b-a48b-3df223cba899',key=Buffer.alloc(32,1),hex=n=>n.repeat(64);
test('memory admission preserves current model usage and refuses insufficient headroom',()=>{
 const mib=1024*1024;
 assert.equal(checkMemoryBudget(2048*mib,256*mib),512*mib);
 assert.equal(checkMemoryBudget(2048*mib,1728*mib),192*mib);
 assert.equal(checkMemoryBudget(512*mib,128*mib),128*mib);
 for(const [parent,current] of [[2048*mib,1800*mib],[2048*mib,2049*mib],[512*mib,-1],[Infinity,0],[NaN,0],[1.5,0]])assert.throws(()=>checkMemoryBudget(parent,current),/CHECK_RESOURCE_UNAVAILABLE/);
});
const signed=p=>({payload:p,signature:createHmac('sha256',key).update(JSON.stringify(p)).digest('hex')});
const wire=f=>RECEIPT_FRAME+JSON.stringify(f)+'\n';
const call=(n=1)=>({version:1,requestId:rid,jobId:job,evidenceKind:'sandboxEvidence',type:'call',callId:n,commandId:'unit',argv:['node','tests/unit.mjs'],cwd:'.',taskSha256:hex('a'),policySha256:hex('b'),trustSha256:hex('c'),cacheSha256:null,snapshotSha256:hex('d'),startedAt:'2026-10-11T00:00:00.000Z',endedAt:'2026-10-11T00:00:00.100Z',exitCode:0,signal:null,reason:null,outputBytes:3,outputSha256:hex('e'),outputSummary:'ok',cleanupOk:true});
const tally=frames=>signed({version:1,requestId:rid,jobId:job,evidenceKind:'sandboxEvidence',type:'terminal',attempts:frames.length,chain:frames.reduce((h,f)=>createHash('sha256').update(h+JSON.stringify(f)).digest('hex'),hex('0')),cleanupOk:true,brokerExitCode:0});
function collect(text){const c=createReceiptCollector({key:Buffer.from(key),requestId:rid,jobId:job});for(let i=0;i<text.length;i+=13)c.feed(text.slice(i,i+13));return c.close();}
test('signed evidence survives chunk splits and needs exact terminal tally',()=>{
  const frames=[signed(call())],full=wire(frames[0])+wire(tally(frames));
  assert.equal(collect(full).ok,true);assert.equal(collect(full).receipts.length,1);
  for(const bad of [wire(frames[0]),wire(tally(frames)),wire(frames[0])+wire(frames[0])+wire(tally(frames)),wire(tally(frames))+wire(frames[0]),full.slice(0,-1),wire(signed({...call(),requestId:'foreign'}))+wire(tally(frames)),wire({payload:call(),signature:hex('0')}),RECEIPT_FRAME+'x'.repeat(17000)+'\n'])assert.equal(collect(bad).ok,false);
});
test('all-pass sandbox receipts cannot substitute host attestation, or survive changed artifact',()=>{
  const p=createHostPending({requestId:rid,artifactSha256:hex('a'),resultSha256:hex('b'),workspace:'/project',parentRunId:'goal',goal:'check',phase:1,requiredCheckNames:['host tests']});
  const sandboxEvidence=collect(wire(signed(call()))+wire(tally([signed(call())])));
  assert.equal(sandboxEvidence.ok,true);
  assert.throws(()=>createHostAttestation(p,{requestId:rid,artifactSha256:hex('a'),sandboxEvidence}));
  const a=createHostAttestation(p,{requestId:rid,artifactSha256:hex('a'),commands:[{checkName:'host tests',command:'node --test',exitCode:0,outputSummary:'host real run'}]});
  assert.equal(verifyHostAttestation(a,p),true);
  const changed=createHostPending({requestId:rid,artifactSha256:hex('c'),resultSha256:hex('b'),workspace:'/project',parentRunId:'goal',goal:'check',phase:1,requiredCheckNames:['host tests']});
  assert.equal(verifyHostAttestation(a,changed),false);
});
test('candidate selector is host-branded, changes patch prefixes and never admits serialized copies',()=>{
  const c=createCandidateCheckConfiguration({candidateSha256:hex('a'),trustSha256:hex('b'),policyPath:process.platform==='win32'?'C:/private/policy.json':'/private/policy.json'});
  assert.match(trustedCheckConfiguration(c).launcher,/pi-kether-candidates/);
  assert.throws(()=>trustedCheckConfiguration(JSON.parse(JSON.stringify(c))));
  const prefix=c.jobs+'/'+job,patch='--- '+prefix+'/baseline/dir/a.txt\n+++ '+prefix+'/workspace/dir/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const v=validateSandboxPatch(patch,{job,requestId:rid,writeScope:['dir/a.txt'],access:'workspace-write',candidate:c});
  assert.equal(v.patchValidation.ok,true);assert.match(v.patch,/\+\+\+ b\/dir\/a.txt/);
});
test('tool is limited to host-enabled Chesed write launch, absent from default and other roles',()=>{
  const req={provider:'openai-codex',model:'gpt-6-luna',access:'workspace-write',rolePresetId:'Chesed'};
  assert.ok(!buildPiArgs(req,'wsl2',false,true).join(' ').includes('yhwh_run_check'));
  assert.ok(buildPiArgs(req,'wsl2',false,true,true).join(' ').includes('yhwh_run_check'));
  for(const changed of [{...req,access:'read'},{...req,rolePresetId:'Netzach'},{...req,rolePresetId:undefined}])assert.throws(()=>buildPiArgs(changed,'wsl2',false,false,true));
  assert.throws(()=>buildPiArgs(req,'host',false,false,true));
});
test('check namespace excludes broad opt, host mounts, auth and network, bounds tmp and PID view',()=>{
  const args=checkSandboxArgs({snapshot:'/private/snapshot',runner:{path:'/trust/node'},cache:{path:'/trust/cache'},cwd:'tests'});
  assert.ok(args.includes('--unshare-net'));assert.ok(args.includes('--unshare-pid'));assert.ok(args.includes('--clearenv'));
  assert.equal(args.filter(s=>s==='/opt').length,0);assert.ok(!args.some(s=>s.includes('/mnt/')||s.includes('auth.json')));
  assert.deepEqual(args.slice(-4),['--chdir','/workspace/tests','--','/runner/node']);
  assert.ok(args.includes('16777216'));
});
test('spoofed receipt prefix, malformed or concurrent IPC fails closed',async()=>{
  let failures=0;const frames=createCheckFrames({workspace:'/unused',group:'/unused',secretFile:'/unused',stateFile:'/unused',send(){throw Error('no send');},onOutput(){},onFailure(){failures++;}});
  frames.feed(RECEIPT_FRAME+'forged\n');assert.equal(failures,1);assert.equal((await frames.close()).ok,false);
  for(const v of [{checkId:1,commandId:'ok',argv:['sh']},{checkId:9,commandId:'ok'},{checkId:1,commandId:'../'},null])assert.throws(()=>validateCheckRequest(v));
});
test('host policy response is exact, bounded, canonical base64 and digest-bound',()=>{
 const expected=process.platform==='win32'?'C:/private/policy.json':'/private/policy.json',bytes=Buffer.from('{}'),good={canonicalPath:expected,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')};
 assert.equal(parsePolicyReadResult(JSON.stringify(good),expected).toString(),'{}');
 for(const bad of [{...good,extra:1},{...good,sha256:good.sha256.toUpperCase()},{...good,contentBase64:'e30'},{...good,contentBase64:'e30= '},{...good,canonicalPath:expected+'x'},{...good,sha256:hex('0')}])assert.throws(()=>parsePolicyReadResult(JSON.stringify(bad),expected));
 assert.throws(()=>parsePolicyReadResult('\ufeff'+JSON.stringify(good),expected));
 assert.throws(()=>parsePolicyReadResult(JSON.stringify(good).replace('{','{"sha256":"'+good.sha256+'",'),expected));
});
test('Windows native reader accepts protected policy, rejects hardlinks/aliases and conservative unsafe ACLs',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.homedir(),'.yhwh-policy-test-')),policy=path.join(root,'policy.json'),helper=path.resolve('scripts/read-check-policy.ps1'),ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
 fs.writeFileSync(policy,'{"fixture":true}');
 const invoke=p=>spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-PolicyPath',p],{encoding:'utf8',timeout:20000,maxBuffer:196608,windowsHide:true});
 try{
  const good=invoke(policy);assert.equal(good.status,0,good.stderr);assert.equal(parsePolicyReadResult(good.stdout,policy).toString(),'{"fixture":true}');
  fs.linkSync(policy,path.join(root,'alias.json'));assert.equal(invoke(policy).status,2);fs.unlinkSync(path.join(root,'alias.json'));
  fs.symlinkSync(root,path.join(root,'junction'),'junction');assert.equal(invoke(path.join(root,'junction/policy.json')).status,2);fs.unlinkSync(path.join(root,'junction'));
  const source=fs.readFileSync(helper,'utf8').match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const script=path.join(root,'descriptors.ps1');fs.writeFileSync(script,"$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n"+source+"\n'@\n"+String.raw`
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Check([string]$s,[bool]$file,[bool]$pass){$sd=[Security.AccessControl.RawSecurityDescriptor]::new($s);$b=New-Object byte[] $sd.BinaryLength;$sd.GetBinaryForm($b,0);$ok=$true;try{[YhwhPolicyReader]::CheckDescriptor($b,$file,$me)}catch{$ok=$false};if($ok -ne $pass){throw ('descriptor expectation: '+$s)}}
$base='O:'+$me+'D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;'+$me+')'
Check ($base+'(A;;FR;;;BU)') $true $true
Check ($base+'(A;;0x4;;;AU)') $false $true
Check ($base+'(A;;0x4;;;AU)') $true $false
Check ($base+'(A;;0x40;;;BU)') $false $false
Check ($base+'(A;;SD;;;BU)') $false $false
Check ($base+'(A;;GA;;;BU)') $false $false
Check ($base+'(A;OICIIO;GA;;;WD)') $false $true
Check ('O:S-1-5-21-1-2-3-1001D:(A;;FA;;;SY)') $true $false
Check ('O:'+$me) $true $false
'ACL_NEGATIVES_OK'
`);
  const negatives=execFileSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{encoding:'utf8',timeout:20000,maxBuffer:4096,windowsHide:true});assert.match(negatives,/ACL_NEGATIVES_OK/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

