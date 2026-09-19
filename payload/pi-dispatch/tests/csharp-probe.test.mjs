import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {csharpProject,prepareCsharpSnapshot} from '../scripts/csharp-probe-project.mjs';
import {probeSandboxArgs} from '../scripts/lsp-sandbox-broker.mjs';
test('C# generated project includes one escaped file and keeps outputs temporary',()=>{
  const xml=csharpProject('src/中文$(@x);%*.CS');
  assert.match(xml,/Compile Include="src\/中文%24%28%40x%29%3B%25%2A.CS"/);
  assert.match(xml,/<EnableDefaultCompileItems>false/);assert.match(xml,/\/tmp\/yhwh-csharp\/obj\//);
  for(const file of ['../x.cs','/x.cs','a\\x.cs','x.ts'])assert.throws(()=>csharpProject(file));
});
test('C# project preparation never overwrites existing files',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yhwh-csharp-'));
  try{fs.writeFileSync(path.join(root,'a.cs'),'class A {}');prepareCsharpSnapshot(root,'a.cs');
    const original=fs.readFileSync(path.join(root,'YHWH.csproj'),'utf8');assert.throws(()=>prepareCsharpSnapshot(root,'a.cs'));
    assert.equal(fs.readFileSync(path.join(root,'YHWH.csproj'),'utf8'),original);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('C# proc is a read-only private PID view; other languages keep empty proc',()=>{
  const cs=probeSandboxArgs('/fixture','a.CS');assert.ok(cs.includes('--unshare-pid'));assert.ok(cs.includes('--unshare-net'));
  assert.deepEqual(cs.slice(cs.indexOf('--proc'),cs.indexOf('--proc')+4),['--proc','/proc','--remount-ro','/proc']);
  assert.ok(!probeSandboxArgs('/fixture','a.py').includes('--proc'));
  assert.ok(!cs.includes('--bind'));assert.ok(!cs.includes('--preserve-fds'));
});
