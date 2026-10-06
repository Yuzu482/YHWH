import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReviewPacket,REVIEW_MATERIAL_LIMITS} from '../scripts/review-materials.mjs';
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

test('review packet bounds chunks, strings, bytes and rejects NUL',()=>{
 const large='x'.repeat(REVIEW_MATERIAL_LIMITS.sectionChars+1);
 const packet=buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js'],context:[large]});
 assert.equal(packet.context.content.length,2);
 assert.ok(packet.context.content.every(part=>part.length<=8000));
 assert.throws(()=>buildReviewPacket({...input,requirements:['bad\0text']}),/Invalid review material/);
 assert.throws(()=>buildReviewPacket({...input,tier:'T1',changedFiles:['src/a.js'],context:['x'.repeat(8000)].concat(Array(32).fill('y'.repeat(8000)))}),/string budget|byte budget/);
});
