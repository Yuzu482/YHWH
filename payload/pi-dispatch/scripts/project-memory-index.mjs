import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectFiles as safe} from './project-memory.mjs';
import {redactSensitiveText} from '../extensions/audit-log.js';

const DIR='.yhwh/memory-index', FILE=`${DIR}/index.json`, LOCK=`${DIR}/refresh.lock`, MAX=8*1048576;
const DEFAULT_CACHE_BYTES=8*1048576, DEFAULT_GLOBAL_BYTES=64*1048576, DEFAULT_TTL_MS=900000;
let timer;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function schedule(){if(timer)return;timer=setTimeout(()=>{timer=null;defaultCache.pruneExpired();if(defaultCache.size)schedule();},1000);timer.unref?.();}
function createCache({cacheBytes=DEFAULT_CACHE_BYTES,globalBytes=DEFAULT_GLOBAL_BYTES,ttlMs=DEFAULT_TTL_MS,now=Date.now}={}){
 if(![cacheBytes,globalBytes,ttlMs].every(n=>Number.isFinite(n)&&n>0)||typeof now!=='function')throw new Error('Invalid private project memory cache budget');
 const values=new Map();
 return {get(key){const item=values.get(key);if(!item)return null;if(now()-item.at>=ttlMs){values.delete(key);return null;}values.delete(key);item.at=now();values.set(key,item);return item.text;},set(key,text){const bytes=Buffer.byteLength(text);if(bytes>cacheBytes||bytes>globalBytes)return;values.delete(key);values.set(key,{text,bytes,at:now()});let total=[...values.values()].reduce((n,v)=>n+v.bytes,0);while(total>globalBytes&&values.size){const [first,item]=values.entries().next().value;values.delete(first);total-=item.bytes;}},clear(){values.clear();},pruneExpired(){for(const [key,item] of values)if(now()-item.at>=ttlMs)values.delete(key);},get size(){return values.size;}};
}
const defaultCache=createCache();
let cacheLeases=0;
function remember(root,text){defaultCache.set(root,text);if(defaultCache.size)schedule();}
export function acquireProjectMemoryIndexCacheLease(){cacheLeases++;let released=false;return ()=>{if(released)return;released=true;cacheLeases=Math.max(0,cacheLeases-1);if(cacheLeases===0)closeProjectMemoryIndexCache();};}
export function closeProjectMemoryIndexCache(){if(cacheLeases>0)return;if(timer)clearTimeout(timer);timer=null;defaultCache.clear();}
const clean=value=>redactSensitiveText(value,{compact:false});
function indexedData(ctx,entries){return {version:1,root:ctx.root,entries:entries.map(e=>({id:e.id,file:e.file,revision:e.revision,title:clean(e.title),tags:e.tags.map(clean),body:clean(e.body)}))};}
function rank(indexEntries,entries,query,includeInactive){const terms=query.toLocaleLowerCase('en').trim().split(/\s+/);const byId=new Map(entries.map(entry=>[entry.id,entry]));return indexEntries.filter(e=>includeInactive||byId.get(e.id)?.usable).map(item=>{const entry=byId.get(item.id);if(!entry||entry.revision!==item.revision||entry.file!==item.file)return null;const heading=`${item.title} ${item.tags.join(' ')}`.toLocaleLowerCase('en'),body=item.body.toLocaleLowerCase('en');return {entry,score:terms.reduce((n,t)=>n+(heading.includes(t)?4:body.includes(t)?1:0),0)};}).filter(x=>x&&x.score>0).sort((a,b)=>b.score-a.score||a.entry.id.localeCompare(b.entry.id));}
function validatedIndex(text,ctx,entries){const parsed=JSON.parse(text);if(!parsed||parsed.version!==1||parsed.root!==ctx.root||!Array.isArray(parsed.entries)||!same(parsed,indexedData(ctx,entries)))return false;return true;}
export async function searchProjectMemoryIndex({ctx,entries,query,includeInactive}){
 const cacheText=defaultCache.get(ctx.root);let text=cacheText;
 if(!text){try{text=await safe.readText({...ctx,readBytes:0},FILE,MAX);}catch{return null;}}
 try{if(!validatedIndex(text,ctx,entries))return null;remember(ctx.root,text);return rank(JSON.parse(text).entries,entries,query,includeInactive);}catch{return null;}
}
async function ensure(ctx){for(const p of ['.yhwh',DIR])try{await safe.checkedPath(ctx.root,p,true);}catch(e){if(e.code!=='ENOENT')throw e;await mkdir(join(ctx.root,p));await safe.checkedPath(ctx.root,p,true);}}
async function diskRevision(ctx){try{return safe.digest(await safe.readText({...ctx,readBytes:0},FILE,MAX));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function snapshot(ctx){const parsed=await safe.records(ctx);if(parsed.errors.length)throw new Error('Cannot index invalid project-memory records');const sourcePaths=parsed.entries.flatMap(e=>e.sources.map(s=>s.path));const current=await safe.fingerprints(ctx,sourcePaths);const entries=parsed.entries.map(e=>{const sources=e.sources.map(s=>{const now=current.get(s.path);return {...s,state:now.state==='available'?(now.sha256===s.sha256?'fresh':'changed'):now.state,currentSha256:now.sha256??null};});return {...e,sources,usable:e.status==='accepted'&&sources.every(s=>s.state==='fresh')};});return {entries,inventory:parsed.entries.map(e=>({file:e.file,revision:e.revision}))};}
async function acquireLock(ctx){const path=join(ctx.root,LOCK),token=randomUUID();await safe.checkedPath(ctx.root,DIR,true);let handle;try{handle=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('Project-memory index refresh locked; reconcile the owner before removing a leftover lock');throw e;}try{await handle.writeFile(JSON.stringify({pid:process.pid,token})+'\n');await handle.sync();await safe.checkedPath(ctx.root,LOCK);return {handle,token,path};}catch(e){await handle.close();await unlink(path).catch(()=>{});throw e;}}
export async function refreshProjectMemoryIndex({cwd}={}){
 const ctx=await safe.context(cwd);await ensure(ctx);const lock=await acquireLock(ctx);let handle=null,tmp=null;
 try{
  const beforeIndex=await diskRevision(ctx),initial=await snapshot({...ctx,readBytes:0});if(!initial.entries.length)return {ok:false,written:false,reason:'no-memory'};
  const content=JSON.stringify(indexedData(ctx,initial.entries));if(Buffer.byteLength(content)>MAX)return {ok:true,written:false,reason:'index-size-limit'};
  // A second authoritative read catches record, source, inventory and fingerprint changes during construction.
  const verify=await snapshot({...ctx,readBytes:0});if(!same(initial.inventory,verify.inventory)||!same(initial.entries.map(e=>({id:e.id,usable:e.usable,sources:e.sources})),verify.entries.map(e=>({id:e.id,usable:e.usable,sources:e.sources}))))throw new Error('Project-memory sources changed during refresh; previous index preserved');
  if(await diskRevision(ctx)!==beforeIndex)throw new Error('Project-memory index changed during refresh; previous index preserved');
  if(beforeIndex===safe.digest(content)){remember(ctx.root,content);return {ok:true,written:false,revision:beforeIndex};}
  await safe.checkedPath(ctx.root,DIR,true);tmp=`${DIR}/index-${randomUUID()}.tmp`;const tmpPath=join(ctx.root,tmp);
  handle=await open(tmpPath,'wx',0o600);await handle.writeFile(content,'utf8');await handle.sync();await handle.close();handle=null;
  await safe.checkedPath(ctx.root,tmp);await safe.checkedPath(ctx.root,DIR,true);if(beforeIndex!==null)await safe.checkedPath(ctx.root,FILE);
  const final=await snapshot({...ctx,readBytes:0});if(!same(initial.inventory,final.inventory)||!same(initial.entries.map(e=>({id:e.id,usable:e.usable,sources:e.sources})),final.entries.map(e=>({id:e.id,usable:e.usable,sources:e.sources}))))throw new Error('Project-memory sources changed before publish; previous index preserved');
  if(await diskRevision(ctx)!==beforeIndex)throw new Error('Project-memory index changed before publish; concurrent update preserved');
  await safe.checkedPath(ctx.root,DIR,true);if(beforeIndex!==null)await safe.checkedPath(ctx.root,FILE);await rename(tmpPath,join(ctx.root,FILE));tmp=null;remember(ctx.root,content);return {ok:true,written:true,revision:safe.digest(content)};
 } finally {
  if(handle)await handle.close();if(tmp){await safe.checkedPath(ctx.root,DIR,true);try{await unlink(join(ctx.root,tmp));}catch(e){if(e.code!=='ENOENT')throw e;}}
  await lock.handle.close();
  // Only remove a lock whose token still identifies this invocation.
  let lockText;try{await safe.checkedPath(ctx.root,DIR,true);lockText=await safe.readText({...ctx,readBytes:0},LOCK,4096);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(lockText&&JSON.parse(lockText).token===lock.token)try{await unlink(lock.path);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
}
export const projectMemoryIndexCacheForTests=createCache;
