import importlib.util, pathlib, tempfile, unittest, json, os
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
    def test_size_limit_fails_before_copying_large_file(self):
        with tempfile.TemporaryDirectory() as t:
            a=pathlib.Path(t,'a');b=pathlib.Path(t,'b');a.mkdir();b.mkdir()
            with open(a/'large','wb') as f:f.truncate(mod.MAX_BYTES+1)
            with self.assertRaises(ValueError):mod.snapshot(str(a),str(b),{'read':['large'],'write':[]})
if __name__=='__main__':unittest.main()
