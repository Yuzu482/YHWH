// Host-observed Pi JSON stream timings. Missing events remain null, never zero.
export function createExecutionTimeline({now=Date.now,onProgress=()=>{}}={}) {
  const started=now();let ready=null,first=null,ended=null,closed=null,cleanup=null,buffer='',discard=false,firstSource=null;
  const state=()=>({startupMs:ready===null?null:ready-started,timeToFirstResponseMs:first===null?null:first-started,firstResponseSource:firstSource,generationMs:first===null||ended===null?null:ended-first,processMs:closed===null?null:closed-started,processTailMs:ended===null||closed===null?null:closed-ended,cleanupMs:cleanup});
  const publish=()=>onProgress(state());
  const event=value=>{
    const time=now();let changed=false;
    if(value.type==='agent_start'&&ready===null){ready=time;changed=true;}
    if(first===null&&((value.type==='message_update'&&['text_delta','thinking_delta'].includes(value.assistantMessageEvent?.type))||(value.type==='message_end'&&value.message?.role==='assistant'))){first=time;firstSource=value.type==='message_update'?'stream-delta':'completed-message';changed=true;}
    if(value.type==='agent_end'){ended=time;changed=true;}
    if(changed)publish();
  };
  return {
    feed(chunk){
      // Bound parser scratch space independently of the executor's output cap.
      for(const part of chunk.match(/[^\n]*\n|[^\n]+$/g)??[]){
        if(!discard)buffer+=part;
        if(buffer.length>1024*1024){buffer='';discard=true;}
        if(part.endsWith('\n')){if(!discard)try{event(JSON.parse(buffer));}catch{}buffer='';discard=false;}
      }
    },
    close(){closed=now();publish();},
    cleaned(ms){cleanup=ms;publish();},
    snapshot:state,
  };
}
