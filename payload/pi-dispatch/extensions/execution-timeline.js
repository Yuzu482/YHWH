// Host-observed Pi JSON stream timings. Missing events remain null, never zero.
export function createExecutionTimeline({now=Date.now,onProgress=()=>{}}={}) {
  const started=now();let ready=null,first=null,ended=null,closed=null,cleanup=null,buffer='',discard=false,firstSource=null;
  const stream={thinkingDeltas:0,textDeltas:0,toolStarts:0,toolEnds:0,toolErrors:0,firstTextMs:null,lastEventMs:null,lastEventType:null};
  const hasTextContent=message=>{
    const content=message?.content;
    return Array.isArray(content)
      ? content.some(part=>part?.type==='text'&&typeof part.text==='string'&&part.text.length>0)
      : typeof content==='string'&&content.length>0;
  };
  const state=()=>({startupMs:ready===null?null:ready-started,timeToFirstResponseMs:first===null?null:first-started,firstResponseSource:firstSource,generationMs:first===null||ended===null?null:ended-first,processMs:closed===null?null:closed-started,processTailMs:ended===null||closed===null?null:closed-ended,cleanupMs:cleanup,stream:{...stream}});
  const publish=()=>onProgress(state());
  const event=value=>{
    const deltaType=value.assistantMessageEvent?.type;
    const recognized=value.type==='agent_start'||value.type==='agent_end'||value.type==='tool_execution_start'||value.type==='tool_execution_end'||(value.type==='message_update'&&['text_delta','thinking_delta'].includes(deltaType))||(value.type==='message_end'&&value.message?.role==='assistant');
    if(!recognized)return;
    const time=now();
    stream.lastEventMs=time-started;
    stream.lastEventType=value.type;
    if(value.type==='agent_start'&&ready===null)ready=time;
    if(value.type==='message_update'){
      if(deltaType==='thinking_delta')stream.thinkingDeltas+=1;
      else {stream.textDeltas+=1;if(stream.firstTextMs===null)stream.firstTextMs=time-started;}
      if(first===null){first=time;firstSource='stream-delta';}
    }
    if(value.type==='message_end'){
      if(stream.firstTextMs===null&&hasTextContent(value.message))stream.firstTextMs=time-started;
      if(first===null){first=time;firstSource='completed-message';}
    }
    if(value.type==='agent_end')ended=time;
    if(value.type==='tool_execution_start')stream.toolStarts+=1;
    if(value.type==='tool_execution_end'){stream.toolEnds+=1;if(value.isError===true)stream.toolErrors+=1;}
    publish();
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
