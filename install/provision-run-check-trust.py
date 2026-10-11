#!/usr/bin/python3
"""Root installer only: refresh Node, preserve independently authorized caches."""
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
import time

ROOT = '/var/lib/pi-kether-run-check/trust'
MAX_MANIFEST = 1048576
LOCK_WAIT_SECONDS = 30


def require(ok, reason):
    if not ok:
        raise ValueError('RUN_CHECK_TRUST: ' + reason)


def trusted(path, directory=False):
    require(os.geteuid() == 0 and os.path.isabs(path)
            and not path.startswith('/mnt/') and '\x00' not in path
            and all(p not in ('.', '..') for p in path.split('/')), 'path')
    current = ''
    for part in path.split('/')[1:]:
        require(bool(part), 'path segment')
        current += '/' + part
        s = os.lstat(current)
        require(s.st_uid == 0 and not s.st_mode & 0o022
                and not stat.S_ISLNK(s.st_mode), 'ownership or permissions')
    require(stat.S_ISDIR(s.st_mode) if directory else
            stat.S_ISREG(s.st_mode) and s.st_nlink == 1, 'type or hardlink')
    return s


def mkdir(path):
    trusted(os.path.dirname(path), True)
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        pass
    trusted(path, True)


def read_file(path, limit, content=False):
    before = trusted(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        s = os.fstat(stream.fileno())
        require((s.st_dev, s.st_ino) == (before.st_dev, before.st_ino)
                and stat.S_ISREG(s.st_mode) and s.st_uid == 0
                and not s.st_mode & 0o022 and s.st_nlink == 1
                and s.st_size <= limit, 'file bounds or identity')
        digest, chunks, size = hashlib.sha256(), [], 0
        while chunk := stream.read(65536):
            size += len(chunk)
            require(size <= limit, 'file size')
            digest.update(chunk)
            if content:
                chunks.append(chunk)
        after = os.fstat(stream.fileno())
        require((s.st_size, s.st_mtime_ns, s.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'file changed')
    return (b''.join(chunks) if content else digest.hexdigest()), size


def exact(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def ident(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value)


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)


def relative(value):
    return (isinstance(value, str) and len(value) <= 1024
            and not re.search(r'[\\:\x00-\x1f\x7f]', value)
            and all(p not in ('', '.', '..') for p in value.split('/')))


def pins(value, maximum):
    require(isinstance(value, list) and len(value) <= maximum, 'pin count')
    require(all(exact(p, ('path', 'sha256')) and relative(p['path'])
                and digest(p['sha256']) for p in value), 'pin schema')
    require(len({p['path'] for p in value}) == len(value), 'duplicate pin')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def validate_manifest(value, root):
    require(exact(value, ('version', 'runners', 'caches'))
            and type(value['version']) is int and value['version'] == 1, 'schema')
    runners, caches = value['runners'], value['caches']
    require(isinstance(runners, list) and len(runners) == 1, 'runners')
    r = runners[0]
    require(exact(r, ('id', 'path', 'sha256')) and r['id'] == 'node'
            and r['path'] == root + '/runners/node' and digest(r['sha256']), 'runner')
    require(isinstance(caches, list) and 1 <= len(caches) <= 64, 'caches')
    ids = set()
    for c in caches:
        require(exact(c, ('id', 'path', 'files', 'projectFiles')) and ident(c['id'])
                and c['id'] not in ids and c['path'] == root + '/caches/' + c['id'], 'cache')
        ids.add(c['id'])
        pins(c['files'], 32768)
        pins(c['projectFiles'], 16)
        trusted(c['path'], True)
        actual, total, entries = {}, 0, 0

        def walk(base, prefix=''):
            nonlocal total, entries
            require(prefix.count('/') <= 64, 'cache depth')
            # Ordering is deliberately irrelevant to validation. Keep original JSON order.
            with os.scandir(base) as children:
                for entry in children:
                    rel = prefix + entry.name
                    entries += 1
                    require(entries <= 65536, 'cache entry count')
                    require(relative(rel), 'cache filename')
                    if entry.is_dir(follow_symlinks=False):
                        trusted(entry.path, True)
                        walk(entry.path, rel + '/')
                    else:
                        require(len(actual) < 32768, 'cache file count')
                        h, size = read_file(entry.path, 64 * 1024 * 1024)
                        total += size
                        require(total <= 512 * 1024 * 1024, 'cache total size')
                        actual[rel] = h
        walk(c['path'])
        require(actual == {p['path']: p['sha256'] for p in c['files']}, 'cache drift')
        if c['id'] == 'empty':
            require(c['files'] == [] and c['projectFiles'] == []
                    and not os.listdir(c['path']), 'empty cache')
    require('empty' in ids, 'missing empty registration')


def validate_libraries(runner):
    output = subprocess.run(['/usr/bin/ldd', runner], check=True, capture_output=True,
                            text=True, timeout=5, env={'PATH': '/usr/bin:/bin'}).stdout
    require(len(output) <= 65536 and 'not found' not in output, 'runner libraries')
    for entry in re.findall(r'/[A-Za-z0-9_./+-]+', output):
        trusted(os.path.realpath(entry))


def stage(root, data, mode):
    fd, name = tempfile.mkstemp(prefix='.provision-', dir=root)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
        return name
    except BaseException:
        os.unlink(name)
        raise


def provision(root=ROOT, source='/opt/node/bin/node'):
    # Parameters are an internal test seam. The executable accepts no parameters.
    trusted(os.path.dirname(os.path.dirname(root)), True)
    mkdir(os.path.dirname(root))
    mkdir(root)
    lock_fd = os.open(root + '/.provision.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
                      | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock_fd, 'rb') as lock:
        s = os.fstat(lock.fileno())
        require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and s.st_nlink == 1
                and not s.st_mode & 0o022, 'lock identity')
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                require(time.monotonic() < deadline, 'lock timeout')
                time.sleep(0.05)
        trusted(root, True)
        for suffix in ('runners', 'caches', 'caches/empty'):
            mkdir(root + '/' + suffix)
        manifest_path = root + '/manifest.json'
        if os.path.lexists(manifest_path):
            raw, _ = read_file(manifest_path, MAX_MANIFEST, True)
            manifest = json.loads(raw, object_pairs_hook=unique_object)
        else:
            require(os.listdir(root + '/caches') == ['empty'], 'unregistered caches')
            manifest = {'version': 1, 'runners': [{'id': 'node', 'path': root + '/runners/node',
                        'sha256': '0' * 64}], 'caches': [{'id': 'empty',
                        'path': root + '/caches/empty', 'files': [], 'projectFiles': []}]}
        validate_manifest(manifest, root)
        # Validate installed destination too; never follow an old link or device.
        if os.path.lexists(root + '/runners/node'):
            trusted(root + '/runners/node')
        runner, _ = read_file(source, 128 * 1024 * 1024, True)
        validate_libraries(source)
        manifest['runners'][0]['sha256'] = hashlib.sha256(runner).hexdigest()
        data = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        require(len(data) <= MAX_MANIFEST, 'manifest output size')
        staged = []
        try:
            runner_tmp = stage(root, runner, 0o755)
            staged.append(runner_tmp)
            manifest_tmp = stage(root, data, 0o644)
            staged.append(manifest_tmp)
            os.replace(runner_tmp, root + '/runners/node')
            os.replace(manifest_tmp, manifest_path)
            directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            for name in staged:
                if os.path.lexists(name):
                    os.unlink(name)
        return {'ok': True, 'cachesPreserved': len(manifest['caches']),
                'runnerSha256': manifest['runners'][0]['sha256']}


if __name__ == '__main__':
    import sys
    require(len(sys.argv) == 1, 'no command-line arguments allowed')
    print(json.dumps(provision(), separators=(',', ':')))
