import test from 'node:test';
import assert from 'node:assert/strict';
import editorProxy from '../extensions/editor-proxy.js';
test('parallel model calls serialize over IPC and remove listeners',async()=>{
 const originalSend=process.send,originalConnected=process.connected;const sent=[];let active=0,max=0,tool;
 process.connected=true;
 process.send=(request,callback)=>{active++;max=Math.max(max,active);sent.push(request);callback?.();setTimeout(()=>{active--;process.emit('message',{id:request.id,result:{ok:true}});},5);};
 const before=process.listenerCount('message');
 try{
  editorProxy({registerTool:t=>{tool=t;}});
  const results=await Promise.all(['one','two','three'].map(operationId=>tool.execute('',{operationId})));
  assert.ok(results.every(r=>r.details.ok));assert.equal(max,1);assert.deepEqual(sent.map(r=>r.id),[1,2,3]);assert.equal(process.listenerCount('message'),before);
 }finally{if(originalSend===undefined)delete process.send;else process.send=originalSend;if(originalConnected===undefined)delete process.connected;else process.connected=originalConnected;}
});
