import test from 'node:test';
import assert from 'node:assert/strict';
import { RESOURCE_PROFILES, GLOBAL_MAX_RUN_SECONDS, resolveResourceLimits, publicResourceProfiles } from '../extensions/resource-limits.js';
import { SCHEDULER_POLICY, ResourceAwareExecutor } from '../extensions/admission-scheduler.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const GIB=1024**3;

test('profile defaults remain fixed while explicit execution timeout uses the global 900-second ceiling',()=>{
 assert.equal(GLOBAL_MAX_RUN_SECONDS,900);
 assert.deepEqual(Object.fromEntries(Object.entries(RESOURCE_PROFILES).map(([name,p])=>[name,p.defaultRunSeconds])),{small:120,standard:300,large:900});
 for(const name of ['small','standard','large'])assert.equal(resolveResourceLimits(name,900).timeoutSeconds,900);
 assert.equal(resolveResourceLimits('small').timeoutSeconds,120);assert.equal(resolveResourceLimits('standard').timeoutSeconds,300);
 assert.equal(resolveResourceLimits('standard',999).timeoutSeconds,900);
 assert.equal(resolveResourceLimits('standard',600).memoryBytes,3*GIB);
 assert.equal(resolveResourceLimits('standard',600).cpuQuotaMicros,100000);
 assert.equal(resolveResourceLimits('small',600).memoryBytes,GIB);
 assert.equal(resolveResourceLimits('small',600).pidsMax,64);
 assert.equal(publicResourceProfiles().standard.defaultRunSeconds,300);
 assert.equal(publicResourceProfiles().standard.maxRunSeconds,900);
});

test('long standard runs do not increase total scheduler capacity',async()=>{
 const executor=new ResourceAwareExecutor(4,4,{availableMemoryBytes:()=>64*GIB,pollIntervalMs:5});
 let releaseA,releaseB;
 const a=executor.run(()=>new Promise(resolve=>{releaseA=resolve;}),600000,null,{provider:'openai-codex',memoryBytes:3*GIB,cpu:1});
 const b=executor.run(()=>new Promise(resolve=>{releaseB=resolve;}),600000,null,{provider:'anthropic',memoryBytes:3*GIB,cpu:1});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(executor.state.active,2);assert.equal(executor.state.activeMemoryMiB,6144);assert.equal(executor.state.activeCpu,2);
 releaseA();releaseB();await Promise.all([a,b]);
 assert.equal(SCHEDULER_POLICY.memoryCapacityBytes,6*GIB);assert.equal(SCHEDULER_POLICY.cpuCapacity,2);
});

test('wait transport and host allowlists expose only the bounded wait contract',()=>{
 const config=JSON.parse(readFileSync(resolve(root,'.mcp.json'),'utf8'));
 assert.ok(config.mcpServers['pi-kether-gateway'].enabled_tools.includes('wait_subagent'));
 const client=readFileSync(resolve(root,'scripts/gateway-client.mjs'),'utf8');
 assert.match(client,/command === 'wait' && args.length === 1/);
 assert.match(client,/timeout:60000,maxTotalTimeout:60000/);
 assert.match(client,/timeoutMs>55000/);
 const installer=readFileSync(resolve(root,'../../install/Install-PiKether.ps1'),'utf8');
 assert.match(installer,/wait_subagent/);
});

test('WSL execution guard agrees with the JavaScript global timeout ceiling and fixed resource values',()=>{
 const script=readFileSync(resolve(root,'sandbox/pi-kether-sandbox'),'utf8');
 assert.match(script,/small\) memory_bytes=1073741824; cpu_quota=50000; cpu_period=100000; pids_max=64; max_output_bytes=1048576; max_run_seconds=900/);
 assert.match(script,/standard\) memory_bytes=3221225472; cpu_quota=100000; cpu_period=100000; pids_max=128; max_output_bytes=4194304; max_run_seconds=900/);
 assert.match(script,/timeout_seconds >= 1 && timeout_seconds <= max_run_seconds/);
});
