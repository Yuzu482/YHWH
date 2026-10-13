import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {inspectInstallIntegrity} from '../scripts/install-integrity.mjs';
import {listenHttpFixture} from './http-fixture.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const marker='.yhwh-managed-files.json';
const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-integrity-'));
  try { return run(root); } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
function manifest(root,files) {fs.writeFileSync(path.join(root,marker),JSON.stringify({schemaVersion:1,files}));}

test('matching recorded installation is verified without changing any bytes',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'asset.txt'),'fixture');manifest(root,{'asset.txt':digest('fixture')});
  const before=fs.readFileSync(path.join(root,marker));
  const result=inspectInstallIntegrity(root);
  assert.equal(result.state,'verified');assert.equal(result.checkedFiles,1);assert.equal(result.code,undefined);
  assert.deepEqual(fs.readFileSync(path.join(root,marker)),before);
  assert.equal(fs.readFileSync(path.join(root,'asset.txt'),'utf8'),'fixture');
}));

test('two modified files reproduce installed-check false-negative and CLI exits 1',()=>fixture(root=>{
  fs.mkdirSync(path.join(root,'scripts'));
  for(const file of ['gateway.mjs','tier-review-policy.mjs'])fs.writeFileSync(path.join(root,'scripts',file),'hotpatch');
  manifest(root,{'scripts/gateway.mjs':digest('approved'),'scripts/tier-review-policy.mjs':digest('approved')});
  const before=fs.readFileSync(path.join(root,marker));
  const result=spawnSync(process.execPath,[path.join(source,'scripts/install-integrity.mjs'),'--plugin-root',root,'--require-installed'],{encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined);assert.equal(result.signal,null);assert.equal(result.status,1);
  const parsed=JSON.parse(result.stdout);assert.equal(parsed.code,'PI_INSTALL_DRIFT');assert.equal(parsed.driftCount,2);
  assert.deepEqual(parsed.drift.map(x=>x.reason),['hash-mismatch','hash-mismatch']);
  assert.deepEqual(fs.readFileSync(path.join(root,marker)),before);
}));

test('missing files, source checkout, missing and malformed installation records stay distinct',()=>fixture(root=>{
  assert.equal(inspectInstallIntegrity(root).state,'not-installed');
  assert.equal(inspectInstallIntegrity(root,{requireInstalled:true}).code,'PI_INSTALL_DRIFT');
  fs.writeFileSync(path.join(root,'build-provenance.json'),'{}');
  assert.equal(inspectInstallIntegrity(root).drift[0].reason,'missing-manifest');
  manifest(root,{'missing.txt':digest('fixture')});
  assert.equal(inspectInstallIntegrity(root).drift[0].reason,'missing-file');
  fs.writeFileSync(path.join(root,marker),'{invalid');assert.equal(inspectInstallIntegrity(root).code,'PI_INSTALL_DRIFT');
  fs.writeFileSync(path.join(root,marker),' '.repeat(1024*1024+1));assert.equal(inspectInstallIntegrity(root).code,'PI_INSTALL_DRIFT');
}));

test('unsafe paths and installer-excluded entries never trigger outside reads',()=>fixture(root=>{
  for(const value of ['../outside','/absolute','C:/drive','a\\b','a:stream','a\nname','a\u2028name','a.','a ','NUL.txt','COM1','short~1','node_modules/a','auth.json','.mcp.json',marker,'.env','a.local.json','a.log']) {
    manifest(root,{[value]:digest('secret')});
    const result=inspectInstallIntegrity(root);assert.equal(result.code,'PI_INSTALL_DRIFT',value);
    assert.equal(result.checkedFiles,0,value);assert.equal(result.drift[0].path,marker,value);
  }
  manifest(root,{'Same.txt':digest('one'),'same.txt':digest('two')});
  assert.equal(inspectInstallIntegrity(root).checkedFiles,0);
  manifest(root,{'asset.txt':[digest('fixture')]});assert.equal(inspectInstallIntegrity(root).checkedFiles,0);
}));

test('real junctions and hardlinks are rejected on Windows as well as Unix',()=>fixture(root=>{
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-integrity-outside-'));
  try {
    fs.writeFileSync(path.join(outside,'asset.txt'),'private fixture');
    fs.symlinkSync(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
    manifest(root,{'escape/asset.txt':digest('private fixture')});
    assert.equal(inspectInstallIntegrity(root).drift[0].reason,'unsafe-file');
    fs.linkSync(path.join(outside,'asset.txt'),path.join(root,'linked.txt'));
    manifest(root,{'linked.txt':digest('private fixture')});assert.equal(inspectInstallIntegrity(root).code,'PI_INSTALL_DRIFT');
    fs.symlinkSync(root,path.join(outside,'root-link'),process.platform==='win32'?'junction':'dir');
    assert.equal(inspectInstallIntegrity(path.join(outside,'root-link')).code,'PI_INSTALL_DRIFT');
  } finally {fs.rmSync(outside,{recursive:true,force:true});}
}));

test('entry, byte and diagnostic bounds report drift instead of reading unbounded files',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'large.dat'),Buffer.alloc(16*1024*1024+1));
  manifest(root,{'large.dat':digest('unused')});
  assert.equal(inspectInstallIntegrity(root).truncated,true);
  const files=Object.fromEntries(Array.from({length:101},(_,i)=>['missing'+i,digest('fixture')]));manifest(root,files);
  const bounded=inspectInstallIntegrity(root);assert.equal(bounded.driftCount,101);assert.equal(bounded.drift.length,100);assert.equal(bounded.truncated,true);
  manifest(root,Object.fromEntries(Array.from({length:4097},(_,i)=>['file'+i,digest('fixture')])));
  assert.equal(inspectInstallIntegrity(root).checkedFiles,0);
}));

