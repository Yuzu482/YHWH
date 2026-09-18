// Explicitly loaded only for a host-authorized task; no network, filesystem or credentials.
export default function editorProxy(pi){
 let sequence=0,tail=Promise.resolve(),pending=0;
 // Print-mode workers perform one turn. Release IPC's process lifetime reference at its end.
 pi.on?.('agent_end',()=>{if(pending===0&&process.connected&&typeof process.disconnect==='function')process.disconnect();});
 pi.registerTool({name:'pi_editor_execute',label:'Authorized editor operation',description:'Execute one exact operationId from Tifereth EDITOR_AUTHORIZATION_JSON. Arguments, editor and scene are fixed by the host. Real host effects are not sandbox rollback protected.',parameters:{type:'object',properties:{operationId:{type:'string',maxLength:64}},required:['operationId'],additionalProperties:false},async execute(_id,args,signal){
  if(pending>=16)throw new Error('EDITOR_QUEUE_LIMIT');
  pending++;
  const run=async()=>{
  if(typeof process.send!=='function'||!process.connected)throw new Error('EDITOR_CHANNEL_UNAVAILABLE');
  if(signal?.aborted)throw new Error('EDITOR_CANCELLED');
  const id=++sequence;
  const result=await new Promise((resolve,reject)=>{
   let timer;const clean=()=>{clearTimeout(timer);process.off('message',reply);process.off('disconnect',disconnected);signal?.removeEventListener('abort',abort);};
   const fail=code=>{clean();reject(new Error(code));};
   const reply=m=>{if(m?.id===id){clean();resolve(m.result);}};
   const disconnected=()=>fail('EDITOR_CHANNEL_CLOSED');const abort=()=>fail('EDITOR_CANCELLED_RESULT_UNCERTAIN');
   process.on('message',reply);process.once('disconnect',disconnected);signal?.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>fail('EDITOR_TIMEOUT_RESULT_UNCERTAIN'),40000);
   process.send({id,operationId:args.operationId},e=>{if(e)fail('EDITOR_CHANNEL_CLOSED');});
  });
  return {content:[{type:'text',text:JSON.stringify(result)}],details:result,isError:result.ok!==true};
  };
  const work=tail.then(run);tail=work.catch(()=>{});
  try{return await work;}finally{pending--;}
 }});
}
