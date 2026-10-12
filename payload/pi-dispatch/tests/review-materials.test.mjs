import test from 'node:test';
import {inspectReviewMaterialBudget} from '../scripts/review-materials.mjs';
import {inspectReviewPacketBudget} from '../extensions/review-contract.js';

const budgetInput=(n=3)=>{
 const patch='--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+'+'x'.repeat(n)+'\n';
 return {stage:'post-change',tier:'T1',requirements:['Implement fixture'],changes:[patch],context:['Relevant source'],verification:['Host exit 0'],changedFiles:['x.js'],trustedPatch:patch};
};

test('early budget inspection handles exact and one-over non-diff and total UTF8 bytes',()=>{
 const nonDiff=budgetInput();
 let report=inspectReviewMaterialBudget(nonDiff);
 nonDiff.context[0]+='x'.repeat(8192-report.budget.nonDiffUtf8Bytes);
 report=inspectReviewMaterialBudget(nonDiff);
 assert.equal(report.ok,true);assert.equal(report.budget.nonDiffUtf8Bytes,8192);
 nonDiff.context[0]+='x';report=inspectReviewMaterialBudget(nonDiff);
 assert.equal(report.ok,false);assert.equal(report.budget.nonDiffUtf8Bytes,8193);
 assert.ok(report.violations.some(v=>v.location==='reviewPacket.nonDiff'&&v.limit===8192));
 for(const [tier,target] of [['T1',24576],['T2',131072]]) {
  const data=budgetInput(1000);data.tier=tier;
  for(let i=0;i<5;i++) {const delta=target-inspectReviewMaterialBudget(data).budget.totalUtf8Bytes;if(!delta)break;
   data.changes[0]=data.changes[0].slice(0,-1)+(delta>0?'x'.repeat(delta):'')+'\n';
   if(delta<0)data.changes[0]=data.changes[0].slice(0,delta-1)+'\n';
   data.trustedPatch=data.changes[0];}
  report=inspectReviewMaterialBudget(data);assert.equal(report.budget.totalUtf8Bytes,target);assert.equal(report.ok,true);
  data.changes[0]=data.changes[0].slice(0,-1)+'x\n';data.trustedPatch=data.changes[0];report=inspectReviewMaterialBudget(data);
  assert.equal(report.ok,false);assert.equal(report.budget.totalUtf8Bytes,target+1);
  assert.ok(report.violations.some(v=>v.location==='reviewPacket.total'&&v.limit===target));
  assert.match(report.nextAction,/commit.*quota/);
 }
});

test('unbound diff gets conservative measurement, no admission, and no false hard dispatch limit',()=>{
 const data=budgetInput(9000);delete data.trustedPatch;
 const report=inspectReviewMaterialBudget(data);
 assert.equal(report.ok,true);assert.equal(report.requiresTrustedDiffBinding,true);assert.equal(report.admissionReady,false);
 assert.equal(report.budget.diffBound,false);assert.equal(report.budget.nonDiffUtf8Bytes,report.budget.totalUtf8Bytes);
 assert.ok(report.budget.projectedNonDiffUtf8Bytes<8192);
 assert.ok(report.violations.some(v=>v.location==='reviewPacket.nonDiff'&&v.blocking===false));
 const invalid=budgetInput(9000);delete invalid.trustedPatch;invalid.changes[0]=invalid.changes[0].replace('+1 @@','+1,2 @@');
 assert.equal(inspectReviewMaterialBudget(invalid).ok,false);
 const stale=budgetInput();stale.trustedPatch+='different';
 assert.ok(inspectReviewMaterialBudget(stale).violations.some(v=>v.code==='REVIEW_PATCH_BINDING_MISMATCH'));
});

test('early inspection shares normalization, reports redaction expansion, coverage and section locations',()=>{
 const data=budgetInput();data.context=['Bearer x'];const before=JSON.stringify(data);
 const packet=buildReviewPacket(data),report=inspectReviewMaterialBudget(data);
 assert.equal(report.budget.totalUtf8Bytes,Buffer.byteLength(JSON.stringify(packet)));
 assert.match(packet.context.content[0],/Bearer \[REDACTED\]/);assert.equal(JSON.stringify(data),before);
 assert.equal(report.sections.find(s=>s.location==='reviewPacket.context').utf8Bytes,Buffer.byteLength(JSON.stringify(packet.context)));
 const unicode=budgetInput();unicode.context=['漢😀'];
 assert.ok(inspectReviewMaterialBudget(unicode).budget.totalUtf8Bytes>JSON.stringify(buildReviewPacket(unicode)).length);
 const tooMany=budgetInput();tooMany.context=Array(33).fill('x'.repeat(8000));
 assert.ok(inspectReviewMaterialBudget(tooMany).violations.some(v=>v.location==='reviewPacket.context.content'&&v.actual===33&&v.limit===32));
 const tooLong=structuredClone(packet);tooLong.context.content=['x'.repeat(8001)];
 assert.ok(inspectReviewPacketBudget(tooLong,{tier:'T2'}).violations.some(v=>v.location==='reviewPacket.context.content[0]'&&v.unit==='utf16-units'));
 const missing=budgetInput();missing.changedFiles.push('missing.js');
 assert.ok(inspectReviewMaterialBudget(missing).violations.some(v=>v.code==='REVIEW_MATERIALS_MISSING'&&v.location==='reviewPacket.changes'));
 assert.equal(inspectReviewMaterialBudget({...data,context:[]}).ok,false);
});
import assert from 'node:assert/strict';
import {buildReviewPacket,REVIEW_MATERIAL_LIMITS} from '../scripts/review-materials.mjs';
import {compileKetherTask} from '../extensions/kether-envelope.js';
const input={stage:'post-change',tier:'T2',changedFiles:['src/a.js'],requirements:['Req'],changes:['--- src/a.js\n+++ src/a.js\n@@ -1 +1 @@\n-old\n+new'],context:['Context'],verification:['Host check passed']};

