import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

// Fixed source policy, never selected by a task, environment or model output.
export const EXIT_POLICY = 'bounded-exit';
export const LIFECYCLE_PREFIX = 'PI_WORKER_LIFECYCLE_V1=';
export const LIFECYCLE_STATE = Symbol.for('yhwh.pi.singleShotLifecycle.v1');
const SDK_ROOT='/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/';
const PINS=Object.freeze({
  'package.json':'db9fead11bd2ddf7a327d2c2d11b535f30d059241c251d376837d5ab638a5576',
  'dist/cli.js':'840d1e8e689ed9e4937bcb00b9a810e02a8567d9afb10a47097f11ca93ea1521',
  'dist/main.js':'f8cf0b949a4042d6aa02f24d93818519d51a9034a5734749041d344cfcf2f509',
  'dist/config.js':'9fcb50fd3192dd8550be77bd178c754a80512f20dc0058335b21b42954812a7f',
  'dist/core/http-dispatcher.js':'3b85f8e50dd8b1c547d8e1c393928f3db7ec671d6f72b94f636331e529485ea4',
  'dist/modes/print-mode.js':'f2eb170b9620c1d37e68b788ff71257a4402a23e7f3999575feee8e5d9e13b3f',
  'dist/core/agent-session-runtime.js':'9111bc651657e5bbc55288219dd2aec728af65f1bd0539132f09875408983c60',
  'dist/core/agent-session.js':'e213e4094a3f176b2491e0470ac8ecd88aeab0030d35aabd9ba289ba7b74b923',
  'dist/core/output-guard.js':'e860db94650c57e07582c300983671737bf9e796682193b498f75e3dd72e9024',
});
export function pinnedSdkMatches(read=readFileSync){
  try{return Object.entries(PINS).every(([p,h])=>createHash('sha256').update(read(SDK_ROOT+p)).digest('hex')===h);}catch{return false;}
}
const REQUIRED=['--offline','--no-approve','--no-skills','--no-prompt-templates','--no-context-files','--no-themes','--no-extensions','--print','--no-session'];
const EXTENSIONS=new Set(['role-presets','read-scope-guard','lsp-proxy','write-scope-guard','auth-scrub','source-window','result-submit','run-check-proxy','editor-proxy'].map(n=>'/opt/pi-kether/extensions/'+n+'.js'));
const MODELS=new Set(['gpt-5.4','gpt-5.4-mini','gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-6-luna','gpt-6-sol']);
const ROLES=new Set(['Yesod','Binah','Malkuth','Hod','Chochmah','Chesed','Netzach','Geburah']);
const TOOLS=new Set(['read','grep','find','ls','edit','write','yhwh_source_window','yhwh_submit_result','yhwh_run_check','pi_editor_execute',...['diagnostics','hover','definition','references','symbols','completions','code_actions'].map(n=>'yhwh_lsp_'+n)]);
export function isSingleShotArgs(args){
  if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))return false;
  const flags=new Set(),extensions=new Set(),values={};
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(REQUIRED.includes(a)||a==='--no-tools'){if(flags.has(a))return false;flags.add(a);continue;}
    if(!['--mode','--provider','--model','--thinking','--extension','--tools','--yhwh-role-preset','--yhwh-result-role'].includes(a))return false;
    const v=args[++i];if(!v||v.startsWith('--'))return false;
    if(a==='--extension'){if(!EXTENSIONS.has(v)||extensions.has(v))return false;extensions.add(v);continue;}
    if(Object.hasOwn(values,a))return false;values[a]=v;
  }
  if(!REQUIRED.every(a=>flags.has(a))||values['--mode']!=='json'||values['--provider']!=='openai-codex'||!MODELS.has(values['--model']))return false;
  if(values['--thinking']&&!['off','minimal','low','medium','high','xhigh','max'].includes(values['--thinking']))return false;
  for(const key of ['--yhwh-role-preset','--yhwh-result-role'])if(values[key]&&!ROLES.has(values[key]))return false;
  if(flags.has('--no-tools')===Object.hasOwn(values,'--tools'))return false;
  if(values['--tools']){const tools=values['--tools'].split(',');if(new Set(tools).size!==tools.length||tools.some(t=>!TOOLS.has(t)))return false;}
  return true;
}
const EVENTS=new Set(['boot','agent_start','agent_end','agent_settled','shutdown','socket_close_requested','socket_closed','main_return','drains_complete','exit_ready','natural_exit','main_failed','drain_failed']);
export function createLifecycle({now=()=>performance.now(),emit=line=>process.stderr.write(line)}={}){
  const origin=now(),tools=new Set();let n=0,valid=true,active=false,settled=false,shutdown=false,started=false;
  const mark=event=>{if(EVENTS.has(event)&&n<32){try{emit(LIFECYCLE_PREFIX+JSON.stringify({v:1,n:++n,event,ms:Math.max(0,now()-origin)})+'\n');}catch{}}};
  return{mark,
    event(type,event={}){
      if(type==='tool_execution_start'){const id=event.toolCallId;if(typeof id!=='string'||tools.has(id)||tools.size>=64)valid=false;else tools.add(id);return;}
      if(type==='tool_execution_end'){if(!tools.delete(event.toolCallId))valid=false;return;}
      if(type==='agent_start'){if(active)valid=false;active=true;started=true;settled=false;}
      if(type==='agent_end'){if(!active)valid=false;active=false;}
      if(type==='agent_settled')settled=true;
      if(type==='session_shutdown')shutdown=true;
      mark(type==='session_shutdown'?'shutdown':type);
    },
    idle(){return valid&&started&&!active&&settled&&shutdown&&tools.size===0;},
  };
}
export function observeSocketClose(state,ctor=globalThis.WebSocket){
  const prototype=ctor?.prototype,original=prototype?.close;
  if(typeof original!=='function')return()=>{};
  const seen=new WeakSet();
  function close(...args){
    const result=Reflect.apply(original,this,args);
    try{if(!seen.has(this)){seen.add(this);this.addEventListener('close',()=>state.mark('socket_closed'),{once:true});state.mark('socket_close_requested');}}catch{}
    return result;
  }
  prototype.close=close;
  return()=>{if(prototype.close===close)prototype.close=original;};
}
export function drainStream(stream,{timeoutMs=2000}={}){
  return new Promise((resolve,reject)=>{
    let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(!error)stream.removeListener('error',onError);const code=['EPIPE','timeout'].includes(error?.code)?(error.code==='EPIPE'?'epipe':'timeout'):'drain-error';if(error)reject(Object.assign(new Error(code),{code}));else resolve();};
    const onError=error=>finish(error),timer=setTimeout(()=>finish({code:'timeout'}),timeoutMs);
    stream.once('error',onError);
    try{stream.write('',error=>finish(error));}catch(error){finish(error);}
  });
}
export async function finishSingleShot(main,state,{policy=EXIT_POLICY,stdout=process.stdout,stderr=process.stderr,exit=code=>process.exit(code),getExitCode=()=>process.exitCode??0,disconnect=()=>{if(process.connected)process.disconnect();}}={}){
  try{await main();}catch{state.mark('main_failed');process.exitCode=2;await Promise.allSettled([drainStream(stdout),drainStream(stderr)]);exit(2);return;}
  state.mark('main_return');
  if(policy!=='bounded-exit'||!state.idle()){state.mark('natural_exit');return;}
  state.mark('exit_ready');
  try{await drainStream(stdout);await drainStream(stderr);state.mark('drains_complete');await drainStream(stderr);}catch{state.mark('drain_failed');process.exitCode=2;exit(2);return;}
  // No diagnostic write follows the final stderr drain.
  disconnect();exit(Number.isInteger(getExitCode())?getExitCode():2);
}

