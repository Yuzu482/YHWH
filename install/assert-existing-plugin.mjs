// SPDX-License-Identifier: Apache-2.0
// An existing plugin is reused only when it is exactly this managed release.
// Unknown files, dependency trees, provenance and connection changes fail closed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {sdkTreeDigest} from '../payload/pi-dispatch/scripts/sdk-tree-integrity.mjs';
import {inventory as managedInventory} from '../payload/pi-dispatch/scripts/plugin-upgrade.mjs';

export const PLUGIN_DEPENDENCY_TREE_SHA256='30821a2c9ae1df8fe978ea151619c5269185662f4152a40665413fb32e3b2584';
const dynamic=new Set(['.mcp.json','.yhwh-managed-files.json','build-provenance.json','node_modules']);
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
function regular(file,limit=16*1024*1024){const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>limit)throw Error('unsafe_existing_plugin_entry');return fs.readFileSync(file);}
function rootDirectory(root){const s=fs.lstatSync(root),actual=fs.realpathSync(root),expected=path.resolve(root);if(!s.isDirectory()||s.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==expected.toLowerCase():actual!==expected))throw Error('unsafe_existing_plugin_root');}
function contentInventory(root){
 rootDirectory(root);const files={};let count=0;
 function visit(dir,prefix=''){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const relative=prefix+entry.name,full=path.join(dir,entry.name),stat=fs.lstatSync(full);
   if(stat.isSymbolicLink())throw Error('unsafe_existing_plugin_entry');
   if(!prefix&&dynamic.has(entry.name)){if(entry.name==='node_modules'&&!stat.isDirectory())throw Error('unsafe_existing_plugin_entry');if(entry.name!=='node_modules'&&!stat.isFile())throw Error('unsafe_existing_plugin_entry');continue;}
   if(stat.isDirectory())visit(full,relative+'/');
   else{
    if(++count>4096)throw Error('existing_plugin_inventory_limit');
    let bytes=regular(full);
    if(relative==='.codex-plugin/plugin.json'){const value=JSON.parse(bytes.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_plugin_manifest');delete value.version;bytes=Buffer.from(JSON.stringify(canonical(value)));}
    files[relative]=hash(bytes);
   }
  }
 }
 visit(root);return canonical(files);
}
export function assertExistingPlugin({source,target,sourceCommit,pluginVersion,expectedMcp,modulesHash=PLUGIN_DEPENDENCY_TREE_SHA256}){
 if(!/^[a-f0-9]{40,64}$/.test(sourceCommit||'')||typeof pluginVersion!=='string'||!expectedMcp||typeof expectedMcp!=='object')throw Error('invalid_plugin_expectation');
 if(JSON.stringify(contentInventory(source))!==JSON.stringify(contentInventory(target)))throw Error('existing_plugin_differs');
 if(sdkTreeDigest(path.join(target,'node_modules'))!==modulesHash)throw Error('existing_plugin_dependencies_differ');
 const proof=JSON.parse(regular(path.join(target,'build-provenance.json'),1024*1024).toString('utf8'));
 if(proof.sourceCommit!==sourceCommit||proof.pluginVersion!==pluginVersion||proof.dirty!==false)throw Error('existing_plugin_provenance_differs');
 const marker=JSON.parse(regular(path.join(target,'.yhwh-managed-files.json'),1024*1024).toString('utf8'));
 if(marker.schemaVersion!==1||!marker.files||typeof marker.files!=='object'||Array.isArray(marker.files)||JSON.stringify(canonical(marker.files))!==JSON.stringify(canonical(managedInventory(target))))throw Error('existing_plugin_baseline_differs');
 const mcp=JSON.parse(regular(path.join(target,'.mcp.json'),1024*1024).toString('utf8'));
 if(JSON.stringify(canonical(mcp))!==JSON.stringify(canonical(expectedMcp)))throw Error('existing_plugin_connection_differs');
 return true;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length!==6)throw Error('invalid_arguments');
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1024*1024)throw Error('input_too_large');}
  assertExistingPlugin({source:process.argv[2],target:process.argv[3],sourceCommit:process.argv[4],pluginVersion:process.argv[5],expectedMcp:JSON.parse(input)});
  console.log('Existing managed plugin matches this release and may be reused without modification.');
 }catch{console.error('Existing Pi plugin, configuration or dependencies differ from this release; preserve them and reconcile before reinstalling.');process.exitCode=1;}
}
