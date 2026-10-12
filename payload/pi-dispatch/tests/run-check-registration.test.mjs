import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {registeredProjectFiles} from './helpers/run-check-registration.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');

test('registers frozen root manifests in deterministic order without reading worker files',()=>{
  const sources={'src/logic.mjs':'editable','package.json':'{"type":"module"}\n','package-lock.json':'{}\n','nested/package.json':'not a root manifest'};
  const snapshot=structuredClone(sources),expected=[{path:'package-lock.json',sha256:hash('{}\n')},{path:'package.json',sha256:hash('{"type":"module"}\n')}];
  assert.deepEqual(registeredProjectFiles(sources),expected);
  assert.deepEqual(registeredProjectFiles(Object.fromEntries(Object.entries(sources).reverse())),expected);
  assert.deepEqual(sources,snapshot);
  sources['package.json']='changed';assert.notDeepEqual(registeredProjectFiles(sources),expected);
  assert.deepEqual(registeredProjectFiles({'src/logic.mjs':'source only'}),[]);
});

test('registration enumeration stays in parity with the root broker, including other language manifests',()=>{
  const broker=fs.readFileSync(new URL('../scripts/run-check-broker.mjs',import.meta.url),'utf8');
  const match=broker.match(/const available=fs\.readdirSync\(snapshot\)\.filter\(x=>(\/[^\n]+\/)[.]test\(x\)\);/);
  assert.ok(match,'Root broker manifest enumeration changed: review registration parity');
  const re=new RegExp(match[1].slice(1,-1));
  const names=['package.json','package-lock.json','npm-shrinkwrap.json','pyproject.toml','requirements.txt','Cargo.toml','Cargo.lock','go.mod','go.sum','pom.xml','build.gradle','app.csproj','packages.lock.json','README.md','package-other.json','logic.mjs'];
  for(const name of names)assert.equal(registeredProjectFiles({[name]:'frozen'}).length,re.test(name)?1:0,name);
});

test('registration rejects unsafe names, accessors and excess manifests before privileged preparation',()=>{
  for(const input of [null,[],new Map(),{[Symbol('secret')]:'x'}])assert.throws(()=>registeredProjectFiles(input),/FROZEN_SOURCES_INVALID/);
  for(const name of ['requirements:evil','requirements\\evil','requirements\0evil','requirements\nevil'])assert.throws(()=>registeredProjectFiles({[name]:'bytes'}),/PROJECT_MANIFEST_PATH/);
  assert.throws(()=>registeredProjectFiles({'package.json':42}),/PROJECT_MANIFEST_BYTES/);
  let accessed=false;assert.throws(()=>registeredProjectFiles(Object.defineProperty({},'package.json',{enumerable:true,get(){accessed=true;return 'x';}})),/PROJECT_MANIFEST_BYTES/);assert.equal(accessed,false);
  assert.throws(()=>registeredProjectFiles(Object.fromEntries(Array.from({length:17},(_,i)=>['requirements'+i,'']))),/PROJECT_MANIFEST_LIMIT/);
  assert.deepEqual(registeredProjectFiles({'package.json':Buffer.from('{}')}),[{path:'package.json',sha256:hash('{}')}]);
});
