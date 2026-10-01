"""Copy only admitted regular files; never follow repository-controlled links."""
import os, sys, json, pathlib, stat, time, hashlib, re, argparse, unicodedata

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 10000
MAX_ENTRIES = 50000
MAX_CREATED_DIRS = 50000
DENY = {'.git', '.hg', '.svn', 'node_modules', 'library', 'temp', 'obj', 'bin', '.ssh', '.aws', '.azure', '.gnupg', '.pi', '.pi-lsp.json', 'auth.json', 'models.json', 'models-store.json', '.npmrc', '.pypirc', 'credentials.json', '.credentials.json', 'anthropic-api-key.json', 'provider-config.json', 'provider-credentials.json'}
def forbidden(path):
    return any(p.lower() in DENY or p.lower().startswith('.env') or p.lower().endswith(('.pem', '.key', '.p12', '.pfx')) for p in pathlib.PurePosixPath(path).parts)
def compile_scope(values):
    result=[]
    for value in values:
        tree=value.endswith('/**')
        name=value[:-3] if tree else value
        parts=name.split('/')
        if len(parts)>64 or len(parts)>MAX_ENTRIES or not name or any(p in ('', '.', '..') for p in parts) or any(c in name for c in '\\:*?[]{}\x00\t\r\n'):
            raise ValueError('Invalid read/write scope')
        if forbidden(name): raise ValueError('Sensitive or executable configuration cannot be scoped')
        result.append((name,tree))
    return result
def allowed(name, scopes):
    return any(name==p or (tree and name.startswith(p+'/')) for p,tree in scopes)
