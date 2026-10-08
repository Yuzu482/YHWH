import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewPacket,REVIEW_MATERIAL_LIMITS} from '../scripts/review-materials.mjs';
import {compileKetherTask} from '../extensions/kether-envelope.js';
const input={stage:'post-change',tier:'T2',changedFiles:['src/a.js'],requirements:['Req'],changes:['--- src/a.js\n+++ src/a.js\n@@ -1 +1 @@\n-old\n+new'],context:['Context'],verification:['Host check passed']};

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
 assert.throws(()=>buildReviewPacket({...smallDiff,context:['x'.repeat(11000)]}),/10240/);
});

test('review chunks preserve lines, CRLF, whitespace and Unicode exactly',()=>{
 const crlf='a'.repeat(7999)+'\r\n  tail\n';
 const packet=buildReviewPacket({...input,tier:'T1',changes:[input.changes[0]],context:[crlf]});
 assert.equal(packet.context.content.join(''),crlf);
 assert.ok(packet.context.content.length>1);
 assert.ok(packet.context.content.every(part=>part.trim()));
 const long='x'.repeat(7999)+'😀'+'tail';
 const longPacket=buildReviewPacket({...input,tier:'T1',changes:[input.changes[0]],context:[long]});
 assert.equal(longPacket.context.content.join(''),long);
 assert.ok(longPacket.context.content.every(part=>!(part.charCodeAt(part.length-1)>=0xd800&&part.charCodeAt(part.length-1)<=0xdbff)));
 const lines='first\nsecond\nthird';
 const linePacket=buildReviewPacket({...input,tier:'T1',changes:[input.changes[0]],context:[lines]});
 assert.equal(linePacket.context.content.join(''),lines);
 assert.equal(linePacket.context.content.length,1);
 const completeLines='first\n'+'x'.repeat(7995)+'\ntail';
 const completePacket=buildReviewPacket({...input,tier:'T1',context:[completeLines]});
 assert.equal(completePacket.context.content[0],'first\n');
 assert.equal(completePacket.context.content.join(''),completeLines);
 const spaced='prefix\n'+' '.repeat(15000)+'suffix';
 const spacedPacket=buildReviewPacket({...input,context:[spaced]});
 assert.equal(spacedPacket.context.content.join(''),spaced);
 assert.ok(spacedPacket.context.content.every(part=>part.trim()));
 const leading='\n'+('z'.repeat(7999))+'\nend';
 const leadingPacket=buildReviewPacket({...input,tier:'T1',changes:[input.changes[0]],context:[leading]});
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
 const packet=buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js'],context:[large]});
 assert.equal(packet.context.content.length,2);
 assert.ok(packet.context.content.every(part=>part.length<=8000));
 assert.throws(()=>buildReviewPacket({...input,requirements:['bad\0text']}),/Invalid review material/);
 assert.throws(()=>buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js'],context:['x'.repeat(8000)].concat(Array(32).fill('y'.repeat(8000)))}),/string budget|byte budget/);
});
