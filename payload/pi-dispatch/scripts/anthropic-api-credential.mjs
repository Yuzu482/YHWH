// SPDX-License-Identifier: Apache-2.0
// Pure validation: accepts literal API keys, never OAuth tokens or commands.
export function selectAnthropicApiCredential(data) {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const credential=data?.anthropic;
  if(!credential)fail('PI_AUTH_MISSING');
  if(credential.type!=='api_key'||typeof credential.key!=='string'||!/^sk-ant-api[0-9]+-[A-Za-z0-9_-]{16,}$/.test(credential.key))fail('PI_AUTH_INVALID');
  return {anthropicApi:{apiKey:credential.key}};
}
export function anthropicBootstrapAuth(data,args) {
  const fail=()=>{throw new Error('PI_AUTH_INVALID');};
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||!data.anthropicApi)fail();
  const value=flag=>{if(args.filter(a=>a===flag).length!==1)fail();return args[args.indexOf(flag)+1];};
  if(value('--provider')!=='anthropic'||value('--model')!=='claude-sonnet-5'||!args.includes('--no-tools')||args.some(a=>a==='--tools'||a.startsWith('--tools=')||a==='--api-key'||a.startsWith('--api-key=')))fail();
  selectAnthropicApiCredential({anthropic:{type:'api_key',key:data.anthropicApi.apiKey}});
  return {anthropic:{type:'api_key',key:data.anthropicApi.apiKey}};
}