test('many small excerpts repack without removing text or relaxing packet budgets',()=>{
 const excerpts=Array.from({length:100},(_,i)=>`source-${i}: 漢😀\r\nkeep exact`);
 const packet=buildReviewPacket({...input,tier:'T1',context:excerpts});
 assert.equal(packet.context.content.join(''),excerpts.join('\n'));
 assert.ok(packet.context.content.length<=32);assert.ok(packet.context.content.every(s=>s.length<=8000&&s.trim()));
 assert.ok(inspectReviewMaterialBudget({...input,tier:'T1',context:excerpts}).ok);
 const ordinary=buildReviewPacket({...input,context:['a','b']});assert.deepEqual(ordinary.context.content,['a','b']);
});

test('fragmented diff repacking retains exact trusted bytes, coverage and UTF16 boundaries',()=>{
 const patch='--- a/src/a.js\n+++ b/src/a.js\n@@ -0,0 +40 @@\n'+Array.from({length:40},(_,i)=>`+line-${i} 漢😀\r\n`).join('');
 const parts=patch.match(/[^\n]+\n/gu);assert.ok(parts.length>32);
 const packet=buildReviewPacket({...input,tier:'T1',changes:parts,trustedPatch:patch});
 assert.equal(packet.changes.content.join(''),patch);assert.ok(packet.changes.content.length<=32);
 assert.throws(()=>buildReviewPacket({...input,tier:'T1',changes:parts,trustedPatch:patch+'\n'}),e=>e.code==='REVIEW_PATCH_BINDING_MISMATCH');
 const trimmed=parts.map(s=>s.trimEnd());assert.throws(()=>buildReviewPacket({...input,tier:'T1',changes:trimmed,trustedPatch:patch}));
});

test('budget diagnostics expose remaining/excess and report malformed arrays and T1 stage',()=>{
 const packet=buildReviewPacket({...input,tier:'T1'}),good=inspectReviewPacketBudget(packet,{tier:'T1',trustedPatch:input.changes[0]});
 assert.equal(good.budget.remainingUtf8Bytes.total,24576-good.budget.totalUtf8Bytes);assert.equal(good.budget.overByUtf8Bytes.total,0);
 assert.equal(good.admissionReady,false);
 const malformed=structuredClone(packet);malformed.context.content='not an array';
 assert.doesNotThrow(()=>inspectReviewPacketBudget(malformed,{tier:'T1'}));
 assert.equal(inspectReviewPacketBudget(malformed,{tier:'T1'}).violations[0].location,'reviewPacket.context.content');
 const pre=inspectReviewPacketBudget({...packet,stage:'pre-change'},{tier:'T1'});
 assert.equal(pre.ok,false);assert.ok(pre.violations.some(v=>v.location==='reviewPacket.stage'));
 const large=structuredClone(packet);large.context.content=['x'.repeat(30000)];const over=inspectReviewPacketBudget(large,{tier:'T1'});
 assert.equal(over.budget.remainingUtf8Bytes.total,0);assert.equal(over.budget.overByUtf8Bytes.total,over.budget.totalUtf8Bytes-24576);
});