// Diagnostic only. Suppress the reserved line namespace, even forged or malformed frames.
// All input bytes are charged by the caller before this bounded parser sees them.
export function createLifecycleFilter({onEvent=()=>{},onOutput=()=>{}}={}){
  let pending='',discard=false,count=0,last=-1,lastMs=-1;
  const line=text=>{
    if(!text.startsWith(LIFECYCLE_PREFIX)){onOutput(text);return;}
    if(count>=32)return;
    try{const v=JSON.parse(text.slice(LIFECYCLE_PREFIX.length));if(Object.keys(v).length===4&&v.v===1&&Number.isInteger(v.n)&&v.n>last&&v.n<=32&&EVENTS.has(v.event)&&Number.isFinite(v.ms)&&v.ms>=lastMs&&v.ms<=86400000){count++;last=v.n;lastMs=v.ms;onEvent({...v});}}catch{}
  };
  return{feed(chunk){
    for(const part of String(chunk).split(/(?<=\n)/)){
      if(discard){if(part.endsWith('\n'))discard=false;continue;}
      pending+=part;
      if(pending.endsWith('\n')){line(pending);pending='';}
      else if(pending.length>4096){if(pending.startsWith(LIFECYCLE_PREFIX)){pending='';discard=true;}else{onOutput(pending);pending='';}}
    }
  },close(){if(pending)line(pending);pending='';}};
}

export async function runPinnedSingleShot(args){
  const state=createLifecycle();globalThis[LIFECYCLE_STATE]=state;state.mark('boot');
  observeSocketClose(state);
  const {APP_NAME}=await import(SDK_ROOT+'dist/config.js');
  const {configureHttpDispatcher}=await import(SDK_ROOT+'dist/core/http-dispatcher.js');
  const {main}=await import(SDK_ROOT+'dist/main.js');
  process.title=APP_NAME;process.env.PI_CODING_AGENT='true';process.env.AI_AGENT='pi';process.emitWarning=()=>{};
  configureHttpDispatcher();
  await finishSingleShot(()=>main([...args,'--extension','/opt/pi-kether/extensions/single-shot-lifecycle.js']),state);
}
