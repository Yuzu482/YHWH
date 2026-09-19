// SPDX-License-Identifier: Apache-2.0
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {selectAnthropicApiCredential} from './anthropic-api-credential.mjs';
import {API_PROVIDERS,readHostJson,selectControlledCredential} from './controlled-provider.mjs';
export function acceptApiPacket(provider,packet,config,digest) {
 const fail=()=>{throw new Error('PI_AUTH_INVALID');};
 if(!packet||packet.version!==1||packet.provider!==provider||Object.keys(packet).sort().join(',')!=='credentials,provider,version')fail();
 const credentials=packet.credentials;
 if(!credentials||Object.keys(credentials).length!==1)fail();
 if(provider==='anthropic')return selectAnthropicApiCredential({anthropic:{type:'api_key',key:credentials.anthropicApi?.apiKey}});
 if(!API_PROVIDERS.includes(provider)||credentials.controlledApi?.provider!==provider)fail();
 const ref=config?.routes?.[provider]?.credentialRef;
 const selected=selectControlledCredential(provider,config,{[ref]:{type:'api_key',key:credentials.controlledApi.apiKey}},digest);
 if(JSON.stringify(selected)!==JSON.stringify(credentials))fail();
 return selected;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try {
  const [provider,path,digest]=process.argv.slice(2);
  // Input is bounded by the launcher before this helper starts. No plaintext file.
  const input=readFileSync(0,'utf8');if(input.length>32768)throw new Error('PI_AUTH_INVALID');
  const config=API_PROVIDERS.includes(provider)?readHostJson(path):null;
  process.stdout.write(JSON.stringify(acceptApiPacket(provider,JSON.parse(input),config,digest)));
 } catch(error) {process.stderr.write(/^PI_(AUTH_INVALID|AUTH_MISSING|PROVIDER_CONFIG_CHANGED|PROVIDER_CONFIG_INVALID)$/.test(error.message)?error.message+'\n':'PI_AUTH_INVALID\n');process.exitCode=4;}
}
