// Content identity for the isolated, reviewed Pi 1.5.1 installation.
// The root digest is fixed in source, not supplied by a task or environment.
import {closeSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

export const PI_151_TREE_SHA256 = '5aa0eecfea8739ee9c805511ac03830906f346e579389600e04dd88ddf318644';

export function sdkTreeDigest(root) {
  const base=realpathSync(root), hash=createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024);
  let count=0, bytes=0;
  function visit(dir, prefix='') {
    for(const name of readdirSync(dir).sort()) {
      const path=join(dir,name), rel=prefix ? `${prefix}/${name}` : name;
      const st=lstatSync(path);
      if(++count>100000 || rel.includes('\n'))throw Error('PI_SDK_TREE_INVALID');
      let kind,content;
      if(st.isDirectory()) {kind='d';content='';}
      else if(st.isSymbolicLink()) {
        kind='l';content=readlinkSync(path);
        if(isAbsolute(content))throw Error('PI_SDK_TREE_INVALID');
        const target=resolve(dir,content), relTarget=relative(base,target);
        if(relTarget==='..'||relTarget.startsWith('..'+sep)||isAbsolute(relTarget))throw Error('PI_SDK_TREE_INVALID');
        const resolved=realpathSync(path), relReal=relative(base,resolved);
        if(relReal==='..'||relReal.startsWith('..'+sep)||isAbsolute(relReal))throw Error('PI_SDK_TREE_INVALID');
      } else if(st.isFile()) {
        kind='f';bytes+=st.size;if(bytes>1024*1024*1024)throw Error('PI_SDK_TREE_INVALID');
        const h=createHash('sha256'), fd=openSync(path,'r');
        try {for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;h.update(buffer.subarray(0,n));}}
        finally {closeSync(fd);}
        content=h.digest('hex');
      } else throw Error('PI_SDK_TREE_INVALID');
      hash.update(JSON.stringify([rel,kind,st.mode & 0o777,content])+'\n');
      if(kind==='d')visit(path,rel);
    }
  }
  visit(base);
  return hash.digest('hex');
}
