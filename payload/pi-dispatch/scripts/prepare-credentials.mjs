import {selectAnthropicApiCredential} from './anthropic-api-credential.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function selectCredential(provider,data,now=Date.now()) {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(provider==='anthropic') return selectAnthropicApiCredential(data);
  if(provider!=='openai-codex')fail('PI_AUTH_INVALID');
  const credential=data?.['openai-codex'];
  if(!credential)fail('PI_AUTH_MISSING');
  if(credential.type!=='oauth'||typeof credential.access!=='string'||!credential.access.trim()||!Number.isFinite(credential.expires))fail('PI_AUTH_INVALID');
  if(credential.expires<=now+300000)fail('PI_AUTH_EXPIRED');
  return {openaiAccess:{accessToken:credential.access,expiresAt:credential.expires}};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const [, ,provider,source,destination,digest]=process.argv;
    if(provider!=='openai-codex')throw Object.assign(new Error('encrypted pipe required'),{code:'PI_AUTH_ENCRYPTED_PIPE_REQUIRED'});
    let data;
    try{data=JSON.parse(readFileSync(source,'utf8'));}
    catch(error){throw Object.assign(new Error('credential unavailable'),{code:error.code==='ENOENT'?'PI_AUTH_MISSING':'PI_AUTH_INVALID'});}
    const selected=selectCredential(provider,data);
    writeFileSync(destination,JSON.stringify(selected),{mode:0o600});
  }catch(error){
    // Never print raw exceptions or credential contents from this root helper.
    process.stderr.write(['PI_AUTH_ENCRYPTED_PIPE_REQUIRED','PI_AUTH_MISSING','PI_AUTH_INVALID','PI_AUTH_EXPIRED','PI_AUTH_INELIGIBLE','PI_PROVIDER_CONFIG_CHANGED','PI_PROVIDER_CONFIG_INVALID','PI_PROVIDER_NOT_CONFIGURED'].includes(error.code)?error.code+'\n':'PI_CREDENTIAL_PREPARE_FAILED\n');
    process.exitCode=4;
  }
}
