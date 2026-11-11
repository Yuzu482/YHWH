import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {assertExistingPlugin} from './assert-existing-plugin.mjs';
import {sdkTreeDigest} from '../payload/pi-dispatch/scripts/sdk-tree-integrity.mjs';
import {inventory} from '../payload/pi-dispatch/scripts/plugin-upgrade.mjs';
function fixture(t){
 const parent=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'yhwh-plugin-reuse-'));
 t.after(()=>{assert.equal(path.dirname(root),parent);assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true,force:true});});
 const source=path.join(root,'source'),target=path.join(root,'target');for(const d of [source,target]){fs.mkdirSync(path.join(d,'.codex-plugin'),{recursive:true});fs.mkdirSync(path.join(d,'scripts'),{recursive:true});fs.writeFileSync(path.join(d,'.codex-plugin/plugin.json'),JSON.stringify({name:'fixture',version:d===source?'source':'installed'}));fs.writeFileSync(path.join(d,'scripts/security.mjs'),'unchanged security');}
 fs.mkdirSync(path.join(target,'node_modules/pkg'),{recursive:true});fs.writeFileSync(path.join(target,'node_modules/pkg/index.js'),'locked dependency');
 const identity={sourceCommit:'a'.repeat(40),pluginVersion:'0.1.0+fixture'},expectedMcp={mcpServers:{gateway:{command:'node',env:{TOKEN_FILE:'reference-only'}}}};
 fs.writeFileSync(path.join(target,'build-provenance.json'),JSON.stringify({...identity,dirty:false}));fs.writeFileSync(path.join(target,'.mcp.json'),JSON.stringify(expectedMcp));
 fs.writeFileSync(path.join(target,'.yhwh-managed-files.json'),JSON.stringify({schemaVersion:1,files:inventory(target)}));
 return {root,source,target,identity,expectedMcp,modulesHash:sdkTreeDigest(path.join(target,'node_modules'))};
}
const verify=f=>assertExistingPlugin({source:f.source,target:f.target,...f.identity,expectedMcp:f.expectedMcp,modulesHash:f.modulesHash});
test('identical managed plugin is reusable without changing it',t=>{const f=fixture(t);assert.equal(verify(f),true);});
test('custom or missing plugin files never pass as the same release',t=>{const f=fixture(t);fs.writeFileSync(path.join(f.target,'scripts/security.mjs'),'custom');assert.throws(()=>verify(f),/existing_plugin_differs/);fs.writeFileSync(path.join(f.target,'scripts/security.mjs'),'unchanged security');fs.writeFileSync(path.join(f.target,'extra.txt'),'custom');assert.throws(()=>verify(f),/existing_plugin_differs/);});
test('modified dependencies, provenance, baseline and connection each fail closed',t=>{
 const f=fixture(t),module=path.join(f.target,'node_modules/pkg/index.js'),proof=path.join(f.target,'build-provenance.json'),marker=path.join(f.target,'.yhwh-managed-files.json'),mcp=path.join(f.target,'.mcp.json');
 fs.writeFileSync(module,'custom');assert.throws(()=>verify(f),/existing_plugin_dependencies_differ/);fs.writeFileSync(module,'locked dependency');
 const savedProof=fs.readFileSync(proof);fs.writeFileSync(proof,JSON.stringify({...f.identity,dirty:true}));assert.throws(()=>verify(f),/existing_plugin_provenance_differs/);fs.writeFileSync(proof,savedProof);
 const savedMarker=fs.readFileSync(marker);fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,files:{}}));assert.throws(()=>verify(f),/existing_plugin_baseline_differs/);fs.writeFileSync(marker,savedMarker);
 fs.writeFileSync(mcp,JSON.stringify({mcpServers:{gateway:{command:'other'}}}));assert.throws(()=>verify(f),/existing_plugin_connection_differs/);
});
test('hard-linked plugin files are rejected',t=>{const f=fixture(t),file=path.join(f.target,'scripts/security.mjs'),alias=path.join(f.root,'alias');try{fs.linkSync(file,alias);}catch(e){if(['EPERM','EACCES','ENOSYS'].includes(e.code)){t.skip('hardlinks unavailable');return;}throw e;}assert.throws(()=>verify(f),/unsafe_existing_plugin_entry/);});
