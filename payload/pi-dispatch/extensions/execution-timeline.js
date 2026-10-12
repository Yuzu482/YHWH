import {createPiNormalizer} from '../scripts/worker-runtime/pi/normalize.mjs';
import {performance} from 'node:perf_hooks';
// Host-observed Pi JSON stream timings. Missing events remain null, never zero.
export function createExecutionTimeline({now=()=>performance.now(),onProgress=()=>{},normalizerFactory=createPiNormalizer}={}) {
  const started=now();let ready=null,first=null,ended=null,closed=null,cleanup=null,firstSource=null;const lifecycle=[];
  const active=new Map(),seen=new Set(),spans=[];
  let invalid=false,previous=started;
  const safeName=n=>typeof n==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(n)?n:'other';
  const union=intervals=>{let total=0,end=-Infinity;for(const [a,b] of intervals.sort((a,b)=>a[0]-b[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;};
  const toolState=()=>{
    const complete=!invalid && active.size===0 && stream.toolStarts===stream.toolEnds;
    const measured=complete && stream.toolStarts>0;
    const byName=Object.create(null);
    for(const span of spans){const name=Object.hasOwn(byName,span.name)||Object.keys(byName).length<31?span.name:'other';const v=byName[name]??={count:0,sumMs:0};v.count++;v.sumMs+=span.end-span.start;}
    const generationValid=measured && first!==null && ended!==null && ended>=first;
    const windowSpans=generationValid?spans.map(s=>[Math.max(first,s.start),Math.min(ended,s.end)]).filter(([a,b])=>b>=a):[];
    return {complete,observedStarts:stream.toolStarts,observedEnds:stream.toolEnds,retainedSpans:spans.length,
      sumMs:measured?spans.reduce((n,s)=>n+s.end-s.start,0):null,
      wallMs:measured?union(spans.map(s=>[s.start,s.end])):null,
      nonToolGenerationMs:generationValid?(ended-first)-union(windowSpans):null,
      byName:measured?byName:{}};
  };
  const stream={thinkingDeltas:0,textDeltas:0,toolStarts:0,toolEnds:0,toolErrors:0,firstTextMs:null,lastEventMs:null,lastEventType:null};
  const hasTextContent=message=>{
    const content=message?.content;
    return Array.isArray(content)
      ? content.some(part=>part?.type==='text'&&typeof part.text==='string'&&part.text.length>0)
      : typeof content==='string'&&content.length>0;
  };
  const state=()=>({startupMs:ready===null?null:ready-started,timeToFirstResponseMs:first===null?null:first-started,firstResponseSource:firstSource,generationMs:first===null||ended===null?null:ended-first,processMs:closed===null?null:closed-started,processTailMs:ended===null||closed===null?null:closed-ended,cleanupMs:cleanup,stream:{...stream},...(stream.toolStarts||stream.toolEnds?{toolTiming:toolState()}:{}),...(lifecycle.length?{lifecycle:lifecycle.map(v=>({...v}))}:{})});
  const publish=()=>onProgress(state());
  const event=value=>{
    const recognized=['start','end','text_delta','thinking_delta','tool_start','tool_end'].includes(value.type)||(value.type==='message_end'&&value.role==='assistant');
    if(!recognized)return;
    const time=now();
    if(!Number.isFinite(time)||time<previous)invalid=true;
    previous=time;
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
    if(value.type==='tool_start'||value.type==='tool_end'){
      const id=value.callId,name=safeName(value.name);
      if(typeof id!=='string'||!id||id.length>256)invalid=true;
      else if(value.type==='tool_start'){
        if(seen.has(id)||seen.size>=128)invalid=true;
        else {seen.add(id);active.set(id,{start:time,name});}
      }else{
        const start=active.get(id);
        if(!start||start.name!==name||time<start.start)invalid=true;
        else {active.delete(id);spans.push({...start,end:time});}
      }
    }
    publish();
  };
  const parser=normalizerFactory({onEvent:event,retainEvents:false,flushAtClose:false});
  return {
    feed(chunk){parser.feed(chunk);},
    event,
    lifecycle(value){if(lifecycle.length<32){lifecycle.push({...value});publish();}},
    close(){closed=now();if(!Number.isFinite(closed)||closed<previous)invalid=true;publish();},
    cleaned(ms){cleanup=ms;publish();},
    snapshot:state,
  };
}
