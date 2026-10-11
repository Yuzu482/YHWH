// Loaded only by a trusted host-admitted Chesed WSL launch.
export default function runCheckProxy(pi) {
  let sequence=0,pending=0;
  pi.on?.('agent_end',()=>{if(!pending&&process.connected)process.disconnect?.();});
  pi.registerTool({
    name:'yhwh_run_check',label:'Sandbox check',
    description:'Run one pre-authorized verify.commands commandId in a fresh credential-free no-network sandbox. This is sandboxEvidence only; host verification is still required.',
    parameters:{type:'object',properties:{commandId:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'}},required:['commandId'],additionalProperties:false},
    async execute(_id,args,signal){
      if(!args||Object.keys(args).join(',')!=='commandId'||!/^[a-z][a-z0-9-]{0,63}$/.test(args.commandId))throw Error('CHECK_ARGUMENTS');
      if(pending||sequence>=8)throw Error('CHECK_CALL_LIMIT');
      if(typeof process.send!=='function'||!process.connected)throw Error('CHECK_CHANNEL_UNAVAILABLE');
      if(signal?.aborted)throw Error('CHECK_CANCELLED');
      const checkId=++sequence;pending=1;
      try {
        const result=await new Promise((resolve,reject)=>{
          let timer;
          const clean=()=>{clearTimeout(timer);process.off('message',reply);process.off('disconnect',disconnect);signal?.removeEventListener('abort',abort);};
          const fail=reason=>{clean();reject(Error(reason));};
          const reply=m=>{if(m?.checkId===checkId){if(Object.keys(m).sort().join(',')!=='checkId,result')return fail('CHECK_REPLY');clean();resolve(m.result);}};
          const disconnect=()=>fail('CHECK_CHANNEL_CLOSED');
          const abort=()=>{process.send?.({checkCancel:checkId},()=>{});fail('CHECK_CANCELLED_RESULT_UNCERTAIN');};
          process.on('message',reply);process.once('disconnect',disconnect);signal?.addEventListener('abort',abort,{once:true});
          timer=setTimeout(abort,130000);
          process.send({checkId,commandId:args.commandId},e=>{if(e)fail('CHECK_CHANNEL_CLOSED');});
          if(signal?.aborted)abort();
        });
        return {content:[{type:'text',text:JSON.stringify(result)}],details:{evidenceKind:'sandboxEvidence',commandId:args.commandId},isError:result?.ok!==true};
      }finally{pending=0;}
    },
  });
}

