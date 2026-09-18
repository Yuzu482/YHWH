import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {workflowTopic} from '../scripts/host-workflow.mjs';
import {HOSTS,buildHostProfile,exportHostProfiles} from '../scripts/host-profiles.mjs';
import {checkHostConnection} from '../scripts/check-host-connection.mjs';
import {createGatewayRuntime} from '../scripts/gateway.mjs';
import {COMMON_CLIENTS} from '../scripts/common-client-profiles.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function connection(state){return {command:process.execPath,args:[join(root,'scripts','stdio-server.mjs')],env:{PI_GATEWAY_ROOTS:JSON.stringify([state]),PI_GATEWAY_AUDIT_FILE:join(state,'audit.jsonl'),PI_GATEWAY_PROVIDER_CIRCUIT_FILE:join(state,'circuit.jsonl'),PI_GATEWAY_REQUEST_LEDGER_DIR:join(state,'ledger'),PI_DISPATCH_PI_ENTRY:join(state,'fixture-pi.mjs'),PI_DISPATCH_SANDBOX:'disabled-for-protocol-test',PI_SANDBOX_DISTRO:'not-launched',PI_GATEWAY_CONFIG:''}};}
test('every host receives identical primary policy with no ambient PATH or credential exports',()=>{
 const input=connection(root);input.env.PATH='private-parent-path';
 for(const host of HOSTS){const files=buildHostProfile(host,input);assert.equal(files['PRIMARY-AGENT.md'],workflowTopic().content);assert.equal(JSON.parse(files['connection.json']).env.PATH,undefined);const meta=JSON.parse(files['adapter.json']);assert.equal(meta.validation.hostUi,'unverified');assert.equal(meta.primaryModel,'chosen-in-host');}
 assert.throws(()=>buildHostProfile('generic',{...input,env:{...input.env,API_KEY:'dummy-fixture'}}),/Unsupported/);
});
test('OpenCode v1/v2 profiles preserve distinct schemas and primary modes',()=>{
 const input=connection(root),v1=JSON.parse(buildHostProfile('opencode',input)['opencode.json']),v2=JSON.parse(buildHostProfile('opencode-v2',input)['opencode.json']);
 assert.equal(v1.agent.yhwh.mode,'primary');assert.equal(v1.mcp.yhwh.enabled,true);assert.equal(v1.mcp.servers,undefined);assert.deepEqual(v1.agent.yhwh.permission.task,{'*':'deny'});
 assert.equal(v2.agents.yhwh.mode,'primary');assert.equal(v2.mcp.servers.yhwh.protocol,'legacy');assert.equal(v2.mcp.servers.yhwh.enabled,undefined);assert.deepEqual(v2.agents.yhwh.permissions,[{action:'subagent',resource:'*',effect:'deny'}]);
});
test('Claude/Cherry configurations preserve executable argument boundaries',()=>{
 const input=connection(join(root,'workspace with spaces'));
 const claude=buildHostProfile('claude-code',input),cherry=buildHostProfile('cherry-studio',input);
 assert.deepEqual(JSON.parse(claude['.mcp.json']).mcpServers.yhwh,input);assert.equal(claude['CLAUDE.md'],claude['PRIMARY-AGENT.md']);
 assert.equal(JSON.parse(cherry['server-fields.json']).type,'stdio');assert.deepEqual(JSON.parse(cherry['mcp.json']).mcpServers.yhwh.args,input.args);
});
test('DSH uses native MCP client and scoped persona with nonfatal connection failure',()=>{
 const rows=JSON.parse(buildHostProfile('deepseek-harness',connection(root))['agent.rows.cordis.yml']);
 assert.equal(rows[0].name,'@deepseek-ai/dsh-mcp-client');assert.equal(rows[0].config.transport,'stdio');assert.equal(rows[0].config.failOnStartupError,false);assert.equal(rows[0].config.serverName,'yhwh');assert.equal(rows[1].name,'@deepseek-ai/dsh-persona');assert.equal(rows[1].config.complete,false);
});
test('export validates every profile before writing and never overwrites a directory',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-export-'));
 try{const output=join(dir,'new');assert.throws(()=>exportHostProfiles({connection:connection(dir),output,hosts:['generic','unknown']}),/Unsupported host/);assert.equal(existsSync(output),false);exportHostProfiles({connection:connection(dir),output});assert.ok(existsSync(join(output,'claude-code','.mcp.json')));assert.throws(()=>exportHostProfiles({connection:connection(dir),output}),/already exists/);assert.throws(()=>exportHostProfiles({connection:connection(dir),output:join(dir,'duplicate'),hosts:['generic','generic']}),/unique/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('export rejects junction ancestors and bad scope before writing',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-junction-'));
 try{const real=join(dir,'real'),link=join(dir,'link');mkdirSync(real);symlinkSync(real,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>exportHostProfiles({connection:connection(dir),output:join(link,'new')}),/symlink/);assert.equal(existsSync(join(real,'new')),false);const invalid=connection(dir);invalid.env.PI_GATEWAY_ROOTS='["relative"]';assert.throws(()=>buildHostProfile('generic',invalid),/workspace roots/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('workflow catalog rejects arbitrary paths and reports stable content digests',()=>{
 const doc=workflowTopic('pi-routing');assert.match(doc.content,/claude-sonnet-5/);assert.equal(doc.sha256,createHash('sha256').update(doc.content).digest('hex'));for(const topic of ['../../auth.json','__proto__','toString','/etc/passwd'])assert.throws(()=>workflowTopic(topic),/Unknown/);assert.match(workflowTopic('skill:kether-governance').content,/Typed role contracts/);
});
test('actual MCP session discovers and reads governance without model execution',async()=>{
 let modelCalls=0;
 const runtime=createGatewayRuntime({roots:[root],host:'stdio',port:0,sandboxStatus:{ok:false,reason:'test'},dispatcher:async()=>{modelCalls++;throw new Error('Unexpected model call');}});
 const server=runtime.makeServer(),client=new Client({name:'other-host',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(b);await client.connect(a);const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='get_workflow'));const result=await client.callTool({name:'get_workflow',arguments:{topic:'primary'}});assert.equal(JSON.parse(result.content[0].text).topic,'primary');const invalid=await client.callTool({name:'get_workflow',arguments:{topic:'../secret'}});assert.equal(invalid.isError,true);assert.equal(modelCalls,0);}
 finally{await client.close();await server.close();await runtime.shutdown();}
});
test('real stdio child supports exported connection and distinguishes protocol from execution proof',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-stdio-'));
 try{const profile=buildHostProfile('generic',connection(dir));const result=await checkHostConnection(JSON.parse(profile['connection.json']));assert.equal(result.transport,'passed');assert.equal(result.policyRetrieval,'passed');assert.equal(result.modelCalls,0);assert.equal(result.sandbox,'unverified');assert.equal(result.modelHeartbeat,'unverified');}
 finally{rmSync(dir,{recursive:true,force:true});}
});

const clientConfigs={cursor:['.cursor/mcp.json','mcpServers'],'vscode-copilot':['.vscode/mcp.json','servers'],windsurf:['mcp_config.json','mcpServers'],cline:['cline_mcp_settings.json','mcpServers'],'roo-code':['.roo/mcp.json','mcpServers'],'gemini-cli':['.gemini/settings.json','mcpServers'],kiro:['.kiro/settings/mcp.json','mcpServers'],zed:['settings.json','context_servers'],continue:['.continue/mcpServers/yhwh.json','mcpServers'],'lm-studio':['mcp.json','mcpServers']};
function nativeConnection(host,files){const [file,key]=clientConfigs[host];return JSON.parse(files[file])[key].yhwh;}
test('common-client schemas preserve argv/env and do not grant automatic tool approval',()=>{
 const input=connection(join(root,'space and 中文'));
 assert.equal(Object.keys(clientConfigs).length,10);
 for(const host of Object.keys(clientConfigs)){
  const files=buildHostProfile(host,input),server=nativeConnection(host,files),meta=JSON.parse(files['adapter.json']);
  assert.equal(server.command,input.command);assert.deepEqual(server.args,input.args);assert.deepEqual(server.env,input.env);
  assert.ok(!server.trust);assert.ok(!server.autoApprove?.length);assert.ok(!server.alwaysAllow?.length);
  assert.equal(meta.validation.hostUi,'unverified');assert.ok(meta.clientContract.sources.length>=2);
 }
 assert.equal(nativeConnection('vscode-copilot',buildHostProfile('vscode-copilot',input)).type,'stdio');
 assert.equal(nativeConnection('gemini-cli',buildHostProfile('gemini-cli',input)).trust,false);
});
test('client rule files retain the complete primary contract and always-on metadata',()=>{
 const rules={cursor:['.cursor/rules/yhwh.mdc','alwaysApply: true'],'vscode-copilot':['.github/copilot-instructions.md',''],windsurf:['.windsurf/rules/yhwh.md','trigger: always_on'],cline:['.clinerules/yhwh.md',''],'roo-code':['.roo/rules/yhwh.md',''],'gemini-cli':['GEMINI.md',''],kiro:['.kiro/steering/yhwh.md','inclusion: always'],zed:['AGENTS.md',''],continue:['.continue/rules/yhwh.md','alwaysApply: true'],'lm-studio':['SYSTEM-PROMPT.md','']};
 for(const [host,[file,marker]] of Object.entries(rules)){const text=buildHostProfile(host,connection(root))[file];assert.ok(text.endsWith(workflowTopic().content));if(marker){assert.ok(text.startsWith('---\n'));assert.ok(text.includes(marker));}}
});
test('every common-client native connection completes real MCP handshake and policy retrieval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-clients-'));
 try{for(const host of Object.keys(clientConfigs)){const server=nativeConnection(host,buildHostProfile(host,connection(dir)));const result=await checkHostConnection({command:server.command,args:server.args,env:server.env});assert.equal(result.transport,'passed',host);assert.equal(result.modelCalls,0,host);assert.equal(result.hostUi,'unverified',host);}}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('nested native files export intact under a fresh destination without activating clients',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yhwh-client-export-'));
 try{const output=join(dir,'profiles');exportHostProfiles({connection:connection(dir),output,hosts:Object.keys(clientConfigs)});for(const [host,[file]] of Object.entries(clientConfigs)){const actual=readFileSync(join(output,host,file),'utf8');assert.deepEqual(nativeConnection(host,{[file]:actual}).args,connection(dir).args);assert.ok(existsSync(join(output,host,COMMON_CLIENTS[host].rule)));}assert.throws(()=>exportHostProfiles({connection:connection(dir),output}),/already exists/);}
 finally{rmSync(dir,{recursive:true,force:true});}
});
test('bootstrap and PowerShell preflight accept the same host IDs as the exporter',()=>{
 const packageRoot=resolve(root,'../..');
 for(const file of ['Install-YHWH.ps1','install/Read-WorkflowConfig.ps1','install/Install-PiKether.ps1']){
  const source=readFileSync(join(packageRoot,file),'utf8'),list=source.match(/@\(('generic','codex'[^)]*)\)/);
  assert.ok(list,file);assert.deepEqual([...list[1].matchAll(/'([^']+)'/g)].map(match=>match[1]),HOSTS,file);
 }
});
