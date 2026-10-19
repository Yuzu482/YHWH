import {spawnSync} from 'node:child_process';
import {lstatSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,sep} from 'node:path';

const key=p=>process.platform==='win32'?p.toLowerCase():p;
const same=(a,b)=>key(a)===key(b);
const within=(root,p)=>{const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
function fail(reason){throw Object.assign(new Error('Git repository inspection failed: '+reason),{code:'PI_RISK_PROFILE_UNRESOLVED'});}

// Fixed read-only callers only. No inherited Git redirection, helpers, hooks or locks.
export function readOnlyGit(root,args,{deadline=Date.now()+3000}={}) {
  const timeout=deadline-Date.now();if(timeout<=0)fail('time budget exceeded');
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^GIT_/i.test(k)));
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'});
  const result=spawnSync('git',['--no-pager','--no-optional-locks','-c','safe.directory='+root,
    '-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.untrackedCache=false',...args],
    {cwd:root,env,shell:false,windowsHide:true,encoding:'utf8',timeout:Math.min(3000,timeout),maxBuffer:1048576});
  if(result.error||result.signal||result.status!==0)fail(result.error?.code==='ENOENT'?'Git unavailable':'command failed or exceeded limit');
  return result.stdout;
}

function markerRoot(cwd) {
  let cursor=realpathSync.native(cwd);if(!statSync(cursor).isDirectory())fail('directory required');
  for(let depth=0;depth<128;depth++) {
    const marker=join(cursor,'.git');
    try{const s=lstatSync(marker);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory()))fail('unsafe .git marker');return cursor;}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const parent=dirname(cursor);if(parent===cursor)return null;cursor=parent;
  }
  fail('repository traversal limit');
}

export function inspectGitWorktree(cwd,{deadline=Date.now()+3000}={}) {
  try {
    const root=markerRoot(cwd);if(root===null)return null;
    const lines=readOnlyGit(root,['rev-parse','--path-format=absolute','--show-toplevel','--git-common-dir'],{deadline}).trimEnd().split(/\r?\n/);
    if(lines.length!==2||lines.some(p=>!isAbsolute(p)))fail('ambiguous identity');
    const top=realpathSync.native(lines[0]),commonDir=realpathSync.native(lines[1]);
    if(!same(top,root)||!statSync(commonDir).isDirectory())fail('root identity mismatch');
    const records=readOnlyGit(root,['worktree','list','--porcelain','-z'],{deadline}).split('\0');
    let registered=false;
    for(const line of records.filter(p=>p.startsWith('worktree '))) {
      const value=line.slice(9);if(!isAbsolute(value))fail('invalid registration');
      // Other historical registrations may have been removed; only this root must exist.
      try{if(same(realpathSync.native(value),top))registered=true;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(!registered)fail('unregistered worktree');
    return {root:top,commonDir};
  } catch(e){if(e.code==='PI_RISK_PROFILE_UNRESOLVED')throw e;fail('unreadable or invalid identity');}
}

// Entries are host-validated canonical directories. A startup pin is revalidated,
// never a cached acceptance decision; disappearance cannot silently downgrade.
export function createRiskProfileResolver(entries) {
  entries=entries.map(entry=>({...entry,cwd:realpathSync.native(entry.cwd)}));
  const critical=entries.filter(e=>e.riskProfile==='critical').map(entry=>{
    const identity=inspectGitWorktree(entry.cwd);
    return {entry,pin:identity&&same(identity.root,entry.cwd)?identity:null};
  });
  return cwd=>{
    const candidate=realpathSync.native(cwd),deadline=Date.now()+3000;
    const matches=entries.filter(e=>within(e.cwd,candidate)).sort((a,b)=>b.cwd.length-a.cwd.length);
    const direct=matches[0]?.riskProfile??'standard';
    if(!critical.length)return direct;
    const repositories=critical.map(({entry,pin})=>{
      const current=inspectGitWorktree(entry.cwd,{deadline});
      const exact=current&&same(current.root,entry.cwd);
      if(pin&&(!exact||!same(pin.commonDir,current.commonDir)))fail('critical repository identity changed');
      return exact?current:null;
    }).filter(Boolean);
    if(!repositories.length)return direct;
    const identity=inspectGitWorktree(candidate,{deadline});
    return identity&&repositories.some(r=>same(r.commonDir,identity.commonDir))?'critical':direct;
  };
}
