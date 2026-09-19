// SPDX-License-Identifier: Apache-2.0
// Semantic queries use multilspy; structural queries retain the explicit legacy backend.
import {readFileSync, closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
const structural = new Set(['code_overview','ast_search']);
const semantic = new Set(['lsp_diagnostics','lsp_hover','lsp_definition','lsp_references','lsp_symbols','lsp_completions','lsp_code_actions']);
const failure = reason => ({ok:false,status:'failed',reason,modelCalls:0,toolsUsed:[]});
let response;
try {
  closeSync(3);
  const raw=readFileSync(0);
  if(raw.length>65536) throw new Error('request-size-limit');
  const input=JSON.parse(raw);
  if(structural.has(input.tool)) {
    const {runStructural}=await import('./legacy-structural-bootstrap.mjs');
    response=await runStructural(input);
  } else if(semantic.has(input.tool)) {
    response=await new Promise(resolve=>{
      const child=spawn('/opt/pi-kether/multilspy-venv/bin/python',
        ['-I','/opt/pi-kether/scripts/multilspy-probe.py'],
        {stdio:['pipe','pipe','pipe'],windowsHide:true});
      const chunks=[];let bytes=0,oversized=false,settled=false;
      const done=value=>{if(!settled){settled=true;resolve(value);}};
      child.on('error',()=>done(failure('multilspy-runtime-unavailable')));
      child.stdin.on('error',()=>{});
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>2*1024*1024){oversized=true;child.kill('SIGKILL');return;}
        chunks.push(chunk);
      });
      child.stderr.on('data',()=>{});
      child.on('close',code=>{
        if(oversized)return done(failure('multilspy-output-size-limit'));
        try {
          const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if((code!==0&&result.ok===true)||result.engine!=='multilspy'||result.requestedTool!==input.tool)
            return done(failure('invalid-multilspy-result'));
          done(result);
        } catch {done(failure('invalid-multilspy-result'));}
      });
      child.stdin.end(raw);
    });
  } else response=failure('unsupported-lsp-operation');
} catch {response=failure('invalid-lsp-request');}
process.stdout.write(JSON.stringify(response),()=>process.exit(response.ok?0:1));
