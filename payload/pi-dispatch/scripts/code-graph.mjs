// SPDX-License-Identifier: Apache-2.0
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {join,extname,posix,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {projectFiles as safe} from './project-memory.mjs';
import {PARSER_VERSION,LANGUAGES,indexSchema,factsSchema} from './code-graph-schema.mjs';
import {redactSensitiveText} from '../extensions/audit-log.js';

const DIRECTORY='.yhwh/code-graph', INDEX=`${DIRECTORY}/index.json`, LOCK=`${DIRECTORY}/refresh.lock`;
const MAX_FILES=512, MAX_SOURCE=1048576, MAX_INDEX=8*1048576, MAX_FACTS=60000;
const fail=message=>{throw new Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=values=>values.sort((a,b)=>a<b?-1:a>b?1:0);
const freshContext=ctx=>({...ctx,readBytes:0});
export const CODE_GRAPH_POLICY=Object.freeze({version:1,directory:DIRECTORY,tool:'code_graph',readOnly:true,
  actions:['status','search','neighbors','impact'],languages:LANGUAGES,parserVersion:PARSER_VERSION,modelCalls:0,
  evidence:'syntax only; mentions are not resolved semantic calls; dependency targets use relative module paths',
  persistence:'fixed-path host CLI refresh; optional bounded host watch; no MCP writes or automatic commits',
  limits:{files:MAX_FILES,sourceBytes:MAX_SOURCE,indexBytes:MAX_INDEX,totalSourceBytes:16*1048576,facts:MAX_FACTS}});

async function snapshot(ctx,withText=false) {
  const raw=await safe.git(ctx,['ls-files','--stage','-z']);
  const records=raw.split('\0').filter(Boolean).map(value=>{
    const match=/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(value);
    if(!match) fail('Invalid Git inventory');
    return {mode:match[1],stage:match[3],path:match[4]};
  });
  if(records.length>20000) fail('Git inventory exceeds graph budget');
  const eligible=[],excluded=[]; const unsupported={};
  for(const record of records) {
    const {path,mode,stage}=record;
    try {safe.sourcePath(path);} catch {continue;}
    if(!LANGUAGES[extname(path)]) {const ext=extname(path)||'<none>';unsupported[ext]=(unsupported[ext]??0)+1;continue;}
    if(stage!=='0') fail('Resolve Git conflicts before indexing code');
    if(!['100644','100755'].includes(mode)) {excluded.push({path,reason:'not-ordinary'});continue;}
    eligible.push(path);
  }
  if(eligible.length>MAX_FILES) fail('Code graph file limit exceeded');
  const ignored=new Set(eligible.length?(await safe.git(ctx,['check-ignore','--no-index','--stdin','-z'],[0,1],eligible.join('\0')+'\0')).split('\0').filter(Boolean):[]);
  const files=[];
  for(const path of sorted(eligible)) {
    if(ignored.has(path)) {excluded.push({path,reason:'ignored'});continue;}
    let source;
    try {source=await safe.readText(ctx,path,MAX_SOURCE);}
    catch(error) {if(error.code==='ENOENT') {excluded.push({path,reason:'missing'});continue;} throw error;}
    files.push({path,sha256:safe.digest(source),...(withText?{source}:{})});
  }
  return {files,excluded,unsupported};
}
function inventory(snapshot) {return snapshot.files.map(({path,sha256})=>({path,sha256}));}
function validateIndex(value) {
  const result=indexSchema.safeParse(value);
  if(!result.success) fail('Invalid code graph schema; restore or explicitly remove the index before rebuilding');
  const index=result.data, paths=new Set();let count=0;
  for(const file of index.files) {
    safe.sourcePath(file.path);
    if(paths.has(file.path)||LANGUAGES[extname(file.path)]!==file.facts.language) fail('Invalid code graph source identity');
    paths.add(file.path);const ids=new Set(file.facts.symbols.map(s=>s.id));
    if(ids.size!==file.facts.symbols.length) fail('Duplicate graph symbol');
    for(const symbol of file.facts.symbols) if(!symbol.id.startsWith(`${file.path}#`) || symbol.endLine<symbol.line || (symbol.parent&&!ids.has(symbol.parent))) fail('Invalid graph symbol identity');
    for(const mention of file.facts.mentions) if(mention.from&&!ids.has(mention.from)) fail('Invalid graph mention source');
    if(file.facts.status==='parse-error' && (file.facts.symbols.length||file.facts.imports.length||file.facts.mentions.length)) fail('Parse errors cannot provide graph facts');
    count+=file.facts.symbols.length+file.facts.imports.length+file.facts.mentions.length;
  }
  if(count>MAX_FACTS) fail('Graph fact budget exceeded');
  return index;
}
async function loadIndex(ctx) {
  let text;
  try {text=await safe.readText(freshContext(ctx),INDEX,MAX_INDEX);} catch(error) {if(error.code==='ENOENT') return null;throw error;}
  let value;try {value=JSON.parse(text);} catch {fail('Invalid code graph JSON');}
  return {index:validateIndex(value),revision:safe.digest(text)};
}
function difference(previous,current) {
  const before=new Map(previous.map(f=>[f.path,f.sha256])),after=new Map(current.map(f=>[f.path,f.sha256]));
  return {added:current.filter(f=>!before.has(f.path)).map(f=>f.path),
    changed:current.filter(f=>before.has(f.path)&&before.get(f.path)!==f.sha256).map(f=>f.path),
    deleted:previous.filter(f=>!after.has(f.path)).map(f=>f.path)};
}
function isChanged(diff) {return diff.added.length+diff.changed.length+diff.deleted.length>0;}
function resolveModule(file,imported,paths) {
  const spec=imported.specifier,candidates=[];
  if(file.facts.language==='python') {
    // Absolute Python imports depend on sys.path/package configuration: do not guess.
    const match=/^(\.+)([\p{L}\p{N}_\.]+)?$/u.exec(spec);
    if(match) {
      let directory=posix.dirname(file.path);
      for(let i=1;i<match[1].length;i++) {if(directory==='.') return {target:null,resolution:'unresolved'};directory=posix.dirname(directory);}
      const base=posix.join(directory,(match[2]??'').replaceAll('.','/'));
      candidates.push(`${base}.py`,posix.join(base,'__init__.py'));
    }
  } else if(spec.startsWith('./')||spec.startsWith('../')) {
    const base=posix.normalize(posix.join(posix.dirname(file.path),spec));
    if(extname(base)) candidates.push(base);
    else for(const ext of Object.keys(LANGUAGES).filter(e=>e!=='.py')) candidates.push(`${base}${ext}`,`${base}/index${ext}`);
  }
  const matches=[...new Set(candidates.filter(p=>!p.startsWith('../')&&paths.has(p)))];
  return {target:matches.length===1?matches[0]:null,resolution:matches.length===1?'relative-path':matches.length>1?'ambiguous':'unresolved'};
}
function graph(index) {
  const nodes=[],edges=[],paths=new Set(index.files.map(f=>f.path));
  for(const file of index.files) {
    nodes.push({id:file.path,path:file.path,name:posix.basename(file.path),kind:'file',line:1,status:file.facts.status});
    for(const symbol of file.facts.symbols) {
      nodes.push({...symbol,path:file.path});
      edges.push({from:symbol.parent??file.path,to:symbol.id,kind:'contains',path:file.path,line:symbol.line,evidence:'syntax'});
    }
    file.facts.imports.forEach((imported,i)=>{
      const resolved=resolveModule(file,imported,paths),id=`${file.path}#import:${i}`;
      if(!resolved.target) nodes.push({id,path:file.path,name:imported.specifier,kind:'module-mention',line:imported.line});
      edges.push({from:file.path,to:resolved.target??id,kind:'imports',path:file.path,line:imported.line,
        specifier:imported.specifier,resolution:resolved.resolution,evidence:'syntax'});
    });
    file.facts.mentions.forEach((mention,i)=>{
      const id=`${file.path}#mention:${i}`;
      nodes.push({id,path:file.path,name:mention.name,kind:`${mention.kind}-mention`,line:mention.line});
      edges.push({from:mention.from??file.path,to:id,kind:mention.kind,path:file.path,line:mention.line,resolution:'unresolved',evidence:'syntax'});
    });
  }
  return {nodes,edges};
}

// MCP calls this read-only entry point. Refresh/watch are deliberately not admitted here.
export async function affectedFiles(cwd, changedPaths, depth=3) {
  if(!Array.isArray(changedPaths)||changedPaths.length>512||!Number.isInteger(depth)||depth<1||depth>8) fail('Invalid impact batch');
  changedPaths.forEach(safe.sourcePath);
  const ctx=await safe.context(cwd),loaded=await loadIndex(ctx),current=await snapshot(ctx);
  const stale=!loaded||loaded.index.parserVersion!==PARSER_VERSION||isChanged(difference(loaded.index.files,current.files));
  if(stale) return {usable:false,reason:loaded?'stale':'missing',files:[],truncated:false};
  const {edges}=graph(loaded.index),known=new Set(loaded.index.files.map(f=>f.path)),visited=new Set(changedPaths),frontier=[...changedPaths];
  let level=0,currentFrontier=frontier;
  while(currentFrontier.length&&level<depth) {
    const next=[];
    for(const edge of edges) if(edge.kind==='imports'&&known.has(edge.to)&&currentFrontier.includes(edge.to)&&!visited.has(edge.from)) {visited.add(edge.from);next.push(edge.from);}
    currentFrontier=next;level++;
  }
  const truncated=edges.some(e=>e.kind==='imports'&&known.has(e.to)&&currentFrontier.includes(e.to)&&!visited.has(e.from));
  return {usable:true,revision:loaded.revision,files:[...visited].sort(),unindexed:changedPaths.filter(p=>!known.has(p)),truncated,
    parseErrors:loaded.index.files.filter(f=>f.facts.status==='parse-error').map(f=>f.path),evidence:'relative file imports only'};
}

export async function codeGraph(input) {
  if(!input||Object.keys(input).some(k=>!['cwd','action','query','id','direction','depth','offset','limit','allowStale'].includes(k))) fail('Unknown code graph option');
  const {cwd,action='status',query='',id,direction='both',depth=3,offset=0,limit=40,allowStale=false}=input;
  if(!CODE_GRAPH_POLICY.actions.includes(action)||!['both','incoming','outgoing'].includes(direction)
    ||!Number.isInteger(depth)||depth<1||depth>8||!Number.isInteger(offset)||offset<0||offset>200000
    ||!Number.isInteger(limit)||limit<1||limit>100||typeof allowStale!=='boolean'||typeof query!=='string'||query.length>200
    ||(id!==undefined&&(typeof id!=='string'||id.length>1024))) fail('Invalid code graph query');
  const ctx=await safe.context(cwd),loaded=await loadIndex(ctx),current=await snapshot(ctx);
  const diff=difference(loaded?.index.files??[],current.files);
  const stale=!loaded||loaded.index.parserVersion!==PARSER_VERSION||isChanged(diff);
  const parseErrors=loaded?.index.files.filter(f=>f.facts.status==='parse-error').map(f=>f.path)??[];
  const base={ok:true,action,modelCalls:0,readOnly:true,exists:!!loaded,stale,revision:loaded?.revision??null,
    changes:diff,excluded:current.excluded,unsupported:current.unsupported,sourceCommit:ctx.head,parseErrors,
    evidence:'syntactic; untrusted persisted data; mentions do not resolve runtime calls',nextAction:stale?'Run the authorized host code-graph CLI refresh':null};
  if(action==='status') return {...base,files:loaded?.index.files.length??0};
  if(!loaded||stale&&!allowStale) return {...base,ok:false,status:loaded?'stale':'missing',items:[],nextOffset:null};
  const {nodes,edges}=graph(loaded.index);let items,extra={};
  if(action==='search') {
    const needle=query.toLowerCase();items=nodes.filter(n=>(n.name+' '+n.id).toLowerCase().includes(needle));
  } else {
    const node=nodes.find(n=>n.id===id);if(!node) return {...base,status:'no-match',items:[],nextOffset:null};
    if(action==='neighbors') {
      items=edges.filter(e=>(direction!=='incoming'&&e.from===id)||(direction!=='outgoing'&&e.to===id));
      const endpointIds=new Set(items.slice(offset,offset+limit).flatMap(e=>[e.from,e.to]));extra.nodes=nodes.filter(n=>endpointIds.has(n.id));
    } else {
      // Conservative reverse FILE dependencies only; symbol seeds are lifted to their file.
      const seed=node.path,visited=new Set([seed]),results=[],queue=[{path:seed,distance:0}];let truncatedDepth=false;
      const incoming=new Map();
      for(const edge of edges) if(edge.kind==='imports'&&edge.resolution==='relative-path') {
        const list=incoming.get(edge.to)??[];list.push(edge);incoming.set(edge.to,list);
      }
      for(let i=0;i<queue.length;i++) {
        const entry=queue[i];
        for(const edge of incoming.get(entry.path)??[]) if(!visited.has(edge.from)) {
          if(entry.distance>=depth) {truncatedDepth=true;continue;}
          visited.add(edge.from);const next={path:edge.from,distance:entry.distance+1,via:entry.path,line:edge.line};queue.push(next);results.push(next);
        }
      }
      items=results;extra={seedFile:seed,truncatedDepth,coverage:'relative-path imports only; unresolved imports and runtime dispatch are not covered'};
    }
  }
  const output={...base,...extra,status:items.length?'success':'no-match',total:items.length,items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null};
  return JSON.parse(redactSensitiveText(JSON.stringify(output),{compact:false}));
}

class ParserWorker {
  constructor() {this.worker=new Worker(new URL('./code-graph-parser.mjs',import.meta.url),{resourceLimits:{maxOldGenerationSizeMb:192},execArgv:[]});this.next=0;}
  parse(path,source) {
    return new Promise((resolve,reject)=>{
      const id=++this.next,finish=(error,result)=>{
        clearTimeout(timer);this.worker.off('message',message);this.worker.off('error',failed);this.worker.off('exit',exited);
        if(error) {reject(error);return;}
        const parsed=factsSchema.safeParse(result);
        parsed.success?resolve(parsed.data):reject(new Error('Invalid parser result'));
      };
      const failed=()=>finish(new Error('Code graph parser worker failed'));
      const exited=()=>finish(new Error('Code graph parser worker exited'));
      const message=value=>{if(value.id===id) finish(value.error?new Error(value.error):null,value.result);};
      const timer=setTimeout(()=>{finish(new Error('Code graph parser deadline exceeded'));void this.worker.terminate();},10000);
      this.worker.on('message',message);this.worker.once('error',failed);this.worker.once('exit',exited);
      this.worker.postMessage({id,path,source});
    });
  }
  close() {return this.worker.terminate();}
}
async function ensureDirectory(ctx) {
  for(const name of ['.yhwh',DIRECTORY]) {
    try {await safe.checkedPath(ctx.root,name,true);} catch(error) {
      if(error.code!=='ENOENT') throw error;
      await mkdir(join(ctx.root,name));await safe.checkedPath(ctx.root,name,true);
    }
  }
}

export async function refreshCodeGraph({cwd,expectedRevision}={}) {
  if(expectedRevision!==undefined&&expectedRevision!==null&&!/^[a-f0-9]{64}$/.test(expectedRevision)) fail('Invalid expected revision');
  const ctx=await safe.context(cwd);await ensureDirectory(ctx);
  let lock;
  try {lock=await open(join(ctx.root,LOCK),'wx',0o600);} catch(error) {if(error.code==='EEXIST') fail('Graph refresh locked; reconcile the owner before removing a leftover lock');throw error;}
  let worker,temp;
  try {
    await safe.checkedPath(ctx.root,DIRECTORY,true);await lock.writeFile(JSON.stringify({pid:process.pid,token:randomUUID()})+'\n');
    const loaded=await loadIndex(ctx);
    if(expectedRevision!==undefined&&expectedRevision!==(loaded?.revision??null)) fail('Graph revision conflict');
    const current=await snapshot(freshContext(ctx),true),diff=difference(loaded?.index.files??[],current.files);
    const previous=new Map(loaded?.index.parserVersion===PARSER_VERSION?loaded.index.files.map(f=>[f.path,f]):[]);
    const files=[];let parsed=0,reused=0;
    const deadline=Date.now()+120000;
    for(const {path,sha256,source} of current.files) {
      if(Date.now()>deadline) fail('Graph refresh deadline exceeded');
      const old=previous.get(path);
      if(old?.sha256===sha256) {files.push(old);reused++;continue;}
      worker??=new ParserWorker();files.push({path,sha256,facts:await worker.parse(path,source)});parsed++;
    }
    const index=validateIndex({schemaVersion:1,parserVersion:PARSER_VERSION,files});
    const content=JSON.stringify(index,null,2)+'\n';if(Buffer.byteLength(content)>MAX_INDEX) fail('Graph index size budget exceeded');
    const result={ok:true,action:'refresh',modelCalls:0,parsed,reused,files:files.length,changes:diff,excluded:current.excluded,unsupported:current.unsupported,
      parseErrors:files.filter(f=>f.facts.status==='parse-error').map(f=>f.path),revision:safe.digest(content)};
    // Recheck ALL hashes and membership, including Git ignore/index changes, before publishing.
    const after=await snapshot(freshContext(ctx));
    if(!same(inventory(current),inventory(after))) fail('Sources changed during refresh; previous index preserved');
    const now=await loadIndex(ctx);
    if(now?.revision!==loaded?.revision) fail('Graph changed during refresh; previous index preserved');
    if(loaded?.revision===result.revision) return {...result,written:false};
    temp=`${DIRECTORY}/index-${randomUUID()}.tmp`;
    await safe.checkedPath(ctx.root,DIRECTORY,true);
    const handle=await open(join(ctx.root,temp),'wx',0o600);
    try {await handle.writeFile(content,'utf8');await handle.sync();} finally {await handle.close();}
    await safe.checkedPath(ctx.root,temp);await safe.checkedPath(ctx.root,DIRECTORY,true);
    if(loaded) await safe.checkedPath(ctx.root,INDEX);
    if((await loadIndex(ctx))?.revision!==loaded?.revision) fail('Graph changed before replacement; concurrent edits preserved');
    // Same-directory atomic replacement; never unlink the previous good index first.
    await rename(join(ctx.root,temp),join(ctx.root,INDEX));temp=null;
    return {...result,written:true};
  } finally {
    if(worker) await worker.close();
    await lock.close();
    // Cleanup is confined to the checked directory and only our temporary file/lock.
    await safe.checkedPath(ctx.root,DIRECTORY,true);
    if(temp) await unlink(join(ctx.root,temp)).catch(()=>{});
    await unlink(join(ctx.root,LOCK));
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const input=JSON.parse(process.argv[2]??'{}');
    if(input.action==='refresh'||input.action==='watch') {
      const allowed=['cwd','action','expectedRevision',...(input.action==='watch'?['intervalSeconds','durationSeconds']:[])];
      if(Object.keys(input).some(k=>!allowed.includes(k))) fail('Unknown graph update option');
      if(input.action==='refresh') console.log(JSON.stringify(await refreshCodeGraph(input)));
      else {
        const interval=input.intervalSeconds??5,duration=input.durationSeconds??300;
        if(!Number.isInteger(interval)||interval<2||interval>60||!Number.isInteger(duration)||duration<1||duration>3600||input.expectedRevision!==undefined) fail('Invalid watch budget');
        const end=Date.now()+duration*1000,controller=new AbortController();
        process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
        do {
          console.log(JSON.stringify(await refreshCodeGraph({cwd:input.cwd})));
          await delay(Math.min(interval*1000,Math.max(0,end-Date.now())),undefined,{signal:controller.signal}).catch(()=>{});
        } while(Date.now()<end&&!controller.signal.aborted);
      }
    } else console.log(JSON.stringify(await codeGraph(input)));
  } catch(error) {console.error(JSON.stringify({ok:false,error:redactSensitiveText(error.message,{compact:false})}));process.exitCode=1;}
}
