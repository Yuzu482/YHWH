#!/usr/bin/env node
import {readFileSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {parseArgs} from 'node:util';
const names=['ledger-root','workspace','authorization-file','snapshot-file','operator-evidence-file'];
let args;
try{
 const parsed=parseArgs({options:Object.fromEntries(names.map(k=>[k,{type:'string'}])),allowPositionals:false,strict:true,tokens:true});
 if(names.some(k=>!parsed.values[k]||!isAbsolute(parsed.values[k]))||parsed.tokens.some((t,i,a)=>t.kind==='option'&&a.findIndex(x=>x.kind==='option'&&x.name===t.name)!==i))throw Error('required named arguments must be unique absolute paths');
 args=parsed.values;
}catch(error){process.stderr.write('Usage: card-lab-interrupted-request-recovery --ledger-root ABS --workspace ABS --authorization-file ABS --snapshot-file ABS --operator-evidence-file ABS\ninvalid arguments: '+error.message+'\n');process.exitCode=2;}
if(args)try{
 if(!statSync(args['ledger-root']).isDirectory()||!statSync(join(args['ledger-root'],'milestones')).isDirectory()||!statSync(args.workspace).isDirectory())throw Error('existing request ledger and workspace directories required');
 for(const k of ['authorization-file','snapshot-file','operator-evidence-file'])readFileSync(args[k]);
 const {createMilestoneLedger}=await import('../extensions/milestone-ledger.js');
 const ledger=createMilestoneLedger(join(args['ledger-root'],'milestones'));
 const result=ledger.authorizeInterruptedRecovery({workspace:args.workspace,authorizationFile:args['authorization-file'],snapshotFile:args['snapshot-file'],operatorEvidenceFile:args['operator-evidence-file']});
 process.stdout.write(JSON.stringify({ok:true,requestId:result.requestId,executionUnknown:true})+'\n');
}catch(error){process.stderr.write((error.code??'PI_MILESTONE_RECOVERY_FAILED')+': '+error.message+'\n');process.exitCode=1;}
