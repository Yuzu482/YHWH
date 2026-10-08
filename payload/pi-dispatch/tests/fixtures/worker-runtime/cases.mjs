// Synthetic compatibility vectors; no historical task text, credentials or raw ledger events.
const request={target:'model',provider:'openai-codex',model:'gpt-6-luna',access:'read'};
const message=(extra={})=>({type:'message_end',message:{role:'assistant',provider:request.provider,model:request.model,stopReason:'stop',content:[{type:'text',text:'first'},{type:'thinking',thinking:'synthetic'},{type:'text',text:'第二行 café'}],usage:{input:12,output:4},...extra}});
const end={type:'agent_end'},start={type:'agent_start'};
const call=(id,path,isError)=>[{type:'tool_execution_start',toolCallId:id,toolName:'edit',args:{path}},{type:'tool_execution_end',toolCallId:id,toolName:'edit',isError}];
const submission=details=>({type:'tool_execution_end',toolName:'yhwh_submit_result',toolCallId:'submission',isError:false,result:{details}});
const goodSubmission={type:'kether_result_submission',canonicalText:'KETHER_RESULT_JSON={"a":1,"b":2}'};
const summaries=[];
function add(name,events=[message(),end],raw={},req={}){summaries.push({name,request:{...request,...req},raw:{exitCode:0,failure:null,stderr:'',stdout:events.map(JSON.stringify).join('\n'),...raw}});}
add('normal');add('warning-and-invalid-json',[],{stdout:'not json\n'+JSON.stringify(message())+'\r\n'+JSON.stringify(end)+'\n',stderr:'harmless warning'});
add('recovered',[...call('one','src\\a.js',true),...call('two','src/a.js',false),message(),end]);
add('unrecovered',[...call('one','src/a.js',true),...call('two','src/b.js',false),message(),end]);
add('ambiguous-id',[...call('one','src/a.js',true),...call('one','src/a.js',false),message(),end]);
add('missing-id',[{type:'tool_execution_end',toolName:'edit',isError:true},message(),end]);
add('invalid-target',[...call('one','../a.js',true),...call('two','../a.js',false),message(),end]);
add('missing-end',[message()]);add('missing-message',[end]);add('empty-stream',[]);
add('semantic-error',[message({stopReason:'error',errorMessage:'synthetic failure'}),end]);
add('route-mismatch',[message({model:'unselected-model'}),end]);
add('timeout',undefined,{failure:'timeout',exitCode:124});add('cancelled',undefined,{failure:'cancelled',exitCode:143});add('terminated',undefined,{exitCode:143});
add('output-limit',undefined,{failure:'output-limit',outputLimitObservation:{bucket:'retained',limitBytes:64}});
add('auth-before-model',[],{exitCode:4,stderr:'PI_AUTH_EXPIRED\n'});
add('explicit-failure-priority',[message({stopReason:'error',errorMessage:'secondary'})],{failureCode:'PRIMARY_FAILURE',failure:'timeout',exitCode:124});
add('cleanup-failure',undefined,{failure:'sandbox-cleanup-failed:synthetic',cleanup:{ok:false,exitCode:1,stderr:'synthetic'},sandbox:'wsl2-bwrap'});
add('submission-valid',[submission(goodSubmission),message(),end],{}, {resultSubmissionRequired:true});
add('submission-missing',undefined,{}, {resultSubmissionRequired:true});
add('submission-multiple',[submission(goodSubmission),submission(goodSubmission),message(),end],{}, {resultSubmissionRequired:true});
add('submission-rejection-then-success',[submission({type:'kether_result_rejection',code:'RESULT_ROLE_SCHEMA_INVALID'}),submission(goodSubmission),message(),end],{}, {resultSubmissionRequired:true});
add('submission-invalid-rejection',[submission({type:'kether_result_rejection',code:'RESULT_ROLE_SCHEMA_INVALID',extra:true}),submission(goodSubmission),message(),end],{}, {resultSubmissionRequired:true});
add('submission-noncanonical',[submission({...goodSubmission,canonicalText:'KETHER_RESULT_JSON={"b":2,"a":1}'}),message(),end],{}, {resultSubmissionRequired:true});
add('submission-malformed',[submission({type:'wrong',canonicalText:'KETHER_RESULT_JSON={"a":1}'}),message(),end],{}, {resultSubmissionRequired:true});
add('patch-issued',undefined,{patch:'--- a/x\n+++ b/x\n',patchPolicy:'issued-credential-v1',secretLikeContent:false,patchSha256:'a'.repeat(64),patchBytes:20,patchValidation:{ok:true},sandbox:'wsl2-bwrap',cleanup:{ok:true,exitCode:0}});
add('patch-flagged',undefined,{patch:'synthetic patch',patchPolicy:'issued-credential-v1',secretLikeContent:true,patchSha256:'a'.repeat(64),patchBytes:15});
for(const code of ['PI_PATCH_CONTAINS_ISSUED_CREDENTIAL','PI_PATCH_TOKEN_INVALID','PI_PATCH_INVALID_BYTES'])add(code,[],{failure:code,stdout:'must not surface',stderr:'must not surface',exitCode:1,cleanup:{ok:false,exitCode:1,stderr:'must not surface'},patch:'must not surface'});
add('api-usage-cost',undefined,{}, {provider:'yhwh-worker-api',configuredTransport:{platform:'synthetic',protocol:'openai-responses',capabilityEvidence:'operator-declared'}});
summaries.at(-1).raw.stdout=[message({provider:'yhwh-worker-api',usage:{input:12,output:4,cost:{total:1}}}),end].map(JSON.stringify).join('\n');
add('unknown-events',[{type:'unknown',private:'ignored'},message(),end]);
add('null-legacy-error',[],{stdout:'null\n'});
add('invalid-message-content',[message({content:'legacy malformed string'}),end]);
const args=[];
for(const access of ['none','read','workspace-write'])for(const runtime of ['host','wsl2'])for(const preset of [false,true])for(const structured of [false,true]){
  args.push({name:[access,runtime,preset,structured].join('-'),request:{provider:'openai-codex',model:'gpt-6-luna',thinking:'medium',access,...(preset?{rolePresetId:'Chesed'}:{})},runtime,editor:false,structured});
}
args.push({name:'editor',request:{provider:'openai-codex',model:'gpt-6-luna',thinking:'high',access:'read',rolePresetId:'Chesed'},runtime:'wsl2',editor:true,structured:true});
args.push({name:'api-provider',request:{provider:'yhwh-worker-api',model:'gpt-6-luna',thinking:'max',access:'none',providerConfigDigest:'a'.repeat(64)},runtime:'wsl2',editor:false,structured:false});
args.push({name:'api-missing-digest',request:{provider:'yhwh-worker-api',model:'gpt-6-luna',access:'none'},runtime:'wsl2',editor:false,structured:false});
const streaming=[start,{type:'message_update',assistantMessageEvent:{type:'thinking_delta',thinking:'not retained'}},{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'café 中文 😀'}},...call('stream','x',true),message(),end];
const joined=streaming.map(e=>JSON.stringify(e)+'\n').join('');
const timelines=[{name:'whole-lines',chunks:streaming.map(e=>JSON.stringify(e)+'\n')},{name:'single-characters',chunks:joined.split('')},{name:'unterminated-end',chunks:[JSON.stringify(start)+'\n'+JSON.stringify(end)]},{name:'ignored-and-invalid',chunks:['not json\nnull\n'+JSON.stringify({type:'unknown'})+'\n',JSON.stringify(message())+'\n']},{name:'overlong-discard',chunks:['x'.repeat(1048577)+'\n',JSON.stringify(start)+'\n',JSON.stringify(end)+'\n']}];
export const vectors={provenance:'synthetic boundary fixtures; baseline outputs computed from frozen pre-change source and installed snapshots',summaries,args,timelines};
export function comparable(value){if(value===undefined)return {$undefined:true};if(typeof value==='number'&&!Number.isFinite(value))return {$number:String(value)};if(Array.isArray(value))return value.map(comparable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,comparable(value[k])]));return value;}
export function observe(fn){try{return {value:comparable(fn())};}catch(error){return {error:{name:error.name,message:error.message}};}}
export function normalizeRoots(value,root,profile){
  if(typeof value==='string'){
    const slash=value.replaceAll('\\','/');
    if(slash.includes(root.replaceAll('\\','/'))||slash.includes(profile.replaceAll('\\','/')))return slash.replaceAll(root.replaceAll('\\','/'),'@RUNTIME_ROOT@').replaceAll(profile.replaceAll('\\','/'),'@USERPROFILE@');
    return value;
  }
  if(Array.isArray(value))return value.map(v=>normalizeRoots(v,root,profile));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalizeRoots(v,root,profile)]));
  return value;
}
