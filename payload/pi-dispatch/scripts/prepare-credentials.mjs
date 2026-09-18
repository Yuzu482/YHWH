import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function selectCredential(provider,data,now=Date.now()) {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  if(provider==='pi-claude-code-provider') {
    const credential=data?.claudeAiOauth;
    if(typeof credential?.accessToken!=='string'||!credential.accessToken.trim())fail('PI_AUTH_MISSING');
    if(!Number.isFinite(credential.expiresAt))fail('PI_AUTH_INVALID');
    if(credential.expiresAt<=now)fail('PI_AUTH_EXPIRED');
    if(!['pro','max','team','enterprise'].includes(credential.subscriptionType))fail('PI_AUTH_INELIGIBLE');
    return {claudeReview:{accessToken:credential.accessToken,subscriptionType:credential.subscriptionType}};
  }
  if(provider!=='openai-codex')fail('PI_AUTH_INVALID');
  const credential=data?.['openai-codex'];
  if(!credential)fail('PI_AUTH_MISSING');
  if(credential.type!=='oauth'||typeof credential.access!=='string'||!credential.access.trim()||!Number.isFinite(credential.expires))fail('PI_AUTH_INVALID');
  if(credential.expires<=now+300000)fail('PI_AUTH_EXPIRED');
  return {openaiAccess:{accessToken:credential.access,expiresAt:credential.expires}};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const [, ,provider,source,destination]=process.argv;
    let data;
    try{data=JSON.parse(readFileSync(source,'utf8'));}
    catch(error){throw Object.assign(new Error('credential unavailable'),{code:error.code==='ENOENT'?'PI_AUTH_MISSING':'PI_AUTH_INVALID'});}
    writeFileSync(destination,JSON.stringify(selectCredential(provider,data)),{mode:0o600});
  }catch(error){
    // Never print raw exceptions or credential contents from this root helper.
    process.stderr.write(['PI_AUTH_MISSING','PI_AUTH_INVALID','PI_AUTH_EXPIRED','PI_AUTH_INELIGIBLE'].includes(error.code)?error.code+'\n':'PI_CREDENTIAL_PREPARE_FAILED\n');
    process.exitCode=4;
  }
}
