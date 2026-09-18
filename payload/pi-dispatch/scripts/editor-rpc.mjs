// The worker's pipe identifies the grant. No token, URL or request-supplied authority is accepted.
export const EDITOR_FRAME='PI_EDITOR_RPC=';
export function createEditorRpc({broker,send,onOutput,onFailure,maxBytes=1048576}){
 let buffer='',closed=false,busy=false,count=0,total=0;const pending=new Set();
 function fail(){if(!closed){closed=true;onFailure('editor-rpc-invalid');}}
 function line(value){
  if(!value.startsWith(EDITOR_FRAME)){onOutput(value+'\n');return;}
  if(closed||busy||++count>32){fail();return;}
  let frame;try{frame=JSON.parse(value.slice(EDITOR_FRAME.length));}catch{fail();return;}
  if(Object.keys(frame).sort().join(',')!=='id,operationId'||!Number.isSafeInteger(frame.id)||frame.id!==count||typeof frame.operationId!=='string'||frame.operationId.length>64){fail();return;}
  busy=true;
  const work=Promise.resolve().then(()=>broker.invoke({operationId:frame.operationId})).catch(e=>({ok:false,code:e.code||'EDITOR_REJECTED'})).then(result=>{
   const response=JSON.stringify({id:frame.id,result})+'\n';total+=Buffer.byteLength(response);
   if(total>maxBytes){fail();return;}
   if(!closed)send(response);
  }).catch(()=>fail()).finally(()=>{busy=false;pending.delete(work);});pending.add(work);
 }
 return {feed(chunk){if(closed)return;buffer+=chunk;if(Buffer.byteLength(buffer)>maxBytes){fail();return;}let index;while((index=buffer.indexOf('\n'))>=0){const value=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);line(value);}},async close(){closed=true;if(buffer&&!buffer.startsWith(EDITOR_FRAME))onOutput(buffer);buffer='';await broker.close();await Promise.allSettled([...pending]);}};
}
