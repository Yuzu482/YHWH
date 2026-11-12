import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {TextDecoder} from 'node:util';

const LIMIT={files:20000,bytes:128*1024*1024,fileBytes:16*1024*1024,lines:400000,recordBytes:32*1024*1024};
const omitDirs=new Set(['.git','.svn','.hg','.ssh','.aws','.codex','.test','.local-evidence','.yhwh','review-candidates','node_modules','__pycache__','.venv','venv','.npm-cache','.tmp','.validation-deps','diagnostics']);
const generatedDirs=new Set(['.cache','.pytest_cache','.mypy_cache','.turbo','build','dist','coverage','release','logs']);
const gitEnv={};for(const k of ['PATH','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','TEMP','TMP'])if(process.env[k]!==undefined)gitEnv[k]=process.env[k];
Object.assign(gitEnv,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'});
const sha=b=>createHash('sha256').update(b).digest('hex');
const inRoot=(file,root)=>{const r=path.relative(root,file);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep))};
function omit(relative){const parts=relative.split('/');const name=parts.at(-1);return parts.some(p=>omitDirs.has(p.toLowerCase()))||/^\.env(?:\.|$)/i.test(name)||/\.(?:pem|key|pfx|p12)$/i.test(name)||/(?:^|[._-])(?:auth|credentials?|token|secrets?|api[-_]?key)(?:[._-]|$).*\.(?:json|ya?ml|toml)$/i.test(name)}
function sourceLike(name){return /\.(?:[cm]?[jt]sx?|py|pyi|c|cc|cpp|h|hpp|cs|rs|go|java|kt|swift|sh|ps1|psm1|json|ya?ml|toml|md|html?|css|scss|xml|sql|proto|gradle|properties)$/i.test(name)||/^(?:Dockerfile|Makefile|CMakeLists\.txt|\.gitignore)$/i.test(name)}
function git(cwd,args,maxBuffer=16*1024*1024){return execFileSync('git',['--no-pager','-C',cwd,'-c','core.fsmonitor=false',...args],{env:gitEnv,timeout:12000,maxBuffer,windowsHide:true,stdio:['ignore','pipe','pipe']})}
export function resolveRepository(cwd,allowedRoots,file=null){
 if(!path.isAbsolute(cwd)||!Array.isArray(allowedRoots)||!allowedRoots.length)throw Error('invalid_workspace');
 const canonical=fs.realpathSync(cwd),roots=allowedRoots.map(x=>fs.realpathSync(x));
 if(!roots.some(r=>inRoot(canonical,r)))throw Error('outside_allowed_root');
 let anchor=canonical;
 if(file!==null){if(typeof file!=='string'||!file.trim())throw Error('invalid_file');const actual=fs.realpathSync(path.isAbsolute(file)?file:path.resolve(canonical,file));if(!inRoot(actual,canonical))throw Error('file_outside_workspace');anchor=path.dirname(actual)}
 let repo;try{repo=fs.realpathSync(git(anchor,['rev-parse','--show-toplevel']).toString('utf8').trim())}catch{
   let cursor=anchor;while(roots.some(r=>inRoot(cursor,r))){if(fs.existsSync(path.join(cursor,'.git')))throw Error('repository_listing_unavailable');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent}
   repo=canonical;
 }
 if(!roots.some(r=>inRoot(repo,r)))throw Error('repository_outside_allowed_root');
 return repo;
}
export function repositoryKey(repo){return sha(process.platform==='win32'?repo.toLowerCase():repo)}
function directoryPaths(repo,{sourceOnly=false}={}){
 const paths=[],stack=[['',repo]];let dirs=0;
 while(stack.length){const [prefix,current]=stack.pop();if(++dirs>LIMIT.files)throw Error('repository_directory_limit');
   let list;try{list=fs.readdirSync(current,{withFileTypes:true})}catch{throw Error('repository_listing_unavailable')}
   for(const entry of list){const name=prefix+entry.name;if(omit(name))continue;
     if(entry.isDirectory()){if(generatedDirs.has(entry.name.toLowerCase())||/(?:^\.pi-.*(?:backup|stage)|-backup)$/i.test(entry.name))continue;stack.push([name+'/',path.join(current,entry.name)])}
     else if(!sourceOnly||sourceLike(entry.name)){paths.push(name);if(paths.length>LIMIT.files)throw Error('repository_file_limit')}
   }
 }
 return paths;
}
export function inspectRepository(cwd,allowedRoots,previous=null,file=null){
 const repo=resolveRepository(cwd,allowedRoots,file);
 const args=['ls-files','--cached','--others','--exclude-standard',...['.local-evidence/','.test/','review-candidates/','node_modules/','.venv/'].map(x=>'--exclude='+x),'-z'];
 const list=()=>{try{const output=git(repo,args),tracked=output.toString('utf8').split('\0').filter(Boolean),additional=directoryPaths(repo,{sourceOnly:true});return [...new Set([...tracked,...additional])].filter(x=>!omit(x)).sort()}catch(error){if(error.message?.startsWith('repository_'))throw error;if(fs.existsSync(path.join(repo,'.git')))throw Error('repository_listing_unavailable');return directoryPaths(repo).sort()}};
 const paths=list();
 if(paths.length>LIMIT.files)throw Error('repository_file_limit');
 const repoHash=repositoryKey(repo);
 if(previous!==null)validateBaseline(previous,repoHash);
 let bytes=0,lineTotal=0;const entries={},observed=[];const decoder=new TextDecoder('utf-8',{fatal:true});
 for(const name of paths){
   if(path.isAbsolute(name)||name.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('unsafe_repository_path');
   const absolute=path.resolve(repo,...name.split('/'));if(!inRoot(absolute,repo))throw Error('unsafe_repository_path');
   let before;try{before=fs.lstatSync(absolute)}catch(e){if(e.code==='ENOENT'){observed.push([absolute,null]);continue}throw Error('repository_file_unreadable')}
   observed.push([absolute,before]);const key=sha(name);if(before.isSymbolicLink()){entries[key]={hash:sha('link:'+fs.readlinkSync(absolute)),lines:null};continue}
   if(!before.isFile()||before.nlink!==1)throw Error('unsafe_repository_file');
   if(before.size>LIMIT.fileBytes)throw Error('repository_file_unsupported');
   bytes+=before.size;if(bytes>LIMIT.bytes)throw Error('repository_bytes_limit');
   let fd;try{
     if(!inRoot(fs.realpathSync(absolute),repo))throw Error('repository_link_outside');
     fd=fs.openSync(absolute,'r');const opened=fs.fstatSync(fd);
     if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error('repository_changed_during_scan');
     const content=fs.readFileSync(fd),after=fs.fstatSync(fd);
     if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw Error('repository_changed_during_scan');
     const fileHash=sha(content);let lines=null;
     if(previous?.entries[key]?.hash===fileHash)lines=previous.entries[key].lines;
     else if(!content.includes(0)){try{const text=decoder.decode(content);const raw=text.length?text.split(/\r?\n/):[];if(raw.at(-1)==='')raw.pop();lines=raw.map(line=>sha(line).slice(0,32))}catch{lines=null}}
     lineTotal+=lines?.length??0;if(lineTotal>LIMIT.lines)throw Error('repository_line_limit');
     entries[key]={hash:fileHash,lines};
   }finally{if(fd!==undefined)fs.closeSync(fd)}
 }
 if(JSON.stringify(list())!==JSON.stringify(paths))throw Error('repository_changed_during_scan');
 for(const [file,old] of observed){let now;try{now=fs.lstatSync(file)}catch(e){if(e.code==='ENOENT')now=null;else throw Error('repository_file_unreadable')}
   if((!old)!==(!now)||old&&now&&(old.dev!==now.dev||old.ino!==now.ino||old.size!==now.size||old.mtimeMs!==now.mtimeMs||old.ctimeMs!==now.ctimeMs))throw Error('repository_changed_during_scan');
 }
 const data={schema:1,repoHash,entries};
 if(Buffer.byteLength(JSON.stringify(data))>LIMIT.recordBytes)throw Error('repository_record_limit');
 return {repo,data,digest:sha(JSON.stringify(data)),fileCount:paths.length,bytes,lineTotal};
}

function validateBaseline(before,repoHash){
 if(!before||before.schema!==1||before.repoHash!==repoHash||!before.entries||typeof before.entries!=='object'||Array.isArray(before.entries))throw Error('invalid_approval_baseline');
 let count=0,lines=0;for(const [key,value] of Object.entries(before.entries)){
   if(!/^[a-f0-9]{64}$/.test(key)||!value||!/^[a-f0-9]{64}$/.test(value.hash)||!(value.lines===null||Array.isArray(value.lines)))throw Error('invalid_approval_baseline');
   if(value.lines){lines+=value.lines.length;if(value.lines.some(line=>typeof line!=='string'||!/^[a-f0-9]{32}$/.test(line)))throw Error('invalid_approval_baseline')}
   if(++count>LIMIT.files||lines>LIMIT.lines)throw Error('invalid_approval_baseline');
 }
}
export function changesSince(before,after,{fileLimit=50,lineLimit=2000,tempDir}){
 validateBaseline(before,after.repoHash);
 if(!Number.isInteger(fileLimit)||fileLimit<1||!Number.isInteger(lineLimit)||lineLimit<1)throw Error('invalid_threshold');
 const all=new Set([...Object.keys(before.entries),...Object.keys(after.entries)]),changed=[];
 for(const key of all)if(before.entries[key]?.hash!==after.entries[key]?.hash)changed.push(key);
 if(changed.length>=fileLimit)return {major:true,changedFiles:changed.length,changedLines:null,reason:'files'};
 let changedLines=0;
 for(const key of changed){const a=before.entries[key]?.lines??[],b=after.entries[key]?.lines??[];
   if(!a.length||!b.length){changedLines+=a.length+b.length;}
   else{
     const tmp=path.join(tempDir,`lsp-diff-${randomUUID()}`);fs.mkdirSync(tmp,{mode:0o700});const oldPath=path.join(tmp,'old'),newPath=path.join(tmp,'new');
     try{fs.writeFileSync(oldPath,a.join('\n')+'\n',{flag:'wx'});fs.writeFileSync(newPath,b.join('\n')+'\n',{flag:'wx'});
       const result=spawnSync('git',['--no-pager','-c','core.fsmonitor=false','diff','--no-index','--no-ext-diff','--no-textconv','--numstat','--',oldPath,newPath],{env:gitEnv,timeout:12000,maxBuffer:1024*1024,windowsHide:true,encoding:'utf8'});
       if(result.error||![0,1].includes(result.status))throw Error('line_comparison_failed');
       if(result.status===1){const m=result.stdout.match(/^(\d+)\t(\d+)\t/m);if(!m)throw Error('line_comparison_failed');changedLines+=Number(m[1])+Number(m[2]);}
     }finally{for(const p of [oldPath,newPath])try{fs.unlinkSync(p)}catch(e){if(e.code!=='ENOENT')throw e}fs.rmdirSync(tmp)}
   }
   if(changedLines>=lineLimit)return {major:true,changedFiles:changed.length,changedLines,reason:'lines'};
 }
 return {major:false,changedFiles:changed.length,changedLines,reason:'below_threshold'};
}
