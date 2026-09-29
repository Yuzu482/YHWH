import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import extension from '../pi-extensions/desktop-monitor/index.mjs';
import {launchSpec} from '../pi-extensions/desktop-monitor/launcher.mjs';
import {projectSnapshot,describePet} from '../pi-extensions/desktop-monitor/feed.mjs';
test('desktop extension registers a user command without tools or model dispatch',()=>{
 const commands=[];extension({registerCommand:(name,config)=>commands.push({name,config})});
 assert.deepEqual(commands.map(c=>c.name),['pi-monitor','pi-pet']);
});
test('pet states distinguish current work, historical failures and disconnection',()=>{
 const base={ok:true,active:0,queued:0,tasks:[]};
 assert.equal(describePet(base).state,'idle');
 assert.equal(describePet({...base,queued:2}).state,'waiting');
 const failed={...base,tasks:[{state:'failed'}]};
 assert.equal(describePet(failed).label,'近期有失败');
 assert.equal(describePet({...failed,active:1}).state,'running');
 assert.match(describePet({...failed,active:1}).detail,/近期失败/);
 assert.equal(describePet({...base,ok:false}).count,'?');
 const spec=launchSpec({mode:'pet'});
 assert.equal(spec.args[spec.args.indexOf('-Mode')+1],'pet');
 assert.throws(()=>launchSpec({mode:'invalid'}),/Invalid/);
});
test('pet state makes host verification distinct from failed and idle work',()=>{
 const base={ok:true,active:0,queued:0,tasks:[{state:'awaiting-host-verification'}]};
 const pending=describePet(base);assert.equal(pending.state,'host-verification');assert.equal(pending.label,'待主机验收 1');
 const active=describePet({...base,active:1});
 assert.equal(active.state,'running');assert.match(active.detail,/待主机验收 1/);
});
test('embedded gateway monitor labels host verification separately from failure',()=>{
 const html=readFileSync(new URL('../assets/subagent-monitor.html',import.meta.url),'utf8');
 assert.match(html,/awaiting-host-verification/);assert.match(html,/待主机验收/);
});
test('desktop launch uses a hidden direct process and no shell wrapper',()=>{
 const spec=launchSpec({configPath:process.cwd(),readyFile:'ready.json'});
 assert.equal(spec.options.shell,false);assert.equal(spec.options.windowsHide,true);assert.equal(spec.options.detached,false);
 assert.ok(spec.args.includes('-STA'));assert.ok(spec.args.includes('-Background'));assert.ok(!spec.args.includes('-Command'));
});
test('monitor projection excludes task prompts, outcomes and arbitrary fields',()=>{
 const data=projectSnapshot({ok:true,gateway:{instanceId:'fixture',active:1,queued:0},tasks:[{requestId:'x',role:'Malkuth',displayName:'Kingdom',displayNameZh:'王国',state:'running',requestedProvider:'openai-codex',requestedModel:'fixture',elapsedMs:2200,prompt:'secret',outcome:{sensitive:'value'},accessToken:'token'}]});
 assert.equal(data.tasks[0].seconds,2);assert.equal(data.tasks[0].role,'Malkuth');assert.equal(data.tasks[0].displayName,'Kingdom');assert.equal(data.tasks[0].displayNameZh,'王国');assert.ok(!JSON.stringify(data).includes('secret'));assert.ok(!JSON.stringify(data).includes('token'));assert.ok(!JSON.stringify(data).includes('outcome'));
 assert.throws(()=>projectSnapshot({ok:false}),/Invalid/);
});
