import {parentPort,workerData} from 'node:worker_threads';
import {assessLsp,acceptLsp,issueOneTimeLsp,consumeOneTimeLsp} from './lsp-approval-state.mjs';
try {
 const result=workerData.action==='assess'?assessLsp(workerData.input):workerData.action==='accept'?acceptLsp(workerData.input,workerData.challenge):workerData.action==='issueOneTime'?issueOneTimeLsp(workerData.input,workerData.challenge):workerData.action==='consumeOneTime'?consumeOneTimeLsp(workerData.input,workerData.challenge?.nonce):null;
 if(!result)throw Error('invalid_lsp_approval_action');
 parentPort.postMessage({ok:true,result});
} catch(error) {parentPort.postMessage({ok:false,error:error.message});}
