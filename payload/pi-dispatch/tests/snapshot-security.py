import importlib.util, pathlib, tempfile, unittest, json, os, sys, subprocess, shutil, base64
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('snapshot',pathlib.Path(__file__).parents[1]/'scripts'/'snapshot-scope.py')
mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
class SnapshotTests(unittest.TestCase):
    def test_only_admitted_regular_files_are_copied(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir()
            for name in ['allowed.txt','outside.txt','.env','.pi-lsp.json']: (src/name).write_text('DUMMY')
            mod.snapshot(str(src),str(dst),{'read':['allowed.txt'],'write':[]})
            self.assertEqual([p.name for p in dst.iterdir()],['allowed.txt'])
    def test_explicit_secrets_and_traversal_are_rejected(self):
        for name in ['../escape','.env','.pi-lsp.json','private.key','anthropic-api-key.json','nested/ANTHROPIC-API-KEY.JSON','provider-config.json','provider-credentials.json','nested/PROVIDER-CREDENTIALS.JSON']:
            with self.assertRaises(ValueError): mod.compile_scope([name])
    def test_binary_changes_outside_scope_are_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            a=pathlib.Path(t,'a');b=pathlib.Path(t,'b');a.mkdir();b.mkdir()
            (a/'outside.bin').write_bytes(b'\0before');(b/'outside.bin').write_bytes(b'\0after')
            with self.assertRaises(ValueError):mod.verify_tree(str(a),str(b),['allowed.txt'])
    def test_missing_write_parents_are_created_without_changing_source(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir()
            original=src/'keep';original.write_text('source')
            mod.snapshot(str(src),str(dst),{'read':[],'write':['nested/new/file.txt']})
            self.assertTrue((dst/'nested/new').is_dir())
            (dst/'nested/new/file.txt').write_text('writable')
            self.assertEqual(original.read_text(),'source')
            self.assertFalse((src/'nested').exists())
    def test_tree_write_creates_root_and_readonly_scope_does_not(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir()
            mod.snapshot(str(src),str(dst),{'read':['readonly/new.txt'],'write':['tree/**']})
            self.assertTrue((dst/'tree').is_dir())
            self.assertFalse((dst/'readonly').exists())
    def test_unsafe_write_paths_and_symlink_destination_ancestor_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');outside=pathlib.Path(t,'outside')
            src.mkdir();dst.mkdir();outside.mkdir()
            for target in ['../secrets/file','/'.join(['d']*65+['file'])]:
                with self.assertRaises(ValueError): mod.snapshot(str(src),str(dst),{'read':[],'write':[target]})
            (dst/'link').symlink_to(outside,target_is_directory=True)
            with self.assertRaises((ValueError,OSError)):
                mod.snapshot(str(src),str(dst),{'read':[],'write':['link/escaped/file']})
            self.assertFalse((outside/'escaped').exists())
    def test_source_open_failure_closes_destination_fd(self):
        if not pathlib.Path('/proc/self/fd').is_dir(): self.skipTest('Linux proc fd count unavailable')
        with tempfile.TemporaryDirectory() as t:
            dst=pathlib.Path(t,'dst');dst.mkdir()
            before=len(list(pathlib.Path('/proc/self/fd').iterdir()))
            for _ in range(5):
                with self.assertRaises(OSError): mod.snapshot(str(pathlib.Path(t,'missing')),str(dst),{'read':[],'write':[]})
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())),before)
    def test_successful_snapshots_do_not_leak_file_descriptors(self):
        if not pathlib.Path('/proc/self/fd').is_dir(): self.skipTest('Linux proc fd count unavailable')
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir()
            before=len(list(pathlib.Path('/proc/self/fd').iterdir()))
            for _ in range(5):
                mod.snapshot(str(src),str(dst),{'read':[],'write':[]})
            self.assertEqual(len(list(pathlib.Path('/proc/self/fd').iterdir())),before)
    def test_copy_and_write_parent_creation_share_directory_budget(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir()
            (src/'read-parent').mkdir();(src/'read-parent'/'read').write_text('input')
            with patch.object(mod,'MAX_CREATED_DIRS',1):
                with self.assertRaisesRegex(ValueError,'directory creation limit'):
                    mod.snapshot(str(src),str(dst),{'read':['read-parent/read'], 'write':['write-parent/file']})
            self.assertTrue((dst/'read-parent'/'read').exists())
            self.assertFalse((dst/'write-parent').exists())
    def test_write_rejects_source_symlink_ancestor(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');outside=pathlib.Path(t,'outside')
            src.mkdir();dst.mkdir();outside.mkdir();(src/'link').symlink_to(outside,target_is_directory=True)
            with self.assertRaises(ValueError): mod.snapshot(str(src),str(dst),{'read':[],'write':['link/new/file']})
            self.assertFalse((dst/'link').exists())
            self.assertFalse((outside/'new').exists())
    def test_size_limit_fails_before_copying_large_file(self):
        with tempfile.TemporaryDirectory() as t:
            a=pathlib.Path(t,'a');b=pathlib.Path(t,'b');a.mkdir();b.mkdir()
            with open(a/'large','wb') as f:f.truncate(mod.MAX_BYTES+1)
            with self.assertRaises(ValueError):mod.snapshot(str(a),str(b),{'read':['large'],'write':[]})
    def test_fixture_validation_and_source_links_fail_closed(self):
        for value in [None,['a/*'],['a/**/b'],['a?'],['/a'],['../a'],['a\\b'],['a:ads'],['con.txt'],['x.'],['x '],['SHORT~1'],['e\u0301'],['a\x7f'],['.env'],['A','a'],['a/**','a/b'],['.PI/auth.json']]:
            with self.assertRaises(ValueError):mod.fixture_scopes({'write':[],'fixtures':value})
        for fixtures,writes in [(['a/**'],['a/b']),(['a/b'],['a/**']),(['a'],['A'])]:
            with self.assertRaises(ValueError):mod.fixture_scopes({'write':writes,'fixtures':fixtures})
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');dst=pathlib.Path(t,'dst');src.mkdir();dst.mkdir();(src/'input').write_text('sample')
            os.link(src/'input',src/'hard');(src/'link').symlink_to(src/'input')
            for name in ['missing','hard','link','input/**']:
                with self.assertRaises((ValueError,OSError)):mod.snapshot(str(src),str(dst),{'read':[],'write':[],'fixtures':[name]})
    def test_final_verify_independently_rejects_fixture_mutation_and_parent_rename(self):
        with tempfile.TemporaryDirectory() as t:
            a=pathlib.Path(t,'a');b=pathlib.Path(t,'b');a.mkdir();b.mkdir();(a/'parent').mkdir();(a/'parent'/'samples').mkdir();(a/'parent'/'samples'/'empty').mkdir();(a/'parent'/'samples'/'input').write_text('sample')
            manifest={'read':[],'write':['new/output.txt'],'fixtures':['parent/samples/**']}
            mod.snapshot(str(a),str(b),manifest);fixtures=mod.fixture_scopes(manifest)
            mod.verify_tree(str(a),str(b),manifest['write'],fixtures)
            (b/'parent'/'samples'/'input').write_text('tampered')
            with self.assertRaises(ValueError):mod.verify_tree(str(a),str(b),manifest['write'],fixtures)
            (b/'parent'/'samples'/'input').write_text('sample');(b/'parent').rename(b/'renamed')
            with self.assertRaises(ValueError):mod.verify_tree(str(a),str(b),manifest['write'],fixtures)
            self.assertEqual((a/'parent'/'samples'/'input').read_text(),'sample')
    def test_fixture_tree_filters_credentials_and_rejects_unsafe_descendants(self):
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');src.mkdir();samples=src/'samples';samples.mkdir();(samples/'input').write_text('benign')
            for secret in ['.env','credentials.json','private.key']:(samples/secret).write_text('PRIVATE_SAMPLE')
            dst=pathlib.Path(t,'dst');dst.mkdir();manifest={'read':[],'write':[],'fixtures':['samples/**']}
            mod.snapshot(str(src),str(dst),manifest)
            self.assertEqual([p.name for p in (dst/'samples').iterdir()],['input'])
            for kind in ['symlink','hardlink','fifo']:
                bad=samples/'unsafe'
                if kind=='symlink':bad.symlink_to(samples/'input')
                elif kind=='hardlink':os.link(samples/'input',bad)
                else:os.mkfifo(bad)
                target=pathlib.Path(t,kind);target.mkdir()
                try:
                    with self.assertRaises(ValueError):mod.snapshot(str(src),str(target),manifest)
                finally:bad.unlink()
    def test_fixture_grammar_matches_real_node_shared_vectors(self):
        encoded=os.environ.get('YHWH_FIXTURE_VECTORS_B64')
        if not encoded:self.skipTest('Host Node-produced grammar vectors required')
        for item in json.loads(base64.b64decode(encoded).decode('utf-8')):
            try:mod.fixture_scopes({'write':item['writes'],'fixtures':item['values']});accepted=True
            except ValueError:accepted=False
            self.assertEqual(accepted,item['accepted'],repr(item['values']))
    def test_fixture_grammar_obeys_committed_vectors_and_utf16_bounds(self):
        with open(pathlib.Path(__file__).with_name('fixture-scope-vectors.json'),encoding='utf-8') as f:vectors=json.load(f)
        vectors+=[{'values':['😀'*2000],'writes':[],'accepted':True},{'values':['😀'*2001],'writes':[],'accepted':False}]
        for item in vectors:
            try:mod.fixture_scopes({'write':item['writes'],'fixtures':item['values']});accepted=True
            except ValueError:accepted=False
            self.assertEqual(accepted,item['accepted'],repr(item['values']))
    def test_native_readonly_binds_from_real_node_manifest(self):
        if not shutil.which('bwrap'): self.skipTest('Native bubblewrap unavailable')
        encoded=os.environ.get('YHWH_SCOPE_B64')
        if not encoded: self.skipTest('Host Node-produced manifest required')
        manifest=json.loads(base64.b64decode(encoded).decode('utf-8'))
        self.assertEqual(manifest,{'read':[],'write':['new/output.txt'],'fixtures':['parent/samples/**']})
        with tempfile.TemporaryDirectory() as t:
            src=pathlib.Path(t,'src');work=pathlib.Path(t,'workspace');src.mkdir();work.mkdir();(src/'parent').mkdir();(src/'parent'/'samples').mkdir();(src/'parent'/'samples'/'input.txt').write_text('native sample')
            mod.snapshot(str(src),str(work),manifest)
            self.assertNotEqual((src/'parent/samples/input.txt').stat().st_ino,(work/'parent/samples/input.txt').stat().st_ino)
            output=pathlib.Path(t,'bindings.bin');manifest_path=pathlib.Path(t,'manifest.json');manifest_path.write_text(json.dumps(manifest),encoding='utf-8')
            producer=subprocess.run([sys.executable,mod.__file__,'--fixture-bindings','--workspace',str(work),'--manifest',str(manifest_path),'--output',str(output)],capture_output=True,text=True,timeout=10)
            self.assertEqual(producer.returncode,0,producer.stderr)
            self.assertEqual(output.stat().st_mode&0o777,0o600)
            bindings=[os.fsdecode(x) for x in output.read_bytes().split(b'\0')[:-1]]
            self.assertEqual(bindings,['--ro-bind',str(work/'parent/samples'),'/workspace/parent/samples'])
            # No write hook here: the kernel mount is an independent security boundary.
            script="""import os,pathlib,json
p=pathlib.Path('/workspace/parent/samples'); f=p/'input.txt'
assert f.read_text()=='native sample'
denied=[]
for name,fn in [('write',lambda:f.write_text('bad')),('create',lambda:(p/'new').write_text('bad')),('truncate',lambda:os.truncate(f,0)),('chmod',lambda:os.chmod(f,0o777)),('rename',lambda:f.rename(p/'renamed')),('delete',lambda:f.unlink()),('mkdir',lambda:(p/'new-dir').mkdir())]:
 try: fn()
 except OSError: denied.append(name)
 else: raise AssertionError('readonly operation succeeded: '+name)
pathlib.Path('/workspace/new/output.txt').write_text('allowed')
try:
 pathlib.Path('/workspace/parent').rename('/workspace/moved'); parent_rename=True
except OSError: parent_rename=False
print(json.dumps({'denied':denied,'parentRenameAllowed':parent_rename}))
"""
            result=subprocess.run(['bwrap','--unshare-all','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(work),'/workspace',*bindings,'--','/usr/bin/python3','-c',script],capture_output=True,text=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr)
            observed=json.loads(result.stdout)
            self.assertEqual(observed['denied'],['write','create','truncate','chmod','rename','delete','mkdir'])
            self.assertEqual((work/'new/output.txt').read_text(),'allowed');self.assertEqual((src/'parent/samples/input.txt').read_text(),'native sample')
            # A parent rename may be allowed by the kernel; final inventory must reject it.
            if observed['parentRenameAllowed']:
                with self.assertRaises(ValueError):mod.verify_tree(str(src),str(work),manifest['write'],mod.fixture_scopes(manifest))
            else:mod.verify_tree(str(src),str(work),manifest['write'],mod.fixture_scopes(manifest))
    def test_binding_cli_uses_named_arguments_and_cleans_up_failed_output(self):
        with tempfile.TemporaryDirectory() as t:
            workspace=pathlib.Path(t,'workspace');workspace.mkdir();manifest=pathlib.Path(t,'manifest.json');manifest.write_text(json.dumps({'read':[],'write':[],'fixtures':['missing']}))
            output=pathlib.Path(t,'bindings.bin')
            result=subprocess.run([sys.executable,str(pathlib.Path(mod.__file__)),'--fixture-bindings','--workspace',str(workspace),'--manifest',str(manifest),'--output',str(output)],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,2);self.assertFalse(output.exists());manifest.rename(pathlib.Path(t,'renamed.json'))
            manifest.write_text('{broken',encoding='utf-8')
            args=[sys.executable,mod.__file__,'--fixture-bindings','--workspace',str(workspace),'--manifest',str(manifest),'--output',str(output)]
            for tail in [[],['--unknown'],['--workspace']]:
                result=subprocess.run(args+tail,capture_output=True,text=True,timeout=10)
                self.assertEqual(result.returncode,2);self.assertFalse(output.exists())
if __name__=='__main__':unittest.main()
