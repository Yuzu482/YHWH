import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const packageRoot=resolve(import.meta.dirname,'../../..'),helper=join(packageRoot,'install/Get-SharedGatewayConnection.ps1');
const driver='$ErrorActionPreference="Stop";$a=[Console]::In.ReadToEnd()|ConvertFrom-Json;& $a.helper -NodePath $a.node -PluginTarget $a.plugin -StateRoot $a.state -Roots @($a.roots) -PiEntry $a.pi -ConfigurationWillBeCreated:([bool]$a.create) | ConvertTo-Json -Depth 8 -Compress';
function run(data,command=driver){const r=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],{input:JSON.stringify(data),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:256*1024});assert.ifError(r.error);assert.equal(r.signal,null);return r;}
function snapshot(dir){return readdirSync(dir,{recursive:true,withFileTypes:true}).map(e=>{const p=join(e.parentPath??e.path,e.name);return[p.slice(dir.length),e.isDirectory()?'directory':createHash('sha256').update(readFileSync(p)).digest('hex')];}).sort((a,b)=>a[0].localeCompare(b[0]));}
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'shared-gateway space-')),state=join(dir,'home/.local/state/pi-kether');mkdirSync(state,{recursive:true});const token=join(state,'token.txt'),config=join(state,'gateway-silent.json');writeFileSync(token,'private-fixture-token-never-logged');const shared={host:'127.0.0.1',port:17331,roots:[dir],tokenFile:token};writeFileSync(config,JSON.stringify(shared));const data={helper,node:process.execPath,plugin:join(dir,'home/plugins/pi-dispatch'),state,roots:[dir],pi:join(dir,'home/pi/cli.js'),create:false};try{return fn({dir,state,token,config,shared,data});}finally{rmSync(dir,{recursive:true,force:true});}}
test('without Tunnel, generated connection always uses shared config and all 18 governed tools',()=>fixture(({dir,config,data})=>{const before=snapshot(dir),r=run(data);assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.env.PI_GATEWAY_CONFIG,config);assert.deepEqual([...value.enabled_tools].sort(),['get_workflow','list_capabilities','dispatch_subagent','submit_subagent','get_subagent_status','wait_subagent','get_task_handoff','wait_task_handoff','get_subagent_result','list_subagents','cancel_subagent','render_subagent_monitor','probe_model','lsp_request','check_claude_auth','diagnose_milestone_failure','abandon_artifact','reconcile_milestone'].sort());assert.equal(value.env.PI_DISPATCH_SANDBOX,'wsl2-bwrap');assert.equal(value.autoApprove,undefined);assert.deepEqual(snapshot(dir),before);}));
test('repeated generation preserves token/cache/config bytes and gives the same connection',()=>fixture(({dir,state,data})=>{writeFileSync(join(state,'cache-marker'),'unchanged');const before=snapshot(dir),a=run(data),b=run(data);assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);assert.deepEqual(JSON.parse(a.stdout),JSON.parse(b.stdout));assert.deepEqual(snapshot(dir),before);}));
test('missing config is rejected without writes; explicit existing Tunnel bootstrap may defer it',()=>fixture(({dir,config,data})=>{rmSync(config);const before=snapshot(dir),r=run(data);assert.notEqual(r.status,0);assert.match(r.stderr,/configuration is required/);assert.deepEqual(snapshot(dir),before);const allowed=run({...data,create:true});assert.equal(allowed.status,0,allowed.stderr);assert.deepEqual(snapshot(dir),before);}));
test('malformed/remote/wrong-root/missing-token configs fail closed without exposing token bytes',()=>{
 for(const kind of ['malformed','remote','wrong-root','missing-token','port'])fixture(({dir,config,shared,data})=>{
  if(kind==='remote')shared.host='example.com';if(kind==='wrong-root')shared.roots=[data.state];if(kind==='missing-token')shared.tokenFile='absent.txt';if(kind==='port')shared.port='17331';writeFileSync(config,kind==='malformed'?'{broken':JSON.stringify(shared));const before=snapshot(dir),r=run(data);assert.notEqual(r.status,0,kind);assert.ok(!r.stderr.includes('private-fixture-token-never-logged'));assert.deepEqual(snapshot(dir),before,kind);
 });
});
test('actual installer admission fails before changing target files',()=>fixture(({dir,state,config,shared,data})=>{
 shared.host='example.com';writeFileSync(config,JSON.stringify(shared));const installConfig=join(dir,'install.json');writeFileSync(installConfig,JSON.stringify({schemaVersion:1,hosts:['generic'],workspaceRoots:[dir],installWsl:false,installTunnel:false}));const home=resolve(state,'../../..'),before=snapshot(home);
 const command='$ErrorActionPreference="Stop";$a=[Console]::In.ReadToEnd()|ConvertFrom-Json;& $a.installer -ConfigFile $a.config -TargetHome $a.home -SkipWsl -SkipTunnel -SkipCodexRegistration';
 const r=run({installer:join(packageRoot,'install/Install-PiKether.ps1'),config:installConfig,home},command);assert.notEqual(r.status,0);assert.match(r.stderr,/loopback/);assert.deepEqual(snapshot(home),before);
}));
test('installer validates sharing before mutation and Installed revalidates after Tunnel configuration',()=>{
 const source=readFileSync(join(packageRoot,'install/Install-PiKether.ps1'),'utf8');assert.ok(source.indexOf('$sharedConnection =')<source.indexOf('New-Item -ItemType Directory -Force -Path $TargetHome'));assert.ok(source.indexOf('Configure-SilentRuntime.ps1')<source.lastIndexOf('Test-PiKether.ps1'));assert.ok(!source.includes("$mcp.mcpServers.'pi-kether-gateway'.env.PI_GATEWAY_CONFIG ="));
 const verify=readFileSync(join(packageRoot,'install/Test-PiKether.ps1'),'utf8');assert.match(verify,/PI_GATEWAY_CONFIG -ceq/);assert.match(verify,/Compare-Object.*enabled_tools/);
});

test('clean non-Tunnel PlanOnly remains read-only without a shared runtime bootstrap',()=>fixture(({dir,state,config})=>{
 rmSync(config);const installConfig=join(dir,'plan.json');writeFileSync(installConfig,JSON.stringify({schemaVersion:1,hosts:['generic'],workspaceRoots:[dir],installWsl:false,installTunnel:false}));const home=resolve(state,'../../..'),before=snapshot(home);
 const command='$ErrorActionPreference="Stop";$a=[Console]::In.ReadToEnd()|ConvertFrom-Json;& $a.installer -PlanOnly -ConfigFile $a.config -TargetHome $a.home -SkipWsl -SkipTunnel -SkipCodexRegistration';
 const r=run({installer:join(packageRoot,'install/Install-PiKether.ps1'),config:installConfig,home},command);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/no changes made/);assert.deepEqual(snapshot(home),before);
}));

test('actual host/port guard rejects remote hosts for both Int32 and Int64 port values',()=>{
 const command=String.raw`$ErrorActionPreference='Stop';$a=[Console]::In.ReadToEnd()|ConvertFrom-Json;$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($a.helper,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Parse error'};$node=$ast.FindAll({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -match '\$hostName'},$true)[0];$guard=[scriptblock]::Create($node.Clauses[0].Item1.Extent.Text);$result=@();foreach($type in @('int','long')){foreach($hostName in @('example.com','127.0.0.1')){$port=if($type -eq 'int'){[int]17331}else{[long]17331};$result+=(& $guard)}};$result|ConvertTo-Json -Compress`;
 const r=run({helper},command);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[true,false,true,false]);
});
