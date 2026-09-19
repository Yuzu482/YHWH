// SPDX-License-Identifier: Apache-2.0
// Pass the pinned Pi node_modules directory. Fake credentials and mocked fetch only.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {registrationConfig} from '../payload/pi-dispatch/scripts/controlled-provider.mjs';
const modules=resolve(process.argv[2]);
const pkg=JSON.parse(readFileSync(join(modules,'@earendil-works/pi-coding-agent/package.json'),'utf8'));
assert.equal(pkg.version,'0.84.4');
const core=name=>pathToFileURL(join(modules,'@earendil-works/pi-coding-agent/dist/core',name)).href;
const {AuthStorage}=await import(core('auth-storage.js'));
const {ModelRuntime}=await import(core('model-runtime.js'));
const config=JSON.parse(readFileSync(new URL('../templates/provider-config.example.json',import.meta.url)));
const key='sdk_fixture_'+'x'.repeat(30);
const store=AuthStorage.inMemory(Object.fromEntries(Object.keys(config.routes).map(p=>[p,{type:'api_key',key}])));
const runtime=await ModelRuntime.create({credentials:store,modelsPath:null,allowModelNetwork:false});
let requests=[];
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);
 requests.push({url:request.url,headers:request.headers,body:JSON.parse(await request.text())});
 return new Response(JSON.stringify({error:{type:'invalid_request_error',message:'offline test response'}}),{status:400,headers:{'content-type':'application/json'}});
};
for(const [provider,route] of Object.entries(config.routes)){
 runtime.registerProvider(provider,registrationConfig(route));
 await runtime.refresh({allowNetwork:false});
 const model=runtime.getModel(provider,route.model);assert.ok(model);assert.ok(runtime.hasConfiguredAuth(provider));
 const auth=await runtime.getAuth(model);assert.equal(auth.auth.apiKey,key);
 const context={messages:[{role:'user',content:'Offline fixture',timestamp:0}],tools:[]};
 requests=[];
 const result=await runtime.streamSimple(model,context,{reasoning:'max',apiKey:key,headers:auth.auth.headers}).result();
 assert.equal(result.stopReason,'error');assert.equal(requests.length,1,result.errorMessage);
 const captured=requests[0];
 assert.equal(captured.url,route.baseUrl+(route.protocol==='anthropic-messages'?'/v1/messages':'/responses'));
 assert.equal(captured.headers.get('authorization'),'Bearer '+key);
 assert.equal(captured.body.model,route.model);
 assert.equal(route.protocol==='anthropic-messages'?captured.body.output_config.effort:captured.body.reasoning.effort,'max');
 console.log(JSON.stringify({provider,endpoint:captured.url,maxTransmitted:true,auth:'fixture bearer',modelCalls:0,network:false}));
}
