// SPDX-License-Identifier: Apache-2.0
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectAnthropicApiCredential} from './anthropic-api-credential.mjs';
import {API_PROVIDERS,loadProviderConfig,configDigest,configuredRoute,selectControlledCredential} from './controlled-provider.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export function readWindowsApiKey({store,reference,env=process.env,signal,spawnFn=spawn}={}) {
 if(!['Anthropic','Provider'].includes(store)||!/^[a-z][a-z0-9-]{0,39}$/.test(reference??''))return Promise.reject(fail('PI_AUTH_INVALID'));
 if(process.platform!=='win32')return Promise.reject(fail('PI_AUTH_WINDOWS_REQUIRED'));
 if(!env.USERPROFILE||!env.SystemRoot)return Promise.reject(fail('PI_AUTH_MISSING'));
 if(signal?.aborted)return Promise.reject(fail('PI_AUTH_CHECK_CANCELLED'));
 return new Promise((resolve,reject)=>{
  const helper=fileURLToPath(new URL('./Read-ApiCredential.ps1',import.meta.url));
  const child=spawnFn(join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-TargetHome',env.USERPROFILE,'-Store',store,'-Reference',reference],{shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
  let output='',error='',settled=false;
  const finish=(code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(code){output='';reject(fail(code));}else{const key=output;output='';resolve(key);}};
  const stop=code=>{child.kill();finish(code);};
  const abort=()=>stop('PI_AUTH_CHECK_CANCELLED');
  const timer=setTimeout(()=>stop('PI_AUTH_DECRYPT_TIMEOUT'),15000);
  signal?.addEventListener('abort',abort,{once:true});
  child.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk;if(output.length>8192)stop('PI_AUTH_INVALID');});
  child.stderr.setEncoding('utf8').on('data',chunk=>{error+=chunk;if(error.length>1024)stop('PI_AUTH_DECRYPT_FAILED');});
  child.on('error',()=>finish('PI_AUTH_DECRYPT_FAILED'));
  child.on('close',code=>{const safe=error.trim();finish(code===0?null:/^PI_AUTH_(MISSING|INVALID|MIGRATION_REQUIRED|DECRYPT_FAILED)$/.test(safe)?safe:'PI_AUTH_DECRYPT_FAILED');});
  if(signal?.aborted)abort();
 });
}
export async function prepareWindowsApiPacket(request,{env=process.env,signal}={}) {
 if(request.provider==='anthropic'){
  const key=await readWindowsApiKey({store:'Anthropic',reference:'anthropic',env,signal});
  return {version:1,provider:request.provider,credentials:selectAnthropicApiCredential({anthropic:{type:'api_key',key}})};
 }
 if(!API_PROVIDERS.includes(request.provider))throw fail('PI_AUTH_INVALID');
 const config=loadProviderConfig(env),route=configuredRoute(request.provider,config);
 if(!route||configDigest(config)!==request.providerConfigDigest)throw fail('PI_PROVIDER_CONFIG_CHANGED');
 const key=await readWindowsApiKey({store:'Provider',reference:route.credentialRef,env,signal});
 const credentials=selectControlledCredential(request.provider,config,{[route.credentialRef]:{type:'api_key',key}},request.providerConfigDigest);
 return {version:1,provider:request.provider,credentials};
}
