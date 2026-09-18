import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workflowTopic} from './host-workflow.mjs';
import {COMMON_CLIENTS,commonClientFiles} from './common-client-profiles.mjs';
export const HOSTS=Object.freeze(['generic','codex','cherry-studio','opencode','opencode-v2','claude-code','claude-desktop','deepseek-harness',...Object.keys(COMMON_CLIENTS)]);
const allowedEnv=new Set(['PI_GATEWAY_ROOTS','PI_GATEWAY_AUDIT_FILE','PI_GATEWAY_PROVIDER_CIRCUIT_FILE','PI_GATEWAY_REQUEST_LEDGER_DIR','PI_DISPATCH_SANDBOX','PI_SANDBOX_DISTRO','PI_DISPATCH_PI_ENTRY','PI_GATEWAY_CONFIG']);
const json=value=>JSON.stringify(value,null,2)+'\n';
function validateConnection(raw){
  if(!raw||!isAbsolute(raw.command)||!Array.isArray(raw.args)||raw.args.length!==1||!isAbsolute(raw.args[0]))throw new Error('Expected absolute Node and stdio-server paths');
  if(!/[\\/]stdio-server\.mjs$/.test(raw.args[0]))throw new Error('Only the governed stdio entry is supported');
  const env={};
  for(const [key,value] of Object.entries(raw.env??{})){
    if(key==='PATH')continue;
    if(!allowedEnv.has(key)||typeof value!=='string'||/[\r\n\0]/.test(value))throw new Error(`Unsupported connection environment field: ${key}`);
    env[key]=value;
  }
  if(!env.PI_GATEWAY_CONFIG){
    const roots=JSON.parse(env.PI_GATEWAY_ROOTS??'null');
    if(!Array.isArray(roots)||!roots.length||roots.some(root=>typeof root!=='string'||!isAbsolute(root)))throw new Error('Explicit absolute workspace roots are required');
    for(const key of ['PI_GATEWAY_AUDIT_FILE','PI_GATEWAY_PROVIDER_CIRCUIT_FILE','PI_GATEWAY_REQUEST_LEDGER_DIR','PI_DISPATCH_PI_ENTRY'])if(!isAbsolute(env[key]??''))throw new Error(`Missing absolute ${key}`);
  }else if(!isAbsolute(env.PI_GATEWAY_CONFIG))throw new Error('Shared gateway config must be absolute');
  return {command:raw.command,args:[...raw.args],env};
}
export function buildHostProfile(host,raw){
  if(!HOSTS.includes(host))throw new Error(`Unsupported host: ${host}`);
  const connection=validateConnection(raw),prompt=workflowTopic('primary').content,common={...connection};
  const files={'PRIMARY-AGENT.md':prompt,'connection.json':json(connection),...commonClientFiles(host,connection,prompt)};
  if(['generic','cherry-studio','claude-code','claude-desktop','codex'].includes(host))files['mcp.json']=json({mcpServers:{yhwh:common}});
  if(host==='cherry-studio')files['server-fields.json']=json({name:'YHWH',type:'stdio',...common});
  if(host==='claude-code'){files['.mcp.json']=files['mcp.json'];files['CLAUDE.md']=prompt;}
  if(host==='codex')files['AGENTS.md']=prompt;
  if(host==='opencode')files['opencode.json']=json({$schema:'https://opencode.ai/config.json',mcp:{yhwh:{type:'local',command:[connection.command,...connection.args],environment:connection.env,enabled:true,timeout:30000}},agent:{yhwh:{description:'YHWH primary coordinator',mode:'primary',prompt,permission:{task:{'*':'deny'}}}}});
  if(host==='opencode-v2')files['opencode.json']=json({$schema:'https://opencode.ai/config.json',mcp:{servers:{yhwh:{type:'local',command:[connection.command,...connection.args],environment:connection.env,protocol:'legacy'}}},agents:{yhwh:{description:'YHWH primary coordinator',mode:'primary',system:prompt,permissions:[{action:'subagent',resource:'*',effect:'deny'}]}}});
  if(host==='deepseek-harness'){
    // JSON is valid YAML 1.2. Import rows into a COPIED agent preset, not the global loader.
    files['agent.rows.cordis.yml']=json([{id:'yhwh-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'yhwh',transport:'stdio',...connection,toolCallTimeoutMs:300000,failOnStartupError:false}},{id:'yhwh-persona',name:'@deepseek-ai/dsh-persona',config:{text:prompt,complete:false,includeRuntimeContext:true}}]);
    files['AGENTS.md']=prompt;
  }
  files['adapter.json']=json({version:1,host,primaryModel:'chosen-in-host',runtime:'Windows 11 + WSL2 on the Pi machine',governance:'Load PRIMARY-AGENT.md before orchestration; fetch reference topics through get_workflow',connection:'stdio',shared:!!connection.env.PI_GATEWAY_CONFIG,validation:{profile:'generated',hostUi:'unverified',modelHeartbeat:'unverified'},requiredTools:['get_workflow','list_capabilities','submit_subagent','get_subagent_status','get_subagent_result','lsp_request'],limitations:['Host permissions and tool-capable model required','MCP connection does not attest governance compliance','Sandbox patches require primary review and an authorized file-editing capability','Independent stdio runtimes require one active primary per installation; concurrent hosts need shared gateway config']});
  if(Object.hasOwn(COMMON_CLIENTS,host)){
    const spec=COMMON_CLIENTS[host],meta=JSON.parse(files['adapter.json']);
    meta.clientContract={configFile:spec.file,ruleFile:spec.rule,scope:spec.scope??'Local client',sources:spec.sources,checkedOn:'2026-09-18'};
    files['adapter.json']=json(meta);
  }
  return files;
}
function assertFreshDirectory(destination){
  if(!isAbsolute(destination))throw new Error('Output must be absolute');
  if(existsSync(destination))throw new Error('Output already exists; choose a new export directory');
  for(let cursor=dirname(destination);;cursor=dirname(cursor)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw new Error('Refusing a symlink/junction output ancestor');if(dirname(cursor)===cursor)break;}
}
export function exportHostProfiles({connection,output,hosts=HOSTS}){
  if(!Array.isArray(hosts)||!hosts.length||new Set(hosts).size!==hosts.length)throw new Error('Choose unique host IDs');
  const profiles=hosts.map(host=>[host,buildHostProfile(host,connection)]);
  assertFreshDirectory(output);mkdirSync(output,{recursive:true});
  for(const [host,files] of profiles){const target=join(output,host);mkdirSync(target);for(const [file,text] of Object.entries(files)){const destination=join(target,file);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,text,{encoding:'utf8',flag:'wx',mode:0o600});}}
  return {output,hosts,activation:'Import the matching config and primary-agent instructions; existing host settings have not been changed'};
}
export function connectionFromMcp(file){const source=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));return source.mcpServers?.['pi-kether-gateway']??source.mcpServers?.yhwh??source;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [file,output,selection='all']=process.argv.slice(2);if(file==='--list'){console.log(json(HOSTS));}else{if(!file||!output)throw new Error('Usage: node host-profiles.mjs --list OR <installed-mcp.json> <new-absolute-export-dir> [all|comma-separated-hosts]');console.log(json(exportHostProfiles({connection:connectionFromMcp(file),output,hosts:selection==='all'?HOSTS:selection.split(',')})));}}
  catch(error){console.error(error.message);process.exitCode=1;}
}
