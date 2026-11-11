// Execute with YHWH_LSP_PRISTINE_ROOT pointing to the verified 1.4.0 npm package.
// This test copies only four inert files and never invokes a provider or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,linkSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=process.env.YHWH_LSP_PRISTINE_ROOT;
if(!source)throw Error('YHWH_LSP_PRISTINE_ROOT must identify a verified pristine LSP 1.4.0 package');
const patch=fileURLToPath(new URL('./patch-pi-lsp.mjs',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const expected={index:'8871bbc7d02abf6d6a62074b815206fa02b8ff6e884dfd7f56cb4e2ddada1db4',daemon:'e2b69869d793f7dcdb689cc9be9d27f6b34e3db2d46b4898bae2e54cd87e1300'};
function fixture(t){
 const base=realpathSync(tmpdir()),root=mkdtempSync(join(base,'yhwh-lsp14-patch-'));
 mkdirSync(join(root,'dist'));
 for(const rel of ['package.json','LICENSE','dist/index.js','dist/lsp-daemon.js'])copyFileSync(join(source,rel),join(root,rel));
 assert.equal(sha(readFileSync(join(root,'dist/index.js'))),expected.index);
 assert.equal(sha(readFileSync(join(root,'dist/lsp-daemon.js'))),expected.daemon);
 t.after(()=>{assert.equal(dirname(realpathSync(root)),base);assert.equal(lstatSync(root).isSymbolicLink(),false);rmSync(root,{recursive:true,force:true});});
 return root;
}
function run(root,...args){return spawnSync(process.execPath,[patch,root,...args],{encoding:'utf8',timeout:30000,windowsHide:true,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:tmpdir(),TMP:tmpdir()}});}
function files(root){return ['dist/index.js','dist/lsp-daemon.js'].map(p=>sha(readFileSync(join(root,p))));}

test('security-only and full patches are repeatable and never downgrade a full patch',t=>{
 const root=fixture(t);let p=run(root,'--security-only');assert.equal(p.status,0,p.stderr);const secure=files(root);
 assert.notEqual(secure[0],expected.index);assert.equal(secure[1],expected.daemon);
 p=run(root,'--security-only');assert.equal(p.status,0,p.stderr);assert.deepEqual(files(root),secure);
 p=run(root);assert.equal(p.status,0,p.stderr);const full=files(root);assert.notDeepEqual(full,secure);
 p=run(root);assert.equal(p.status,0,p.stderr);assert.deepEqual(files(root),full);
 p=run(root,'--security-only');assert.equal(p.status,0,p.stderr);assert.deepEqual(files(root),full);
 assert.match(readFileSync(join(root,'YHWH-PATCH-NOTICE.txt'),'utf8'),/Patch mode: full/);
 for(const file of ['dist/index.js','dist/lsp-daemon.js'])assert.equal(spawnSync(process.execPath,['--check',join(root,file)]).status,0);
});
test('altered and partially patched inputs fail before changing either bundle',t=>{
 const root=fixture(t),index=join(root,'dist/index.js'),daemon=join(root,'dist/lsp-daemon.js');
 writeFileSync(index,readFileSync(index,'utf8')+'\n// tampered\n');const before=files(root);
 const p=run(root);assert.notEqual(p.status,0);assert.match(p.stderr,/Unsupported or partially patched/);assert.deepEqual(files(root),before);assert.equal(existsSync(join(root,'YHWH-PATCH-NOTICE.txt')),false);
 const mixed=fixture(t);assert.equal(run(mixed).status,0);copyFileSync(join(source,'dist/lsp-daemon.js'),join(mixed,'dist/lsp-daemon.js'));
 const mixedBefore=files(mixed),retry=run(mixed);assert.notEqual(retry.status,0);assert.match(retry.stderr,/Unsupported or partially patched/);assert.deepEqual(files(mixed),mixedBefore);
});
test('unexpected package version and arguments fail without writing',t=>{
 const root=fixture(t),metadata=join(root,'package.json'),p=JSON.parse(readFileSync(metadata,'utf8'));p.version='1.3.0';writeFileSync(metadata,JSON.stringify(p));
 const before=files(root),result=run(root);assert.notEqual(result.status,0);assert.match(result.stderr,/Only the verified/);assert.deepEqual(files(root),before);
 assert.notEqual(run(resolve(root),'--unknown').status,0);
});

test('a linked patch notice is rejected without changing the linked file',t=>{
 const root=fixture(t),original=join(root,'unrelated.txt'),notice=join(root,'YHWH-PATCH-NOTICE.txt');
 writeFileSync(original,'preserve this unrelated file');linkSync(original,notice);const before=files(root),p=run(root);
 assert.notEqual(p.status,0);assert.match(p.stderr,/Unsupported linked/);assert.deepEqual(files(root),before);assert.equal(readFileSync(original,'utf8'),'preserve this unrelated file');
});
