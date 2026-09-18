import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('../assets/subagent-monitor.html',import.meta.url),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const snapshot={ok:true,parentRunId:null,gateway:{instanceId:'fixture-instance',accepting:true,active:0,queued:0,maxConcurrency:4,activeMemoryMiB:0,gatewayRssMiB:50},tasks:[]};
function mount({openai,callTool=async()=>({structuredContent:snapshot}),height=260}={}){
 const elements=new Map(),listeners=new Map(),messages=[],parent={postMessage(message){messages.push(message);}};
 const el=id=>{if(!elements.has(id))elements.set(id,{hidden:id==='error',textContent:'',innerHTML:'',disabled:false,scrollHeight:height,getBoundingClientRect(){return {height:this.scrollHeight};},addEventListener(){}});return elements.get(id);};
 const window={parent,openai:openai===false?undefined:{callTool,toolInput:{limit:10},toolOutput:snapshot,...openai},addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
 const ctx=vm.createContext({window,document:{hidden:false,getElementById:el,addEventListener(){}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}});
 vm.runInContext(script,ctx);
 return {el,messages,run:code=>vm.runInContext(code,ctx),globals(value){for(const fn of [...(listeners.get('openai:set_globals')||[])])fn({detail:{globals:value}});},emit(data,source=parent){for(const fn of [...(listeners.get('message')||[])])fn({data,source});}};
}
test('global monitor refresh omits null parent and preserves requested limit',async()=>{
 let args;const ui=mount({callTool:async(_name,value)=>{args=value;return {structuredContent:snapshot};}});
 await ui.run('refresh()');assert.equal('parentRunId' in args,false);assert.equal(args.limit,10);assert.equal(ui.el('active').textContent,'0/4');assert.equal(ui.el('error').hidden,true);
});
test('MCP tool errors remain visible instead of claiming successful refresh',async()=>{
 const ui=mount({callTool:async()=>({isError:true,content:[{type:'text',text:'fixture validation failure'}]})});
 await ui.run('refresh()');assert.equal(ui.el('error').hidden,false);assert.match(ui.el('error').textContent,/validation/);assert.match(ui.el('status').textContent,/失败/);
});
test('failed cancellation is not swallowed or followed by an apparent successful refresh',async()=>{
 let calls=0;const ui=mount({callTool:async()=>{calls++;return {structuredContent:{ok:false,error:'fixture cancellation denied'},isError:true};}});
 await ui.run("cancel('fixture', {disabled:false})");assert.equal(calls,1);assert.equal(ui.el('error').hidden,false);assert.match(ui.el('error').textContent,/denied/);
});
test('standard MCP App initializes and consumes tool notifications without window.openai',async()=>{
 const ui=mount({openai:false});const init=ui.messages[0];assert.equal(init.method,'ui/initialize');
 ui.emit({jsonrpc:'2.0',id:init.id,result:{protocolVersion:'2026-01-26'}});await Promise.resolve();await Promise.resolve();
 assert.ok(ui.messages.some(message=>message.method==='ui/notifications/initialized'));
 assert.equal(ui.messages.find(message=>message.method==='ui/notifications/size-changed').params.height,260);
 ui.emit({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{parentRunId:'fixture-run',limit:7}}});
 ui.emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{...snapshot,parentRunId:'fixture-run'}}});
 assert.equal(ui.el('active').textContent,'0/4');
 const pending=ui.run('refresh()');const call=ui.messages.at(-1);assert.equal(call.params.arguments.parentRunId,'fixture-run');assert.equal(call.params.arguments.limit,7);
 ui.emit({jsonrpc:'2.0',id:call.id,result:{structuredContent:snapshot}});await pending;
});
test('OpenAI host receives initial height and both growing and shrinking content sizes',()=>{
 const heights=[];const ui=mount({openai:{notifyIntrinsicHeight:height=>heights.push(height)}});
 assert.equal(heights[0],260);
 ui.el('monitor').scrollHeight=640;ui.run('reportHeight()');
 ui.el('monitor').scrollHeight=280;ui.run('reportHeight()');
 ui.run('reportHeight()');
 assert.deepEqual(heights.slice(-2),[640,280]);
});
test('height notification failures do not prevent monitor data from rendering',()=>{
 const ui=mount({openai:{notifyIntrinsicHeight(){throw new Error('fixture host error');}}});
 assert.equal(ui.el('active').textContent,'0/4');
});
test('MCP App handshake is required even when the legacy OpenAI bridge is present',async()=>{
 const ui=mount();
 const init=ui.messages.find(message=>message.method==='ui/initialize');
 assert.ok(init,'Legacy callTool must not bypass MCP App initialization');
 assert.deepEqual(Array.from(init.params.appCapabilities.availableDisplayModes),['inline','pip','fullscreen']);
 ui.emit({jsonrpc:'2.0',id:init.id,result:{protocolVersion:'2026-01-26'}});
 await Promise.resolve();await Promise.resolve();
 assert.ok(ui.messages.some(message=>message.method==='ui/notifications/initialized'));
 assert.ok(ui.messages.some(message=>message.method==='ui/notifications/size-changed'));
});
test('host size feedback does not cause repeated intrinsic-height notifications',()=>{
 const heights=[];const ui=mount({openai:{notifyIntrinsicHeight:height=>heights.push(height)}});
 const before=heights.length;
 for(let i=0;i<20;i++)ui.globals({maxHeight:260});
 assert.equal(heights.length,before);
});
test('floating button requests PiP then returns inline only after host confirmation',async()=>{
 const requested=[];
 const ui=mount({openai:{requestDisplayMode:async({mode})=>{requested.push(mode);return {mode};}}});
 await ui.run('toggleFloating()');assert.equal(ui.el('floating').textContent,'返回对话');
 await ui.run('toggleFloating()');assert.equal(ui.el('floating').textContent,'悬浮');
 assert.deepEqual(requested,['pip','inline']);
});
test('rejected floating request remains inline and exposes the host error',async()=>{
 const ui=mount({openai:{requestDisplayMode:async()=>{throw new Error('PiP unavailable');}}});
 await ui.run('toggleFloating()');assert.equal(ui.el('floating').textContent,'悬浮');
 assert.match(ui.el('error').textContent,/PiP unavailable/);assert.equal(ui.el('floating').disabled,false);
});
test('standard bridge requests floating mode and follows host context changes',async()=>{
 const ui=mount({openai:false});const init=ui.messages[0];
 ui.emit({jsonrpc:'2.0',id:init.id,result:{protocolVersion:'2026-01-26'}});await Promise.resolve();await Promise.resolve();
 const pending=ui.run('toggleFloating()');const request=ui.messages.at(-1);
 assert.equal(request.method,'ui/request-display-mode');assert.equal(request.params.mode,'pip');
 ui.emit({jsonrpc:'2.0',id:request.id,result:{mode:'pip'}});await pending;
 assert.equal(ui.el('floating').textContent,'返回对话');
 ui.emit({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:'inline'}});
 assert.equal(ui.el('floating').textContent,'悬浮');
});
test('foreign frames cannot inject monitor data or satisfy RPC responses',()=>{
 const ui=mount({openai:false});ui.emit({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:snapshot}},{});
 assert.equal(ui.el('active').textContent,'');
});
