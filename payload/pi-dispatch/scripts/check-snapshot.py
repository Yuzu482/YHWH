#!/usr/bin/env python3
"""Root-only bounded snapshot. Inputs come from the trusted broker, never model argv."""
import os, stat, sys, json, hashlib
MAX_FILES=4096
MAX_BYTES=64*1024*1024
EXCLUDED={'.git','node_modules','vendor','.venv','venv','.cache','.cargo','.gradle'}
def snapshot(source, destination, uid, gid):
    count=0
    total=0
    entries=[]
    def walk(srcfd, dstfd, prefix=''):
        nonlocal count,total
        for name in sorted(os.listdir(srcfd)):
            if name in EXCLUDED:
                continue
            if name in ('','.','..') or '/' in name or '\\' in name or any(ord(x)<32 for x in name):
                raise ValueError('unsafe snapshot name')
            info=os.stat(name,dir_fd=srcfd,follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('snapshot link')
            if stat.S_ISDIR(info.st_mode):
                fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=srcfd)
                try:
                    current=os.fstat(fd)
                    if (current.st_dev,current.st_ino)!=(info.st_dev,info.st_ino):
                        raise ValueError('snapshot directory changed')
                    os.mkdir(name,0o700,dir_fd=dstfd)
                    out=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=dstfd)
                    try:
                        os.fchown(out,uid,gid)
                        walk(fd,out,prefix+name+'/')
                        os.fchmod(out,0o700)
                    finally: os.close(out)
                finally: os.close(fd)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                count+=1
                if count>MAX_FILES or info.st_size>MAX_BYTES-total: raise ValueError('snapshot size')
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=srcfd)
                out=None
                try:
                    before=os.fstat(fd)
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or (before.st_dev,before.st_ino)!=(info.st_dev,info.st_ino):
                        raise ValueError('snapshot file changed')
                    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=dstfd)
                    digest=hashlib.sha256()
                    length=0
                    while True:
                        data=os.read(fd,min(65536,MAX_BYTES-total+1))
                        if not data: break
                        total+=len(data);length+=len(data)
                        if total>MAX_BYTES: raise ValueError('snapshot growth')
                        digest.update(data)
                        offset=0
                        while offset<len(data): offset+=os.write(out,data[offset:])
                    after=os.fstat(fd)
                    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or length!=before.st_size:
                        raise ValueError('snapshot changed during copy')
                    os.fchown(out,uid,gid)
                    os.fchmod(out,0o700 if before.st_mode&0o111 else 0o600)
                    entries.append([prefix+name,length,digest.hexdigest()])
                finally:
                    os.close(fd)
                    if out is not None: os.close(out)
            else: raise ValueError('snapshot special file or hardlink')
    src=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    dst=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        walk(src,dst)
        os.fchown(dst,uid,gid);os.fchmod(dst,0o700)
    finally: os.close(src);os.close(dst)
    return {'files':count,'bytes':total,'sha256':hashlib.sha256(json.dumps(entries,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
if __name__=='__main__':
    try:
        if os.getuid()!=0 or len(sys.argv)!=5: raise ValueError('root-only snapshot')
        print(json.dumps(snapshot(sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4]))))
    except Exception:
        print('YHWH_CHECK_SNAPSHOT_REJECTED',file=sys.stderr);sys.exit(2)