test('review packet requires complete substantive changed-file material and preserves chunks',()=>{
 const packet=buildReviewPacket(input);
 assert.equal(packet.changes.status,'provided');
 assert.ok(packet.changes.content[0].includes('@@'));
 const redacted=buildReviewPacket({...input,tier:'T1',context:['api_key=supersecret']});
 assert.equal(JSON.stringify(redacted).includes('supersecret'),false);
 assert.throws(()=>buildReviewPacket({...input,changes:['src/a.js']}),/substantive patch/);
 assert.throws(()=>buildReviewPacket({...input,changedFiles:['src/a.js','src/b.js']}),error=>error.message.includes('src/b.js'));
 assert.throws(()=>buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js','src/b.js']}),error=>error.message.includes('src/b.js'));
});

test('review packet enforces tier byte limits and complete per-file diff evidence',()=>{
 const padding='x'.repeat(70000);
 assert.ok(buildReviewPacket({...input,context:[padding]}));
 assert.throws(()=>buildReviewPacket({...input,context:[padding.repeat(2)]}),/byte budget|128 KiB/);
 assert.throws(()=>buildReviewPacket({...input,changedFiles:['src/a.js','src/b.js'],changes:[input.changes[0]+'\n--- src/b.js\n+++ src/b.js']}),error=>error.message.includes('src/b.js'));
 const smallDiff={...input,tier:'T1',requirements:['R'],changes:input.changes,context:['C'],verification:['V']};
 assert.throws(()=>buildReviewPacket({...smallDiff,context:['x'.repeat(11000)]}),/8192/);
});

test('review chunks preserve lines, CRLF, whitespace and Unicode exactly',()=>{
 const crlf='a'.repeat(7999)+'\r\n  tail\n';
 const packet=buildReviewPacket({...input,tier:'T2',changes:[input.changes[0]],context:[crlf]});
 assert.equal(packet.context.content.join(''),crlf);
 assert.ok(packet.context.content.length>1);
 assert.ok(packet.context.content.every(part=>part.trim()));
 const long='x'.repeat(7999)+'😀'+'tail';
 const longPacket=buildReviewPacket({...input,tier:'T2',changes:[input.changes[0]],context:[long]});
 assert.equal(longPacket.context.content.join(''),long);
 assert.ok(longPacket.context.content.every(part=>!(part.charCodeAt(part.length-1)>=0xd800&&part.charCodeAt(part.length-1)<=0xdbff)));
 const lines='first\nsecond\nthird';
 const linePacket=buildReviewPacket({...input,tier:'T2',changes:[input.changes[0]],context:[lines]});
 assert.equal(linePacket.context.content.join(''),lines);
 assert.equal(linePacket.context.content.length,1);
 const completeLines='first\n'+'x'.repeat(7995)+'\ntail';
 const completePacket=buildReviewPacket({...input,tier:'T2',context:[completeLines]});
 assert.equal(completePacket.context.content[0],'first\n');
 assert.equal(completePacket.context.content.join(''),completeLines);
 const spaced='prefix\n'+' '.repeat(15000)+'suffix';
 const spacedPacket=buildReviewPacket({...input,context:[spaced]});
 assert.equal(spacedPacket.context.content.join(''),spaced);
 assert.ok(spacedPacket.context.content.every(part=>part.trim()));
 const leading='\n'+('z'.repeat(7999))+'\nend';
 const leadingPacket=buildReviewPacket({...input,tier:'T2',changes:[input.changes[0]],context:[leading]});
 assert.equal(leadingPacket.context.content.join(''),leading);
});

test('line preference falls back within string budget and keeps impossible blank runs rejected',()=>{
 const excerpts=[...Array(22).fill('excerpt'),...Array(4).fill('prefix\n'+'x'.repeat(15985))];
 const packet=buildReviewPacket({...input,context:excerpts});
 assert.equal(packet.context.content.length,30);
 assert.equal(packet.context.content.join(''),excerpts.join(''));
 assert.ok(packet.context.content.every(part=>part.trim()&&part.length<=8000));
 assert.throws(()=>buildReviewPacket({...input,context:['a'.repeat(10)+'\n'+' '.repeat(20000)+'b']}),/Invalid reviewPacket.context.content/);
});

test('compiled reviewer prompt preserves packet and explains serialized content',()=>{
 const packet=buildReviewPacket(input);
 const task={contractVersion:2,role:'Geburah',objective:'Review',context:[],readScope:[],writeScope:[],fixtureScope:[],forbidden:[],dependencies:[],acceptance:[],reviewPacket:packet};
 const before=JSON.stringify(task);
 const prompt=compileKetherTask(task);
 const serialized=prompt.match(/TASK_PACKET_JSON=(.*)/)[1];
 assert.deepEqual(JSON.parse(serialized).reviewPacket,packet);
 assert.equal(JSON.stringify(task),before);
 assert.match(prompt,/Quotes and commas between content strings are serialization/);
 const ordinary=compileKetherTask({...task,role:'Chesed'});
 assert.doesNotMatch(ordinary,/Quotes and commas between content strings are serialization/);
});

test('review packet bounds chunks, strings, bytes and rejects NUL',()=>{
 const large='x'.repeat(REVIEW_MATERIAL_LIMITS.sectionChars+1);
 const packet=buildReviewPacket({...input,tier:'T2',changedFiles:['src/a.js'],context:[large]});
 assert.equal(packet.context.content.length,2);
 assert.ok(packet.context.content.every(part=>part.length<=8000));
 assert.throws(()=>buildReviewPacket({...input,requirements:['bad\0text']}),/Invalid review material/);
 assert.throws(()=>buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js'],context:['x'.repeat(8000)].concat(Array(32).fill('y'.repeat(8000)))}),/string budget|byte budget/);
});