test('CLI argument errors are exit 2 and never create output artifacts',()=>fixture(root=>{
  for(const args of [[],['--unknown'],['--plugin-root'],['--plugin-root',root,'extra']]) {
    const r=spawnSync(process.execPath,[path.join(source,'scripts/install-integrity.mjs'),...args],{encoding:'utf8',timeout:10000});
    assert.equal(r.error,undefined);assert.equal(r.status,2);assert.match(r.stderr,/Usage:/);
  }
  assert.deepEqual(fs.readdirSync(root),[]);
}));

test('aggregate hash budget stops after 128MiB even for individually valid files',()=>fixture(root=>{
  const bytes=Buffer.alloc(16*1024*1024),hash=digest(bytes),files={};
  for(let i=0;i<9;i++) {const name='bounded-'+i+'.dat';const fd=fs.openSync(path.join(root,name),'wx');try{fs.ftruncateSync(fd,bytes.length);}finally{fs.closeSync(fd);}files[name]=hash;}
  manifest(root,files);const result=inspectInstallIntegrity(root);
  assert.equal(result.code,'PI_INSTALL_DRIFT');assert.equal(result.checkedFiles,8);assert.equal(result.truncated,true);
  assert.equal(result.drift.at(-1).reason,'total-byte-limit');
}));

test('real isolated HTTP workflow/status and startup audit report drift without changing healthy topic receipts',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-integrity-http-'));
  const plugin=path.join(root,'plugin'),auditFile=path.join(root,'audit.jsonl');
  let server,client,runtime;
  try {
    fs.cpSync(source,plugin,{recursive:true,filter:file=>!['node_modules','tests','.test','.runtime'].some(p=>path.relative(source,file).split(path.sep).includes(p))});
    fs.symlinkSync(fs.realpathSync(path.join(source,'node_modules')),path.join(plugin,'node_modules'),process.platform==='win32'?'junction':'dir');
    fs.writeFileSync(path.join(plugin,'public.txt'),'unexpected hotpatch');manifest(plugin,{'public.txt':digest('approved public fixture')});
    const module=await import(pathToFileURL(path.join(plugin,'scripts/gateway.mjs')).href);
    const token='integrity-http-fixture-0123456789';
    const result=module.createGatewayApp({roots:[plugin],token,host:'127.0.0.1',port:0,auditFile,sandboxStatus:{ok:true,backend:'fixture',resourceLimits:true},schedulerOptions:{availableMemoryBytes:()=>Number.MAX_SAFE_INTEGER}});
    runtime=result.runtime;server=await listenHttpFixture(result.app);const base='http://127.0.0.1:'+server.address().port;
    const statusResponse=await fetch(base+'/admin/upgrade/status',{method:'POST',headers:{Authorization:'Bearer '+token}});
    const status=await statusResponse.json();assert.equal(status.code,'PI_INSTALL_DRIFT');assert.equal(status.installationIntegrity.state,'drift');
    assert.equal((await fetch(base+'/admin/upgrade/status',{method:'POST'})).status,401);
    assert.equal((await fetch(base+'/healthz')).status,200);assert.equal((await fetch(base+'/readyz')).status,200);
    client=new Client({name:'integrity-fixture',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const workflow=await client.callTool({name:'get_workflow',arguments:{topic:'task-tiers'}}),value=JSON.parse(workflow.content[0].text);
    assert.notEqual(workflow.isError,true);assert.equal(value.code,'PI_INSTALL_DRIFT');assert.ok(value.receipt);
    const catalog=JSON.parse(fs.readFileSync(path.join(plugin,'workflow/catalog.json'),'utf8'));
    assert.equal(value.content,catalog.topics['task-tiers']);assert.equal(value.sha256,digest(value.content));
    const monitor=JSON.parse((await client.callTool({name:'list_subagents',arguments:{limit:1}})).content[0].text);
    assert.equal(monitor.gateway.code,'PI_INSTALL_DRIFT');
    const caps=JSON.parse((await client.callTool({name:'list_capabilities',arguments:{}})).content[0].text);assert.equal(caps.code,'PI_INSTALL_DRIFT');
    const audit=fs.readFileSync(auditFile,'utf8').trim().split('\n').map(x=>JSON.parse(x));
    assert.equal(audit.filter(x=>x.operation==='install_integrity'&&x.code==='PI_INSTALL_DRIFT').length,1);
    assert.ok(!JSON.stringify(status.installationIntegrity).includes('unexpected hotpatch'));
    assert.ok(!audit.some(x=>x.operation==='task_accepted'));
  } finally {
    await client?.close();await runtime?.shutdown({graceMs:100,abortWaitMs:100});
    if(server)await new Promise(done=>server.close(done));fs.rmSync(root,{recursive:true,force:true});
  }
});