def fixture_scopes(manifest):
    values=manifest.get('fixtures',[])
    if not isinstance(values,list) or len(values)>64: raise ValueError('Invalid fixture scope list')
    fixtures=[]
    for value in values:
        if not isinstance(value,str) or not value or len(value)>4000 or value!=value.strip() or value!=unicodedata.normalize('NFC',value): raise ValueError('Invalid fixture path')
        if any(ord(c)<32 or ord(c)==127 for c in value) or '\\' in value or ':' in value: raise ValueError('Invalid fixture path')
        name=value[:-3] if value.endswith('/**') else value
        parts=name.split('/')
        if len(parts)>64 or any(not p or p in ('.','..') or re.search(r'[*?\[\]{}~]',p) or p.endswith(('.',' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in parts): raise ValueError('Invalid fixture path')
        if forbidden(name): raise ValueError('Sensitive fixture path')
        fixtures.append((name,value.endswith('/**')))
    def overlaps(a,b):
        a,b=a.lower(),b.lower()
        return a==b or a.startswith(b+'/') or b.startswith(a+'/')
    writes=compile_scope(manifest['write'])
    for i,(name,_) in enumerate(fixtures):
        if any(overlaps(name,p) for p,_ in fixtures[:i]+writes): raise ValueError('Fixture scope overlap')
    return fixtures
def validate_fixture_paths(root, fixtures):
    root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for name,tree in fixtures:
            fd=os.dup(root_fd)
            try:
                parts=name.split('/')
                for i,part in enumerate(parts):
                    final=i==len(parts)-1
                    st=os.stat(part,dir_fd=fd,follow_symlinks=False)
                    expect_dir=not final or tree
                    if expect_dir and not stat.S_ISDIR(st.st_mode): raise ValueError('Fixture directory required')
                    if not expect_dir and (not stat.S_ISREG(st.st_mode) or st.st_nlink!=1): raise ValueError('Fixture regular single-link file required')
                    next_fd=os.open(part,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if expect_dir else 0),dir_fd=fd)
                    actual=os.fstat(next_fd)
                    if (expect_dir and not stat.S_ISDIR(actual.st_mode)) or (not expect_dir and (not stat.S_ISREG(actual.st_mode) or actual.st_nlink!=1)):
                        os.close(next_fd); raise ValueError('Unsafe fixture')
                    os.close(fd);fd=next_fd
            finally: os.close(fd)
    finally: os.close(root_fd)
def fixture_bindings(workspace, manifest, output):
    fixtures=fixture_scopes(manifest)
    validate_fixture_paths(workspace,fixtures)
    # Output is host-root owned, outside the worker workspace; no try-bind fallback.
    root=pathlib.Path(workspace).resolve(strict=True)
    target=pathlib.Path(output)
    if target.parent.resolve(strict=True)==root or root in target.parent.resolve(strict=True).parents: raise ValueError('Unsafe binding output location')
    data=b''.join(os.fsencode(arg)+b'\0' for name,_ in fixtures for arg in ('--ro-bind',str(root/name),'/workspace/'+name))
    fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as f: f.write(data)
    except BaseException:
        os.unlink(output);raise
def _make_dirs(root_fd, parts, remaining=MAX_ENTRIES):
    if len(parts)>64: raise ValueError('Snapshot path depth limit exceeded')
    fd=os.dup(root_fd)
    created=0
    try:
        for part in parts:
            try:
                os.stat(part,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:
                if created>=remaining: raise ValueError('Snapshot directory creation limit exceeded')
                try:
                    os.mkdir(part,0o755,dir_fd=fd)
                    created+=1
                except FileExistsError: pass
            next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=next_fd
        return created
    finally: os.close(fd)
def _check_source_ancestors(root_fd, parts):
    fd=os.dup(root_fd)
    try:
        for part in parts:
            try: st=os.stat(part,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError: return
            if not stat.S_ISDIR(st.st_mode): raise ValueError('Unsafe source write ancestor')
            next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=next_fd
    finally: os.close(fd)
def snapshot(source, destination, manifest):
    fixtures=fixture_scopes(manifest)
    validate_fixture_paths(source,fixtures)
    scopes=compile_scope(manifest['read']+manifest['write'])+fixtures
    total=count=entries=0
    start=time.monotonic()
    dest_fd=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        fd=os.open(source,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    except BaseException:
        os.close(dest_fd)
        raise
    created_dirs=0
    def walk(src_fd, prefix=''):
        nonlocal total,count,entries,created_dirs
        for name in os.listdir(src_fd):
            entries+=1
            if entries>MAX_ENTRIES or time.monotonic()-start>30: raise ValueError('Snapshot scan limit exceeded')
            rel=prefix+name
            if rel.count('/')+1>64: raise ValueError('Snapshot path depth limit exceeded')
            if forbidden(rel): continue
            st=os.stat(name,dir_fd=src_fd,follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                if not any(allowed(rel,[(p,t)]) or p.startswith(rel+'/') for p,t in scopes): continue
                if allowed(rel,fixtures): created_dirs+=_make_dirs(dest_fd,rel.split('/'),MAX_CREATED_DIRS-created_dirs)
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
                    parts=rel.split('/')
                    created_dirs+=_make_dirs(dest_fd,parts[:-1],MAX_CREATED_DIRS-created_dirs)
                    target=pathlib.Path(destination,rel)
                    with open(target,'xb') as out:
                        while True:
                            chunk=os.read(fd,65536)
                            if not chunk: break
                            total+=len(chunk)
                            if total>MAX_BYTES: raise ValueError('Snapshot size limit exceeded')
                            out.write(chunk)
                finally: os.close(fd)
    try:
        walk(fd)
        for name,tree in fixtures:
            if tree: created_dirs+=_make_dirs(dest_fd,name.split('/'),MAX_CREATED_DIRS-created_dirs)
        for name,tree in compile_scope(manifest['write']):
            parts=name.split('/')
            _check_source_ancestors(fd,parts[:-1] if not tree else parts)
            created_dirs+=_make_dirs(dest_fd,parts if tree else parts[:-1],MAX_CREATED_DIRS-created_dirs)
    finally:
        os.close(fd); os.close(dest_fd)
    print(json.dumps({'files':count,'bytes':total}))
def verify_tree(baseline, workspace, writes, fixtures=()):
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
                elif allowed(rel,fixtures): result[rel]=b'directory'
        return result
    before,after=inventory(baseline),inventory(workspace)
    for rel in before.keys()|after.keys():
        if before.get(rel)!=after.get(rel) and (allowed(rel,fixtures) or forbidden(rel) or not allowed(rel,scope)):
            raise ValueError('Actual filesystem change outside write scope')
if __name__=='__main__':
    def read_json(name):
        with open(name,encoding='utf-8') as f: return json.load(f)
    try:
        if sys.argv[1:2]==['--fixture-bindings']:
            parser=argparse.ArgumentParser();parser.add_argument('--fixture-bindings',action='store_true');parser.add_argument('--workspace',required=True);parser.add_argument('--manifest',required=True);parser.add_argument('--output',required=True)
            args=parser.parse_args();fixture_bindings(args.workspace,read_json(args.manifest),args.output)
        elif sys.argv[1:2]==['--verify']:
            parser=argparse.ArgumentParser();parser.add_argument('--verify',action='store_true');parser.add_argument('baseline');parser.add_argument('workspace');parser.add_argument('writes');parser.add_argument('--manifest')
            args=parser.parse_args();verify_tree(args.baseline,args.workspace,read_json(args.writes),fixture_scopes(read_json(args.manifest)) if args.manifest else [])
        else:
            parser=argparse.ArgumentParser();parser.add_argument('source');parser.add_argument('destination');parser.add_argument('manifest')
            args=parser.parse_args();snapshot(args.source,args.destination,read_json(args.manifest))
    except (ValueError,OSError) as error:
        print('Snapshot validation failed: '+str(error),file=sys.stderr);sys.exit(2)
