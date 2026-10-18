// Host-only byte capture from already-authorized, already-read text. No I/O.
import {createHash} from 'node:crypto';
import {DATA_CAPACITY} from '../extensions/data-capacity.js';
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = message => {throw new Error(message);};
export function captureFrozenPatch(files) {
  if(!Array.isArray(files)||!files.length||files.length>256)fail('Invalid frozen file set');
  const paths=new Set(),manifest=[];let patch='',bytes=0;
  for(const f of [...files].sort((a,b)=>String(a?.path)<String(b?.path)?-1:String(a?.path)>String(b?.path)?1:0)) {
    if(typeof f?.path!=='string'||!f.path||f.path.includes('\\')||/[\0-\x1f\x7f]/.test(f.path)||f.path.startsWith('/')||/^[A-Za-z]:/.test(f.path)||
      f.path.includes(':')||Buffer.from(f.path).toString('utf8')!==f.path||f.path.split('/').some(s=>!s||['.','..','.git'].includes(s.toLowerCase())||/[. ]$/.test(s))||paths.has(f.path.toLowerCase()))fail('Invalid or duplicate frozen path');
    paths.add(f.path.toLowerCase());
    for(const name of ['before','after']) {
      const text=f[name];if(text!==null&&(typeof text!=='string'||text.includes('\0')||Buffer.from(text).toString('utf8')!==text))fail('Frozen capture requires exact UTF-8 text');
      if(f[name+'Sha256']!==(text===null?null:sha(text)))fail('Frozen source fingerprint drift: '+f.path);
      bytes+=text===null?0:Buffer.byteLength(text);if(bytes>DATA_CAPACITY.patchMaxUtf8Bytes)fail('Frozen sources exceed patch budget');
    }
    if(f.before===f.after)continue;
    // Empty-file mode-only changes need a different producer; never omit them.
    if(f.before===null&&f.after===''||f.after===null&&f.before==='')fail('Empty-file creation/deletion unsupported');
    const lines=s=>s===null||s===''?[]:s.endsWith('\n')?s.slice(0,-1).split('\n'):s.split('\n');
    const before=lines(f.before),after=lines(f.after),range=n=>n===0?'0,0':`1,${n}`;
    const emit=(s,ls,prefix)=>ls.map((line,i)=>prefix+line+'\n'+(i===ls.length-1&&!s.endsWith('\n')?'\\ No newline at end of file\n':'')).join('');
    const header=(prefix,text)=>text===null?'/dev/null':JSON.stringify(prefix+f.path);
    patch+=`--- ${header('a/',f.before)}\n+++ ${header('b/',f.after)}\n@@ -${range(before.length)} +${range(after.length)} @@\n`+emit(f.before,before,'-')+emit(f.after,after,'+');
    if(Buffer.byteLength(patch)>DATA_CAPACITY.patchMaxUtf8Bytes)fail('Frozen patch exceeds patch budget');
    manifest.push({path:f.path,beforeSha256:f.beforeSha256,afterSha256:f.afterSha256});
  }
  if(!patch)fail('Frozen capture has no changes');
  return {patch,artifactSha256:sha(patch),files:manifest,readOnly:true,requiresHostVerification:true};
}
export function verifyFrozenPatch(patch,files) {
  const capture=captureFrozenPatch(files);
  if(patch!==capture.patch)fail('Patch differs from deterministic frozen capture');
  return capture;
}
export function verifyFrozenFiles(files,actualFiles) {
  captureFrozenPatch(files);
  if(!Array.isArray(actualFiles)||actualFiles.length!==files.length||new Set(actualFiles.map(f=>f.path)).size!==files.length)fail('Current frozen file snapshot required');
  for(const f of files){const a=actualFiles.find(a=>a.path===f.path);if(!a||a.text!==f.after||a.sha256!==f.afterSha256||a.sha256!==(a.text===null?null:sha(a.text)))fail('Applied frozen file fingerprint drift: '+f.path);}
  return true;
}
