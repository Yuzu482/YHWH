// Coverage is an explicit host declaration, never inferred from a passing command.
export function inspectCheckCoverage(changedFiles,commands=[],facts=[]) {
  if(!Array.isArray(changedFiles)||changedFiles.length>256||changedFiles.some(p=>typeof p!=='string')||!Array.isArray(commands)||commands.length>32||!Array.isArray(facts)||facts.length>256)throw Error('Invalid check coverage input');
  const ids=new Set(commands.map(c=>c.id));
  const files=[...new Set(changedFiles)].map(path=>{
    const declared=facts.filter(f=>f?.path===path&&f.inspected===true&&Array.isArray(f.commandIds)&&f.commandIds.length>0&&f.commandIds.every(id=>typeof id==='string'&&ids.has(id)));
    return {path,commandIds:[...new Set(declared.flatMap(f=>f.commandIds))],status:declared.length?'declared-only':'unknown'};
  });
  return {files,uncovered:files.filter(f=>f.status==='unknown').map(f=>f.path),advisory:true,executionProven:false,hostVerificationRequired:true};
}
