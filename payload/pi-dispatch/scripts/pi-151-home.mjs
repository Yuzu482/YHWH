// Fixed historical route metadata, applied only inside a fresh Pi 1.5 sandbox home.
// This does not authorize routes or supply credentials.
import {constants,closeSync,openSync,realpathSync,lstatSync,writeFileSync,fsyncSync} from 'node:fs';
const LEGACY_MODELS=[
 {id:'gpt-5.4',name:'GPT-5.4',api:'openai-codex-responses',reasoning:true,input:['text','image'],cost:{input:2.5,output:15,cacheRead:0.25,cacheWrite:0,tiers:[{inputTokensAbove:272000,input:5,output:22.5,cacheRead:0.5,cacheWrite:0}]},contextWindow:272000,maxTokens:128000,thinkingLevelMap:{xhigh:'xhigh',minimal:'low'},compat:{supportsOpenAIGrammarTools:true,supportsToolSearch:true}},
 {id:'gpt-5.4-mini',name:'GPT-5.4 mini',api:'openai-codex-responses',reasoning:true,input:['text','image'],cost:{input:0.75,output:4.5,cacheRead:0.075,cacheWrite:0},contextWindow:272000,maxTokens:128000,thinkingLevelMap:{xhigh:'xhigh',minimal:'low'},compat:{supportsOpenAIGrammarTools:true,supportsToolSearch:true}},
 {id:'gpt-5.5',name:'GPT-5.5',api:'openai-codex-responses',reasoning:true,input:['text','image'],cost:{input:5,output:30,cacheRead:0.5,cacheWrite:0,tiers:[{inputTokensAbove:272000,input:10,output:45,cacheRead:1,cacheWrite:0}]},contextWindow:272000,maxTokens:128000,thinkingLevelMap:{xhigh:'xhigh',minimal:'low'},compat:{supportsOpenAIGrammarTools:true,supportsToolSearch:true}},
];
export function preparePi151Home(env=process.env){
 const dir='/home/pi-sandbox/agent';
 if(env.PI_DISPATCH_ACTIVE!=='1'||env.PI_CODING_AGENT_DIR!==dir)throw Error('PI_LEGACY_CATALOG_CONTEXT_INVALID');
 const st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(dir)!==dir)throw Error('PI_LEGACY_CATALOG_PATH_INVALID');
 const flags=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0);
 for(const [name,value] of [
   ['models.json',{providers:{'openai-codex':{models:LEGACY_MODELS}}}],
   ['settings.json',{cacheWarming:'off'}],
 ]){
   const fd=openSync(dir+'/'+name,flags,0o600);
   try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
 }
 return true;
}
