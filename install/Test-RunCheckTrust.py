#!/usr/bin/python3
"""Linux/root installer regression tests; fixtures never use production trust."""
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('trust_installer', HERE / 'provision-run-check-trust.py')
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)


@unittest.skipUnless(os.geteuid() == 0, 'requires a Linux root-owned fixture')
class ReinstallTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='yhwh-trust-test-', dir='/var/lib'))
        self.root = str(self.base / 'trust')
        self.manifest = self.base / 'trust/manifest.json'
        trust.provision(self.root, '/usr/bin/true')
        self.cache = self.base / 'trust/caches/project'
        self.cache.mkdir()
        # Deliberately non-sorted order, including case and Unicode directory names.
        (self.cache / 'z').write_bytes(b'lockfile-pinned dependency')
        (self.cache / 'A').mkdir()
        (self.cache / 'A/依赖').write_bytes(b'another dependency')
        value = json.loads(self.manifest.read_bytes())
        value['caches'].append({'id': 'project', 'path': str(self.cache),
            'files': [{'path': p, 'sha256': hashlib.sha256((self.cache / p).read_bytes()).hexdigest()}
                      for p in ('z', 'A/依赖')],
            'projectFiles': [{'path': 'payload/package-lock.json', 'sha256': 'a' * 64}]})
        self.write(value)
        self.value = value
        self.before = self.manifest.read_bytes()

    def tearDown(self):
        # This exact mkdtemp child is the only recursive removal target.
        self.assertEqual(self.base.parent, Path('/var/lib'))
        self.assertTrue(self.base.name.startswith('yhwh-trust-test-'))
        shutil.rmtree(self.base)

    def write(self, value):
        self.manifest.write_text(json.dumps(value, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')

    def reject(self):
        before = self.manifest.read_bytes()
        with self.assertRaises((ValueError, OSError)):
            trust.provision(self.root, '/usr/bin/false')
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual((Path(self.root) / 'runners/node').read_bytes(), Path('/usr/bin/true').read_bytes())
        self.assertEqual(list(Path(self.root).glob('.provision-*')), [])

    def test_first_install(self):
        other = str(self.base / 'fresh')
        self.assertTrue(trust.provision(other, '/usr/bin/true')['ok'])
        value = json.loads((Path(other) / 'manifest.json').read_bytes())
        self.assertEqual([c['id'] for c in value['caches']], ['empty'])
        self.assertEqual(value['runners'][0]['sha256'], hashlib.sha256(Path('/usr/bin/true').read_bytes()).hexdigest())
        self.assertEqual((Path(other) / 'manifest.json').stat().st_mode & 0o777, 0o644)

    def test_archive_ownership_uses_exact_installer_extraction_flags(self):
        version = subprocess.run(['/usr/bin/tar', '--version'], capture_output=True, text=True, timeout=5)
        if version.returncode != 0 or 'GNU tar' not in version.stdout:
            self.skipTest('requires GNU tar')
        archive = self.base / 'node.tar.xz'
        with tarfile.open(archive, 'w:xz') as out:
            for name in ('node-v-test', 'node-v-test/bin'):
                info = tarfile.TarInfo(name)
                info.type, info.uid, info.gid, info.mode = tarfile.DIRTYPE, 1000, 1000, 0o777
                out.addfile(info)
            info = out.gettarinfo('/usr/bin/true', arcname='node-v-test/bin/node')
            info.uid, info.gid, info.mode = 1000, 1000, 0o777
            with open('/usr/bin/true', 'rb') as source:
                out.addfile(info, source)
        shell = (HERE / 'provision-wsl.sh').read_text()
        line = next(line for line in shell.splitlines() if line.startswith('(umask 022; tar '))
        args = shlex.split(line[len('(umask 022; '):-1])
        self.assertEqual(args[0], 'tar')
        self.assertIn('install -d -o root -g root -m 0755 /opt/node.new', shell)
        for safe in (False, True):
            dest = self.base / ('safe-extraction' if safe else 'old-extraction')
            dest.mkdir(mode=0o755)
            actual = [str(archive) if a == '$tmp/$node_archive' else str(dest) if a == '/opt/node.new'
                      else a for a in args[1:]]
            if not safe:
                actual = [a for a in actual if a not in ('--no-same-owner', '--no-same-permissions')]
            subprocess.run(['/usr/bin/tar', *actual], check=True, timeout=5,
                           preexec_fn=lambda: os.umask(0o022), capture_output=True)
            runner = str(dest / 'bin/node')
            if safe:
                for file in (dest, dest / 'bin', dest / 'bin/node'):
                    self.assertEqual((file.stat().st_uid, file.stat().st_gid, file.stat().st_mode & 0o777), (0, 0, 0o755))
                self.assertTrue(trust.provision(str(self.base / 'archive-trust'), runner)['ok'])
            else:
                with self.assertRaisesRegex(ValueError, 'ownership or permissions'):
                    trust.provision(str(self.base / 'unsafe-archive-trust'), runner)

    def test_reinstall_preserves_entries_and_is_idempotent(self):
        cache_before = {str(p.relative_to(self.cache)): p.read_bytes() for p in self.cache.rglob('*') if p.is_file()}
        for _ in range(2):
            result = trust.provision(self.root, '/usr/bin/true')
            self.assertEqual(result['cachesPreserved'], 2)
            self.assertEqual(self.manifest.read_bytes(), self.before)
        self.assertEqual(cache_before, {str(p.relative_to(self.cache)): p.read_bytes() for p in self.cache.rglob('*') if p.is_file()})

    def test_refresh_runner_does_not_repin_caches(self):
        trust.provision(self.root, '/usr/bin/false')
        value = json.loads(self.manifest.read_bytes())
        self.assertEqual(value['caches'], self.value['caches'])
        self.assertEqual(value['runners'][0]['sha256'], hashlib.sha256(Path('/usr/bin/false').read_bytes()).hexdigest())

    def test_missing_and_extra_file(self):
        for action in ('missing', 'extra'):
            with self.subTest(action=action):
                if action == 'missing':
                    (self.cache / 'z').unlink()
                else:
                    (self.cache / 'z').write_bytes(b'lockfile-pinned dependency')
                    (self.cache / 'extra').write_bytes(b'unpinned')
                self.reject()

    def test_cache_hash_drift(self):
        (self.cache / 'z').write_bytes(b'changed without authorization')
        self.reject()

    def test_symlinks(self):
        for target in ('cache', 'manifest', 'runner', 'lock'):
            with self.subTest(target=target):
                file = {'cache': self.cache / 'z', 'manifest': self.manifest,
                        'runner': Path(self.root) / 'runners/node', 'lock': Path(self.root) / '.provision.lock'}[target]
                original = file.read_bytes()
                mode = file.stat().st_mode & 0o777
                file.unlink()
                file.symlink_to('/usr/bin/true')
                with self.assertRaises((ValueError, OSError)):
                    trust.provision(self.root, '/usr/bin/true')
                file.unlink()
                file.write_bytes(original)
                file.chmod(mode)
                self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_hardlinks(self):
        for target in ('cache', 'manifest', 'runner', 'lock'):
            with self.subTest(target=target):
                file = {'cache': self.cache / 'z', 'manifest': self.manifest,
                        'runner': Path(self.root) / 'runners/node', 'lock': Path(self.root) / '.provision.lock'}[target]
                link = self.base / 'hardlink'
                os.link(file, link)
                self.reject()
                link.unlink()

    def test_unsafe_permissions_and_ownership(self):
        for file in (self.cache, self.cache / 'z', self.manifest, Path(self.root) / '.provision.lock', self.base):
            for bad in ('write', 'owner'):
                with self.subTest(path=file.name, bad=bad):
                    original = file.stat().st_mode & 0o777
                    if bad == 'write':
                        file.chmod(original | 0o020)
                    else:
                        os.chown(file, 65534, 0)
                    self.reject()
                    file.chmod(original)
                    os.chown(file, 0, 0)

    def test_invalid_schema_traversal_duplicate_and_limits(self):
        mutations = [lambda v: v.update(version=True), lambda v: v.update(extra=1),
            lambda v: v['caches'].append(copy.deepcopy(v['caches'][1])),
            lambda v: v['caches'][1].update(path=self.root + '/caches/../project'),
            lambda v: v['caches'][1]['files'][0].update(path='../outside'),
            lambda v: v['caches'][1]['files'][0].update(sha256='bad'),
            lambda v: v['caches'][1]['projectFiles'][0].update(path='/etc/shadow'),
            lambda v: v['caches'][1]['files'].append(copy.deepcopy(v['caches'][1]['files'][0])),
            lambda v: v['caches'][1].update(projectFiles=[v['caches'][1]['projectFiles'][0]] * 17),
            lambda v: v['caches'][1].update(files=[v['caches'][1]['files'][0]] * 32769),
            lambda v: v.update(caches=[v['caches'][0]] * 65),
            lambda v: v['runners'][0].update(path='/etc/shadow'),
            lambda v: v['caches'].pop(0)]
        for mutate in mutations:
            value = copy.deepcopy(self.value)
            mutate(value)
            self.write(value)
            self.reject()

    def test_invalid_json_duplicate_keys_and_size(self):
        for raw in (b'{', b'{"version":1,"version":1}', b' ' * (trust.MAX_MANIFEST + 1)):
            self.manifest.write_bytes(raw)
            self.reject()

    def test_nonempty_empty_cache(self):
        (Path(self.root) / 'caches/empty/unregistered').mkdir()
        self.reject()

    def test_missing_manifest_does_not_import_orphan_cache(self):
        self.manifest.unlink()
        with self.assertRaisesRegex(ValueError, 'unregistered caches'):
            trust.provision(self.root, '/usr/bin/false')
        self.assertFalse(self.manifest.exists())
        self.assertTrue((self.cache / 'z').is_file())

    def test_sparse_oversize_cache_file(self):
        with (self.cache / 'z').open('wb') as out:
            out.truncate(64 * 1024 * 1024 + 1)
        self.reject()

    def test_staging_write_failure_preserves_old_state_and_cleans_temps(self):
        real = trust.stage
        calls = 0
        def fail_second(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('simulated manifest staging disk failure')
            return real(*args)
        with patch.object(trust, 'stage', fail_second):
            self.reject()

    def test_recovery_after_two_file_publication_failure(self):
        real = trust.os.replace
        def fail_manifest(source, dest):
            if dest == str(self.manifest):
                raise OSError('simulated crash after runner publication')
            return real(source, dest)
        with patch.object(trust.os, 'replace', fail_manifest):
            with self.assertRaises(OSError):
                trust.provision(self.root, '/usr/bin/false')
        self.assertEqual(self.manifest.read_bytes(), self.before)
        self.assertEqual(list(Path(self.root).glob('.provision-*')), [])
        trust.provision(self.root, '/usr/bin/false')
        self.assertEqual(json.loads(self.manifest.read_bytes())['caches'], self.value['caches'])

    def test_cli_cannot_select_another_trust_root(self):
        result = subprocess.run(['/usr/bin/python3', str(HERE / 'provision-run-check-trust.py'), self.root],
                                capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'no command-line arguments', result.stderr)
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_concurrent_provisioning_times_out_without_writes(self):
        with (Path(self.root) / '.provision.lock').open('rb') as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            program = ("import importlib.util; s=importlib.util.spec_from_file_location('t', "
                       + repr(str(HERE / 'provision-run-check-trust.py'))
                       + "); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
                       + "m.LOCK_WAIT_SECONDS=0.1;m.provision(" + repr(self.root) + ",'/usr/bin/false')")
            result = subprocess.run(['/usr/bin/python3', '-c', program], capture_output=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'lock timeout', result.stderr)
        self.assertEqual(self.manifest.read_bytes(), self.before)

    def test_installer_wiring_has_no_reset(self):
        shell = (HERE / 'provision-wsl.sh').read_text()
        installer = (HERE / 'Install-PiKether.ps1').read_text()
        self.assertIn('/usr/bin/python3 /tmp/pi-kether-install/provision-run-check-trust.py', shell)
        self.assertNotIn("'caches':[{'id':'empty'", shell)
        self.assertIn("'install\\provision-run-check-trust.py')='/tmp/pi-kether-install/provision-run-check-trust.py'", installer)


if __name__ == '__main__':
    unittest.main(verbosity=2)
