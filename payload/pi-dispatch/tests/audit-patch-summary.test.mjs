import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {summarizePatch} from '../extensions/audit-log.js';

function realPatch(files,mutate) {
  const cwd=mkdtempSync(join(tmpdir(),'audit-unified-patch-'));
  const git=args=>{
    const result=spawnSync('git',['-c','core.autocrlf=false','-c','core.quotePath=true','-C',cwd,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.ifError(result.error);
    assert.equal(result.signal,null);
    assert.equal(result.status,0,result.stderr);
    return result.stdout;
  };
  try {
    git(['init','--quiet']);
    for(const [name,text] of Object.entries(files))writeFileSync(join(cwd,name),text);
    git(['add','--',...Object.keys(files)]);
    mutate(cwd);
    const patch=git(['diff','--no-ext-diff','--no-textconv']);
    const entries=git(['diff','--numstat','--no-ext-diff','--no-textconv']).trim().split('\n').filter(Boolean);
    const counts=entries.reduce((total,line)=>{
      const [added,deleted]=line.split('\t');
      total.additions+=Number(added);total.deletions+=Number(deleted);return total;
    },{fileCount:entries.length,additions:0,deletions:0});
    return {patch,counts};
  } finally {rmSync(cwd,{recursive:true,force:true});}
}

function matchesGit({patch,counts}) {
  const summary=summarizePatch(patch);
  assert.deepEqual({fileCount:summary.fileCount,additions:summary.additions,deletions:summary.deletions},counts);
  assert.equal(summary.bytes,Buffer.byteLength(patch));
  assert.match(summary.sha256,/^[a-f0-9]{64}$/);
  assert.equal(summary.pathHashes.length,counts.fileCount);
  assert.ok(summary.pathHashes.every(value=>/^[a-f0-9]{64}$/.test(value)));
  return summary;
}

test('audit patch counters match Git when content looks like unified file headers',()=>{
  const result=realPatch({'notes.txt':'-- old\n'},cwd=>writeFileSync(join(cwd,'notes.txt'),'++ new\n'));
  assert.ok(result.patch.includes('\n--- old\n+++ new\n'));
  matchesGit(result);
});

test('audit patch counters retain multiple files, hunks and no-final-newline edits',()=>{
  const context=Array.from({length:20},(_,index)=>`unchanged ${index}`).join('\n');
  const result=realPatch({'first.txt':`-- first\n${context}\n-- last\n`,'second.txt':'-- no final newline'},cwd=>{
    writeFileSync(join(cwd,'first.txt'),`++ first\n${context}\n++ last\n`);
    writeFileSync(join(cwd,'second.txt'),'++ no final newline');
  });
  assert.ok((result.patch.match(/^@@ /gm)??[]).length>=3);
  assert.ok(result.patch.includes('\\ No newline at end of file'));
  matchesGit(result);
});

test('audit patch counters handle zero-line sides and delete-only hunks',()=>{
  const result=realPatch({'empty.txt':'','removed.txt':'-- removed\nplain\n'},cwd=>{
    writeFileSync(join(cwd,'empty.txt'),'++ added\n');
    unlinkSync(join(cwd,'removed.txt'));
  });
  assert.ok(result.patch.includes('+++ /dev/null'));
  matchesGit(result);
});

test('audit patch summaries canonicalize quoted a/b paths without retaining filenames or body',()=>{
  const name='quoted 私有.txt';
  const result=realPatch({[name]:'-- private content\n'},cwd=>writeFileSync(join(cwd,name),'++ confidential content\n'));
  assert.ok(result.patch.includes('--- "a/'));
  const summary=matchesGit(result);
  assert.doesNotMatch(JSON.stringify(summary),/quoted|私有|private|confidential/);
});

test('empty audit patch remains an absent summary',()=>{
  assert.deepEqual(summarizePatch(''),{present:false,bytes:0,fileCount:0,additions:0,deletions:0});
});
