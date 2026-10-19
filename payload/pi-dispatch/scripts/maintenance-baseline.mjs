import {realpathSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {inspectGitWorktree,readOnlyGit} from './risk-profiles.mjs';

const fullCommit=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export function inspectMaintenanceBaseline({sourceRoot,expectedCommit}={}) {
  const result={ok:false,readOnly:true,expectedCommit,scope:'momentary clean Git source gate; ignored files excluded; no provenance authentication or remote refresh'};
  if(typeof sourceRoot!=='string'||!isAbsolute(sourceRoot)||typeof expectedCommit!=='string'||!fullCommit.test(expectedCommit))return {...result,code:'INVALID_ARGUMENTS'};
  try {
    const root=realpathSync(sourceRoot),deadline=Date.now()+10000;
    const gitVersion=readOnlyGit(root,['--version'],{deadline}).trim();
    const identity=inspectGitWorktree(root,{deadline});
    if(!identity||!same(root,identity.root))return {...result,code:'SOURCE_ROOT_REQUIRED'};
    const head=readOnlyGit(root,['rev-parse','--verify','HEAD'],{deadline}).trim();
    if(!fullCommit.test(head))return {...result,code:'HEAD_UNAVAILABLE'};
    const facts={...result,sourceRoot:root,commonDir:identity.commonDir,gitVersion,head,dirty:null};
    if(head!==expectedCommit)return {...facts,code:'BASELINE_COMMIT_MISMATCH'};
    // Status may otherwise invoke a submodule Git process or a repository clean
    // filter. Refuse gitlinks and neutralize every configured filter first.
    const index=readOnlyGit(root,['ls-files','--stage','-z'],{deadline});
    if(index.split('\0').some(line=>line.startsWith('160000 ')))return {...facts,code:'BASELINE_SUBMODULE_UNSUPPORTED'};
    const keys=readOnlyGit(root,['config','--null','--name-only','--list'],{deadline}).split('\0');
    const filters=new Set();
    for(const key of keys){const match=/^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);if(match){if(/[=\r\n]/.test(match[1]))throw Error('Unsupported filter name');filters.add(match[1]);}}
    const overrides=[...filters].flatMap(name=>['clean','smudge','process','required'].flatMap(kind=>['-c',`filter.${name}.${kind}=${kind==='required'?'false':''}`]));
    const status=readOnlyGit(root,[...overrides,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'],{deadline});
    facts.dirty=status.length!==0;
    if(status.length)return {...facts,code:'BASELINE_DIRTY'};
    return {...facts,ok:true,code:'BASELINE_READY'};
  } catch(e){return {...result,code:'BASELINE_INSPECTION_FAILED',reason:e.code==='PI_RISK_PROFILE_UNRESOLVED'?e.message:'Source directory unavailable or invalid'};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {values}=parseArgs({options:{'source-root':{type:'string'},'expected-commit':{type:'string'}},allowPositionals:false});
    const result=inspectMaintenanceBaseline({sourceRoot:values['source-root'],expectedCommit:values['expected-commit']});
    console.log(JSON.stringify(result));process.exitCode=result.code==='INVALID_ARGUMENTS'?2:result.ok?0:1;
    if(result.code==='INVALID_ARGUMENTS')console.error('Usage: maintenance-baseline.mjs --source-root ABSOLUTE_REPOSITORY_ROOT --expected-commit FULL_COMMIT_SHA');
  } catch {console.error('Usage: maintenance-baseline.mjs --source-root ABSOLUTE_REPOSITORY_ROOT --expected-commit FULL_COMMIT_SHA');process.exitCode=2;}
}
