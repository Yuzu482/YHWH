import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createGatewayApp} from '../scripts/gateway.mjs';
import {listenHttpFixture} from './http-fixture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const clientPath=join(root,'scripts','gateway-client.mjs');
function runCli(env,args){return new Promise((resolvePromise,reject)=>{const child=spawn(process.execPath,[clientPath,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',(code)=>resolvePromise({code,stdout,stderr}));});}

test('gateway-client handoff uses authenticated local MCP read API and rejects invalid fields',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gateway-client-handoff-'));const token='gateway-client-synthetic-token-0123456789';
  const tokenFile=join(directory,'token');writeFileSync(tokenFile,token);const configFile=join(directory,'gateway.json');
  const {app,runtime}=createGatewayApp({host:'127.0.0.1',port:0,roots:[root],token,requestLedgerDir:join(directory,'ledger'),sandboxStatus:{ok:true,backend:'wsl2-bwrap',resourceLimits:true},dispatchFn:async()=>{throw new Error('read API must not dispatch');}});
  const http=await listenHttpFixture(app);
  try{
    writeFileSync(configFile,JSON.stringify({host:'127.0.0.1',port:http.address().port,tokenFile}));const requestFile=join(directory,'request.json');
    writeFileSync(requestFile,JSON.stringify({requestId:'unknown-candidate'}));
    const valid=await runCli({PI_GATEWAY_CONFIG:configFile},['handoff',requestFile]);assert.equal(valid.code,0,valid.stderr);assert.match(valid.stdout,/"state": "unknown"/);
    const apply=await runCli({PI_GATEWAY_CONFIG:configFile},['apply-artifact','unknown-candidate']);assert.equal(apply.code,1);assert.equal(JSON.parse(apply.stdout).code,'artifact_not_pending');
    const invalidApply=await runCli({PI_GATEWAY_CONFIG:configFile},['apply-artifact','../invalid']);assert.equal(invalidApply.code,1);assert.match(invalidApply.stderr,/Invalid requestId/);
    writeFileSync(requestFile,JSON.stringify({requestId:'unknown-candidate',shell:'false'}));const invalid=await runCli({PI_GATEWAY_CONFIG:configFile},['handoff',requestFile]);assert.equal(invalid.code,1);assert.match(invalid.stderr,/handoff request is invalid/);
  }finally{await new Promise(resolvePromise=>http.close(resolvePromise));await runtime.shutdown?.();rmSync(directory,{recursive:true,force:true});}
});
