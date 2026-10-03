import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {parseArgs} from 'node:util';
import {collectGitDiffContext} from './git-diff-context.mjs';

const exec=promisify(execFile),here=dirname(fileURLToPath(import.meta.url));
function args(argv){
 const parsed=parseArgs({args:argv.slice(2),options:{baseline:{type:'string'},iterations:{type:'string',default:'3'}},strict:true,allowPositionals:false});
 const baseline=parsed.values.baseline,iterations=Number(parsed.values.iterations);
 if(!baseline||!Number.isInteger(iterations)||iterations<1||iterations>20)throw new Error('Usage: node scripts/benchmark-git-context.mjs --baseline FILE [--iterations 1..20]');
 return {baseline:resolve(baseline),iterations};
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function importBaseline(file){
 const source=await readFile(file,'utf8');let rebound=source;
 for(const [specifier,target] of [['./project-memory.mjs',join(here,'project-memory.mjs')],['../extensions/write-scope-guard.js',resolve(here,'../extensions/write-scope-guard.js')],['../extensions/audit-log.js',resolve(here,'../extensions/audit-log.js')]])rebound=rebound.replaceAll(specifier,pathToFileURL(target).href);
 const directory=await mkdtemp(join(tmpdir(),'git-context-baseline-module-')),modulePath=join(directory,'baseline.mjs');
 try{await writeFile(modulePath,rebound);const collector=(await import(pathToFileURL(modulePath).href)).collectGitDiffContext;if(typeof collector!=='function')throw new Error('Baseline module does not export collectGitDiffContext');return collector;}finally{await rm(directory,{recursive:true,force:true});}
}
async function scenario(name,rejected,iterations,before,after){
 const root=await mkdtemp(join(tmpdir(),'git-context-benchmark-'));
 try{
  const git=async(...argv)=>exec('git',['-c',`safe.directory=${root}`,...argv],{cwd:root,timeout:10000,maxBuffer:1048576});
  await git('init','-q');await git('config','user.name','Benchmark');await git('config','user.email','benchmark@example.invalid');
  const scopes=[];
  for(let i=0;i<rejected;i++){const path=`a-rejected-${String(i).padStart(2,'0')}.txt`;scopes.push(path);await writeFile(join(root,path),'x'.repeat(270000));}
  for(let i=0;i<8;i++){const path=`z-change-${i}.txt`;scopes.push(path);await writeFile(join(root,path),`original ${i}\n`);}
  await git('add','-A');await git('commit','-qm','benchmark baseline');
  for(let i=0;i<rejected;i++)await writeFile(join(root,`a-rejected-${String(i).padStart(2,'0')}.txt`),'x'.repeat(270001));
  for(let i=0;i<8;i++)await writeFile(join(root,`z-change-${i}.txt`),`original ${i}\nbenign update ${i}\n`);
  const options={cwd:root,roots:[root],readScope:scopes,writeScope:[],maxBytes:8192,maxEntries:59};
  const times={before:[],after:[]},outputs={};
  for(let i=0;i<iterations;i++)for(const side of (i%2?['after','before']:['before','after'])){const start=performance.now();outputs[side]=await (side==='before'?before:after)(options);times[side].push(performance.now()-start);}
  const evidenceOf=result=>result.contexts.flatMap(value=>{const m=/category=(staged|unstaged); path=([^\n;]+)(?=; truncated=)/.exec(value);return m?[`${m[1]}:${m[2]}`]:[];}).sort();
  const beforeEvidence=evidenceOf(outputs.before),afterEvidence=evidenceOf(outputs.after);
  const expected=Array.from({length:8},(_,i)=>`unstaged:z-change-${i}.txt`).sort();
  const equivalent=JSON.stringify(beforeEvidence)===JSON.stringify(afterEvidence)&&JSON.stringify(beforeEvidence)===JSON.stringify(expected)&&outputs.before.omitted===outputs.after.omitted;
  if(!equivalent)throw new Error(`${name}: before/after evidence mismatch (${beforeEvidence.length} vs ${afterEvidence.length} category/path pairs)`);
  for(const side of ['before','after'])for(let i=0;i<8;i++)if(!outputs[side].contexts.join('\n').includes(`benign update ${i}`))throw new Error(`${name}: ${side} lacks benign update for z-change-${i}.txt`);
  return {name,fixture:{textChanges:8,rejectedOversize:rejected,scopedPaths:scopes.length},equivalent,before:{medianMs:median(times.before),evidence:beforeEvidence,omitted:outputs.before.omitted},after:{medianMs:median(times.after),evidence:afterEvidence,omitted:outputs.after.omitted},ratio:median(times.after)/median(times.before)};
 }finally{await rm(root,{recursive:true,force:true});}
}
async function main(){
 const {baseline,iterations}=args(process.argv),baselineCollector=await importBaseline(baseline);
 const normal=await scenario('normal-eight-text-changes',0,iterations,baselineCollector,collectGitDiffContext);
 const rejected=await scenario('twenty-rejected-before-eight-valid',20,iterations,baselineCollector,collectGitDiffContext);
 process.stdout.write(JSON.stringify({iterations,node:process.version,scenarios:[normal,rejected]},null,2)+'\n');
}
try{await main();}catch(error){const usage=error.code?.startsWith('ERR_PARSE_ARGS')||error.message.startsWith('Usage:');process.stderr.write(`${usage?'Usage error':'benchmark failed'}: ${error.message}\n`);process.exitCode=usage?2:1;}
