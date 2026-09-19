// FD 3 is opened by the root launcher outside the sandbox filesystem.
import { readFileSync, closeSync } from 'node:fs';
import { controlledBootstrap } from './controlled-provider.mjs';
import { installTransportFence } from './provider-transport.mjs';
import { anthropicBootstrapAuth } from './anthropic-api-credential.mjs';
const data=JSON.parse(readFileSync(3,'utf8'));
closeSync(3);
if(Object.keys(data).length!==1)throw new Error('PI_AUTH_INVALID');
let credentials;
if(data.controlledApi) {
  const args=process.argv.slice(2);
  const selected=controlledBootstrap(data,args);
  process.argv.splice(2,process.argv.length-2,...args);
  credentials=selected.credentials;
  globalThis[Symbol.for('yhwh.controlledProvider')]={provider:selected.packet.provider,route:selected.packet.route};
  installTransportFence(selected.packet);
}
else if(data.anthropicApi) credentials=anthropicBootstrapAuth(data,process.argv.slice(2));
else {
 if(typeof data.openaiAccess?.accessToken!=='string'||!data.openaiAccess.accessToken||!Number.isFinite(data.openaiAccess.expiresAt)||data.openaiAccess.expiresAt<=Date.now()+300000)throw new Error('PI_AUTH_EXPIRED');
 credentials={'openai-codex':{type:'oauth',access:data.openaiAccess.accessToken,expires:data.openaiAccess.expiresAt,refresh:''}};
}
const {AuthStorage}=await import('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js');
const store=AuthStorage.inMemory(credentials);
// Credentials remain in memory; no key environment, CLI argument or persistent sandbox file.
store.modify=async()=>{throw new Error('PI_AUTH_RENEW_HOST_REQUIRED');};
store.delete=async()=>{throw new Error('PI_AUTH_RENEW_HOST_REQUIRED');};
AuthStorage.create=()=>store;
delete process.env.PI_SANDBOX_AUTH_PATH;
await import('/opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
