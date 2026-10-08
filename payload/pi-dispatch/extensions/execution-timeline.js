import {createPiNormalizer} from '../scripts/worker-runtime/pi/normalize.mjs';
// Host-observed Pi JSON stream timings. Missing events remain null, never zero.
export function createExecutionTimeline({now=Date.now,onProgress=()=>{},normalizerFactory=createPiNormalizer}={}) {
  const started=now();let ready=null,first=null,ended=null,closed=null,cleanup=null,firstSource=null;
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
    const recognized=['start','end','text_delta','thinking_delta','tool_start','tool_end'].includes(value.type)||(value.type==='message_end'&&value.role==='assistant');
    if(!recognized)return;
    const time=now();
    stream.lastEventMs=time-started;
    stream.lastEventType=value.sourceType??value.type;
    if(value.type==='start'&&ready===null)ready=time;
    if(['text_delta','thinking_delta'].includes(value.type)){
      if(value.type==='thinking_delta')stream.thinkingDeltas+=1;
      else {stream.textDeltas+=1;if(stream.firstTextMs===null)stream.firstTextMs=time-started;}
      if(first===null){first=time;firstSource='stream-delta';}
    }
    if(value.type==='message_end'){
      if(stream.firstTextMs===null&&hasTextContent(value))stream.firstTextMs=time-started;
      if(first===null){first=time;firstSource='completed-message';}
    }
    if(value.type==='end')ended=time;
    if(value.type==='tool_start')stream.toolStarts+=1;
    if(value.type==='tool_end'){stream.toolEnds+=1;if(value.isError===true)stream.toolErrors+=1;}
    publish();
  };
  const parser=normalizerFactory({onEvent:event,retainEvents:false,flushAtClose:false});
  return {
    feed(chunk){parser.feed(chunk);},
    event,
    close(){closed=now();publish();},
    cleaned(ms){cleanup=ms;publish();},
    snapshot:state,
  };
}
