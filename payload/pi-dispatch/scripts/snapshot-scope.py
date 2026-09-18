"""Copy only admitted regular files; never follow repository-controlled links."""
import os, sys, json, pathlib, stat, time, hashlib

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 10000
MAX_ENTRIES = 50000
DENY = {'.git', '.hg', '.svn', 'node_modules', 'library', 'temp', 'obj', 'bin', '.ssh', '.aws', '.azure', '.gnupg', '.pi', '.pi-lsp.json', 'auth.json', 'models.json', 'models-store.json', '.npmrc', '.pypirc', 'credentials.json', '.credentials.json'}
def forbidden(path):
    return any(p.lower() in DENY or p.lower().startswith('.env') or p.lower().endswith(('.pem', '.key', '.p12', '.pfx')) for p in pathlib.PurePosixPath(path).parts)
def compile_scope(values):
    result=[]
    for value in values:
        tree=value.endswith('/**')
        name=value[:-3] if tree else value
        parts=name.split('/')
        if not name or any(p in ('', '.', '..') for p in parts) or any(c in name for c in '\\:*?[]{}\x00\t\r\n'):
            raise ValueError('Invalid read/write scope')
        if forbidden(name): raise ValueError('Sensitive or executable configuration cannot be scoped')
        result.append((name,tree))
    return result
def allowed(name, scopes):
    return any(name==p or (tree and name.startswith(p+'/')) for p,tree in scopes)
def snapshot(source, destination, manifest):
    scopes=compile_scope(manifest['read']+manifest['write'])
    total=count=entries=0
    start=time.monotonic()
    def walk(src_fd, prefix=''):
        nonlocal total,count,entries
        for name in os.listdir(src_fd):
            entries+=1
            if entries>MAX_ENTRIES or time.monotonic()-start>30: raise ValueError('Snapshot scan limit exceeded')
            rel=prefix+name
            if forbidden(rel): continue
            st=os.stat(name,dir_fd=src_fd,follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                if not any(allowed(rel,[(p,t)]) or p.startswith(rel+'/') for p,t in scopes): continue
                fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=src_fd)
                try: walk(fd,rel+'/')
                finally: os.close(fd)
            elif allowed(rel,scopes):
                if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: raise ValueError('Links and special files are forbidden')
                fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=src_fd)
                try:
                    actual=os.fstat(fd)
                    if not stat.S_ISREG(actual.st_mode) or actual.st_nlink!=1: raise ValueError('Unsafe source file')
                    count+=1
                    if count>MAX_FILES or total+actual.st_size>MAX_BYTES: raise ValueError('Snapshot size limit exceeded')
                    target=pathlib.Path(destination,rel)
                    target.parent.mkdir(parents=True,exist_ok=True)
                    with open(target,'xb') as out:
                        while True:
                            chunk=os.read(fd,65536)
                            if not chunk: break
                            total+=len(chunk)
                            if total>MAX_BYTES: raise ValueError('Snapshot size limit exceeded')
                            out.write(chunk)
                finally: os.close(fd)
    fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: walk(fd)
    finally: os.close(fd)
    print(json.dumps({'files':count,'bytes':total}))
def verify_tree(baseline, workspace, writes):
    scope=compile_scope(writes)
    def inventory(root):
        result={}
        total=0
        for base,dirs,files in os.walk(root,followlinks=False):
            for name in dirs+files:
                path=pathlib.Path(base,name)
                st=path.lstat()
                rel=path.relative_to(root).as_posix()
                if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                    raise ValueError('Unsafe final filesystem entry')
                if stat.S_ISREG(st.st_mode):
                    total+=st.st_size
                    if st.st_nlink!=1 or total>MAX_BYTES or len(result)>=MAX_FILES: raise ValueError('Final tree resource or link limit exceeded')
                    h=hashlib.sha256()
                    with open(path,'rb') as f:
                        for chunk in iter(lambda:f.read(65536),b''): h.update(chunk)
                    result[rel]=h.digest()
        return result
    before,after=inventory(baseline),inventory(workspace)
    for rel in before.keys()|after.keys():
        if before.get(rel)!=after.get(rel) and (forbidden(rel) or not allowed(rel,scope)):
            raise ValueError('Actual filesystem change outside write scope')
if __name__=='__main__':
    if sys.argv[1]=='--verify': verify_tree(sys.argv[2],sys.argv[3],json.load(open(sys.argv[4])))
    else: snapshot(sys.argv[1],sys.argv[2],json.load(open(sys.argv[3])))
