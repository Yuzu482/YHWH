import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sdkTreeDigest,PI_151_TREE_SHA256} from '../scripts/sdk-tree-integrity.mjs';
import {isSingleShotArgs,pinnedSdkMatches} from '../scripts/pi-single-shot-lifecycle.mjs';
import {safeFlags} from '../scripts/worker-runtime/pi/args.mjs';

test('tree pin detects changed, extra and escaping files', t=>{
 const root=mkdtempSync(join(tmpdir(),'pi151-tree-'));mkdirSync(join(root,'pkg'));
 writeFileSync(join(root,'pkg','index.js'),'original');const initial=sdkTreeDigest(root);
 assert.match(initial,/^[a-f0-9]{64}$/);assert.match(PI_151_TREE_SHA256,/^[a-f0-9]{64}$/);
 writeFileSync(join(root,'pkg','index.js'),'changed');assert.notEqual(sdkTreeDigest(root),initial);
 writeFileSync(join(root,'pkg','index.js'),'original');assert.equal(sdkTreeDigest(root),initial);
 writeFileSync(join(root,'extra'),'extra');assert.notEqual(sdkTreeDigest(root),initial);
 try{symlinkSync(join(tmpdir()),join(root,'escape'),'dir');}
 catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.diagnostic('symlink creation unavailable');return;}throw error;}
 assert.throws(()=>sdkTreeDigest(root),/PI_SDK_TREE_INVALID/);
});

test('new no-mcp switch stays subject to canonical arguments',()=>{
 const args=[...safeFlags,'--print','--mode','json','--no-session','--provider','openai-codex','--model','gpt-6-luna','--thinking','medium','--no-tools'];
 assert.equal(isSingleShotArgs([...args,'--no-mcp']),true);
 assert.equal(isSingleShotArgs([...args,'--no-mcp','--no-mcp']),false);
 assert.equal(isSingleShotArgs([...args,'--no-mcp','--resume','other']),false);
 assert.equal(pinnedSdkMatches(()=>Buffer.from('tampered')),false);
});

test('controlled transport allows exactly the new Anthropic URL and denies variants',()=>{
 const url=new URL('../scripts/provider-transport.mjs',import.meta.url).href;
 const code=`import {installTransportFence} from ${JSON.stringify(url)};
 const calls=[],target={fetch:async(u,o)=>{calls.push([u,o.redirect]);}};
 installTransportFence({apiKey:'fixture-secret',route:{protocol:'anthropic-messages',baseUrl:'https://fixture.test'}},target);
 for(const u of ['https://fixture.test/v1/messages','https://fixture.test/v1/messages?beta=true']) await target.fetch(u,{redirect:'follow'});
 for(const u of ['https://fixture.test/v1/messages?beta=false','https://fixture.test/v1/messages?beta=true&x=1','https://fixture.test/v1/messages?beta=true#x','https://evil.test/v1/messages?beta=true','http://fixture.test/v1/messages?beta=true']){let rejected=false;try{await target.fetch(u);}catch(e){rejected=e.message==='PI_PROVIDER_ENDPOINT_REJECTED';}if(!rejected)process.exitCode=1;}
 if(calls.length!==2||calls.some(c=>c[1]!=='error'))process.exitCode=1;`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);
});
