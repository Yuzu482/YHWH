import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('catalog check accepts CRLF without rewriting', {skip:process.platform!=='win32'}, () => {
  const root=mkdtempSync(join(tmpdir(),'catalog-eol-'));
  try {
    mkdirSync(join(root,'install'),{recursive:true});
    mkdirSync(join(root,'templates','agent-references'),{recursive:true});
    mkdirSync(join(root,'payload','workflow-skills','demo'),{recursive:true});
    mkdirSync(join(root,'payload','pi-dispatch','workflow'),{recursive:true});
    const script=join(root,'install','Sync-HostWorkflow.ps1');
    copyFileSync(fileURLToPath(new URL('../../../install/Sync-HostWorkflow.ps1',import.meta.url)),script);
    writeFileSync(join(root,'templates','host-primary.md'),'primary text\n');
    writeFileSync(join(root,'templates','agent-references','example.md'),'reference text\n');
    writeFileSync(join(root,'payload','workflow-skills','demo','SKILL.md'),'skill text\n');
    const run=(...args)=>spawnSync('pwsh.exe',['-NoProfile','-File',script,...args],{windowsHide:true,shell:false,timeout:10000,encoding:'utf8',maxBuffer:65536});
    assert.equal(run().status,0);
    const catalog=join(root,'payload','pi-dispatch','workflow','catalog.json');
    assert.equal(readFileSync(catalog).includes(0x0d),false);
    const check=expected=>{const before=readFileSync(catalog);assert.equal(run('-Check').status,expected);assert.deepEqual(readFileSync(catalog),before);};
    check(0);
    writeFileSync(catalog,readFileSync(catalog,'utf8').replace(/\n/g,'\r\n'));
    check(0);
    const value=JSON.parse(readFileSync(catalog,'utf8')); value.topics.primary+='changed';
    writeFileSync(catalog,JSON.stringify(value,null,2)+'\n');
    check(1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
