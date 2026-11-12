import {Worker} from 'node:worker_threads';

export function createLspApprovalRunner({roots,stateDir,maxPending=16,timeoutMs=45000}) {
 let tail=Promise.resolve(),pending=0;
 const execute=(action,args,signal)=>{
   if(pending>=maxPending)return Promise.reject(Error('lsp_confirmation_queue_full'));
   pending++;
   const run=tail.then(()=>new Promise((resolve,reject)=>{
     if(signal?.aborted){reject(Error('lsp_confirmation_cancelled'));return}
     const worker=new Worker(new URL('./lsp-approval-worker.mjs',import.meta.url),{workerData:{action,input:{...args.input,roots,stateDir},challenge:args.challenge},resourceLimits:{maxOldGenerationSizeMb:256}});
     let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);void worker.terminate();error?reject(error):resolve(value)};
     const timer=setTimeout(()=>finish(Error('lsp_confirmation_timeout')),timeoutMs);
     const aborted=()=>finish(Error('lsp_confirmation_cancelled'));signal?.addEventListener('abort',aborted,{once:true});
     worker.once('message',m=>m?.ok?finish(null,m.result):finish(Error(m?.error??'lsp_confirmation_worker_failed')));
     worker.once('error',error=>finish(error));worker.once('exit',code=>{if(code!==0)finish(Error('lsp_confirmation_worker_failed'))});
   }));
   tail=run.catch(()=>{});return run.finally(()=>{pending--});
 };
 return {assess:(input,signal)=>execute('assess',{input},signal),accept:(input,challenge,signal)=>execute('accept',{input,challenge},signal),issueOneTime:(input,challenge,signal)=>execute('issueOneTime',{input,challenge},signal),consumeOneTime:(input,challenge,signal)=>execute('consumeOneTime',{input,challenge},signal)};
}
