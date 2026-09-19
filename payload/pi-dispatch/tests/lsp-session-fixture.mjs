// Synthetic transport fixture only; real server coverage lives in Test-PiLspAdapter.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
const [snapshot,file,mode='normal']=process.argv.slice(2);
let count=0;
for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);
  if(r.close){console.log(JSON.stringify({sessionClosed:true,serverCleanup:{ok:mode!=='bad-cleanup'}}));break;}
  if(mode==='hang')continue;
  if(mode==='malformed'){console.log('not-json');continue;}
  if(mode==='delay')await new Promise(resolve=>setTimeout(resolve,250));
  const digest=createHash('sha256').update(fs.readFileSync(path.join(snapshot,file))).digest('hex');
  console.log(JSON.stringify({ok:true,status:'success',engine:'multilspy',backend:'lsp',modelCalls:0,
    requestedTool:r.tool,diagnosticsPublished:true,diagnosticCompletion:{complete:mode!=='incomplete-diagnostics'},result:{value:count},
    serverCleanup:{ok:null,state:'retained-until-session-close'},
    serverSession:{documentSha256:mode==='wrong-hash'?'0'.repeat(64):digest,documentVersion:1,reused:count++>0}}));
}
