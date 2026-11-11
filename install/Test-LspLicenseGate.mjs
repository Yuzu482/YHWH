import test from 'node:test';import assert from 'node:assert/strict';
import {copyFileSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=['install/license-inventory.mjs','portable.manifest.json','payload/wsl-package-lock.json','licenses/pi-lsp-extension-evidence.json','licenses/pi-lsp-extension-1.4.0-evidence.json','licenses/pi-lsp-extension-1.4.0.package.json','licenses/pi-lsp-extension-upstream-20260924-LICENSE.txt'];
function fixture(t){const temp=realpathSync(tmpdir()),dir=mkdtempSync(join(temp,'yhwh-lsp-license-'));for(const p of files){mkdirSync(dirname(join(dir,p)),{recursive:true});copyFileSync(join(root,p),join(dir,p));}t.after(()=>{assert.equal(dirname(realpathSync(dir)),temp);assert.equal(lstatSync(dir).isSymbolicLink(),false);rmSync(dir,{recursive:true,force:true});});return dir;}
function run(dir){return spawnSync(process.execPath,[join(dir,'install/license-inventory.mjs'),'--check','--public'],{encoding:'utf8',timeout:30000,windowsHide:true});}
function update(path,edit){const data=JSON.parse(readFileSync(path,'utf8'));edit(data);writeFileSync(path,JSON.stringify(data));}
test('current 1.4.0 notice and inventory satisfy the existing public gate',()=>{const p=run(root);assert.equal(p.status,0,p.stderr);});
test('historical 1.3.0 and unknown versions remain blocked',t=>{
 const dir=fixture(t),m=join(dir,'portable.manifest.json');
 update(m,x=>{x.components.piLspExtension='1.3.0'});let p=run(dir);assert.notEqual(p.status,0);assert.match(p.stderr,/coverage of the pinned version is not verified/);
 update(m,x=>{x.components.piLspExtension='9.9.9'});p=run(dir);assert.notEqual(p.status,0);assert.match(p.stderr,/unsupported pi-lsp-extension/);
});
test('1.4.0 rejects changed notice, dependency pin or package metadata',t=>{
 const a=fixture(t),notice=join(a,'licenses/pi-lsp-extension-upstream-20260924-LICENSE.txt');writeFileSync(notice,'tampered');let p=run(a);assert.notEqual(p.status,0);assert.match(p.stderr,/notice digest mismatch/);
 const b=fixture(t),lock=join(b,'payload/wsl-package-lock.json');update(lock,x=>{x.packages['node_modules/pi-lsp-extension'].version='1.3.0'});p=run(b);assert.notEqual(p.status,0);assert.match(p.stderr,/matching 1.4.0 archive/);
 const c=fixture(t),meta=join(c,'licenses/pi-lsp-extension-1.4.0.package.json');update(meta,x=>{x.version='1.3.0'});p=run(c);assert.notEqual(p.status,0);assert.match(p.stderr,/matching 1.4.0 archive/);
});
