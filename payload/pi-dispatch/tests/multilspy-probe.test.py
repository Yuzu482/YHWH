# SPDX-License-Identifier: Apache-2.0
import asyncio
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("yhwh_multilspy", Path(__file__).parent.parent / "scripts/multilspy-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
fixture = Path(__file__).with_name("multilspy-server-fixture.py")


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="yhwh-lsp-test-")
        self.root = Path(self.temp.name)
        self.file = self.root / "file.py"
        self.file.write_text('answer: int = "wrong"\n', encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_go_and_rust_exit_is_bounded(self):
        for language, suffix in [('go','.go'),('rust','.rs')]:
            self.file = self.root / ('file'+suffix)
            self.file.write_text('')
            result = asyncio.run(probe.execute({'tool':'lsp_hover','params':{'path':str(self.file),'line':1,'character':1}},
                root=self.root,commands={language:[sys.executable,'-c','raise SystemExit(9)']},timeout=3))
            self.assertEqual(result['reason'],'language-server-exited')
            self.assertTrue(result['serverCleanup']['ok'])

    def test_rust_compiler_utf16_and_failure_evidence(self):
        text='// 🦀\nlet a = "🦀"; bad'
        start=len(text[:text.index('bad')].encode())
        item={'$message_type':'diagnostic','level':'error','message':'bad','code':{'code':'E0308'},
              'spans':[{'is_primary':True,'file_name':str(self.file),'byte_start':start,'byte_end':start+3}]}
        data=probe.rust_diagnostics(json.dumps(item),self.file,text,1)
        self.assertEqual(data[0]['range']['start'],{'line':1,'character':14})
        for raw,code in [('',1),('',9),(json.dumps(item),0)]:
            with self.assertRaises(probe.ProbeError):probe.rust_diagnostics(raw,self.file,text,code)

    def test_rust_empty_publication_requires_completed_compiler(self):
        self.file=self.root/'file.rs';self.file.write_text('fn broken() {}')
        for complete in (True,False):
            async def compiler(file,text,evidence):
                await asyncio.sleep(0.03)
                evidence['compilerCleanup']=True
                if not complete:raise probe.ProbeError('rust-compiler-diagnostics-incomplete','unavailable')
                return [{'code':'E0308','severity':1}]
            with patch.object(probe,'rust_compiler_diagnostics',compiler):
                result=asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
                    root=self.root,commands={'rust':[sys.executable,str(fixture),'clean']},timeout=3))
            self.assertTrue(result['diagnosticsPublished'])
            self.assertEqual(result['ok'],complete)
            self.assertEqual(result['diagnosticCompletion']['complete'],complete)
            self.assertTrue(result['serverCleanup']['ok'])
            if complete:self.assertEqual(result['result']['details']['data'][0]['code'],'E0308')

    def test_rust_compiler_cancellation_and_output_limit_cleanup(self):
        async def check(mode):
            evidence={};created=[];real=asyncio.create_subprocess_exec
            async def launch(*args,**kwargs):
                code='import time;time.sleep(30)' if mode=='timeout' else 'import os,time;os.write(2,b"x"*2200000);time.sleep(30)'
                process=await real(sys.executable,'-c',code,**kwargs);created.append(process);return process
            with patch.object(probe.asyncio,'create_subprocess_exec',launch):
                with self.assertRaises((TimeoutError,probe.ProbeError)):
                    await asyncio.wait_for(probe.rust_compiler_diagnostics(self.file,'',evidence),0.2 if mode=='timeout' else 3)
            self.assertTrue(evidence['compilerCleanup']);self.assertIsNotNone(created[0].returncode)
        for mode in ('timeout','output'):asyncio.run(check(mode))

    def test_go_pull_requires_full_response_and_publication(self):
        self.file=self.root/'file.go';self.file.write_text('package p')
        for mode,ok in [('go-full',True),('go-empty-kind',True),('go-unchanged',False),('go-no-diagnostics',False)]:
            result=asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
                root=self.root,commands={'go':[sys.executable,str(fixture),mode]},timeout=3,diagnostic_timeout=0.2))
            self.assertEqual(result['ok'],ok,result);self.assertEqual(result['diagnosticCompletion']['complete'],ok)
            self.assertTrue(result['serverCleanup']['ok'])

    def test_java_server_exit_is_immediate_and_cleaned(self):
        self.file = self.root / 'Sample.java'
        self.file.write_text('class Sample {}')
        result = asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
            root=self.root,commands={'java':[sys.executable,'-c','raise SystemExit(9)']},timeout=3))
        self.assertEqual(result['reason'],'language-server-exited')
        self.assertTrue(result['serverCleanup']['ok'])

    def test_java_non_project_diagnostics_cannot_pass_as_semantic(self):
        self.file = self.root / 'Sample.java'
        self.file.write_text('class Sample {}')
        for code in ('16','32'):
            result = asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
                root=self.root,commands={'java':[sys.executable,str(fixture),'java-non-project-'+code]},timeout=3))
            self.assertFalse(result['ok'])
            self.assertEqual(result['reason'],'java-semantic-diagnostics-unavailable')
            self.assertTrue(result['diagnosticsPublished'])
            self.assertTrue(result['serverCleanup']['ok'])

    def test_java_fixed_settings_and_published_clean_result(self):
        self.file = self.root / 'Sample.java'
        self.file.write_text('class Sample {}')
        result = asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
            root=self.root,commands={'java':[sys.executable,str(fixture),'java-profile']},timeout=3))
        self.assertTrue(result['ok'],result)
        self.assertTrue(result['diagnosticsPublished'])
        self.assertTrue(result['serverCleanup']['ok'])

    def test_csharp_exit_during_initialize_fails_without_request_timeout(self):
        self.file = self.root / 'file.cs'
        self.file.write_text('class A {}')
        result = asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
            root=self.root,commands={'csharp':[sys.executable,'-c','raise SystemExit(9)']},timeout=3))
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'],'language-server-exited')
        self.assertTrue(result['serverCleanup']['ok'])

    def test_csharp_exit_before_publication_fails_without_diagnostic_timeout(self):
        self.file = self.root / 'file.cs'
        self.file.write_text('class A {}')
        result = asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(self.file)}},
            root=self.root,commands={'csharp':[sys.executable,str(fixture),'exit-on-open']},timeout=3))
        self.assertFalse(result['ok'])
        self.assertEqual(result['reason'],'language-server-exited')
        self.assertFalse(result['diagnosticsPublished'])
        self.assertTrue(result['serverCleanup']['ok'])

    def test_clangd_cleanup_drains_large_pipes_and_awaits_exit(self):
        async def check():
            process = await asyncio.create_subprocess_exec(sys.executable, '-c',
                'import os,time; os.write(1,b"x"*200000); os.write(2,b"y"*200000); time.sleep(60)',
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, start_new_session=True)
            handler = probe.ClangdHandler(probe.ProcessLaunchInfo('unused'))
            try:
                await asyncio.sleep(0.1)
                await handler._cleanup_process(process)
                self.assertIsNotNone(process.returncode)
                self.assertTrue(process.stdout.at_eof())
                self.assertTrue(process.stderr.at_eof())
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.communicate()
        asyncio.run(check())

    def test_clangd_cleanup_without_exit_evidence_is_rejected(self):
        from types import SimpleNamespace
        async def check():
            handler = probe.ClangdHandler(probe.ProcessLaunchInfo('unused'))
            process = SimpleNamespace(stdin=None, stdout=None, stderr=None,
                returncode=None, wait=AsyncMock(return_value=None))
            with patch.object(handler, '_signal_process_tree'):
                with self.assertRaises(probe.ProbeError):
                    await handler._cleanup_process(process)
                process.wait.assert_awaited_once()
        asyncio.run(check())

    def test_session_request_limit_allows_final_close_and_rejects_extra_query(self):
        for count in (64, 65):
            read_fd, write_fd = os.pipe()
            query = json.dumps({"tool": "lsp_symbols", "params": {"path": "/workspace/a.ts"}}) + "\n"
            # Stay below the pipe capacity; no background writer is needed.
            with os.fdopen(write_fd, "wb") as output:
                output.write((query * count + '{"close":true}\n').encode())
            capture = io.StringIO()
            with os.fdopen(read_fd, "r") as input_file, patch.object(probe.sys, "stdin", input_file), redirect_stdout(capture), patch.object(probe, "execute", AsyncMock(return_value={"ok": True})) as execute:
                if count == 64:
                    self.assertEqual(asyncio.run(probe.session_main()), 0)
                else:
                    with self.assertRaisesRegex(ValueError, "session-input-limit"):
                        asyncio.run(probe.session_main())
                self.assertEqual(execute.await_count, 64)
            rows = [json.loads(line) for line in capture.getvalue().splitlines()]
            self.assertEqual(len(rows), 65)
            self.assertEqual(rows[-1], {"sessionClosed": True, "serverCleanup": {"ok": True}})

    def test_session_reuses_process_and_reports_pending_cleanup(self):
        async def check():
            session = {}
            request = {"tool": "lsp_hover", "params": {"path": str(self.file), "line": 1, "character": 1}}
            options = dict(root=self.root, commands={"python": [sys.executable, str(fixture), "normal"]}, session=session)
            first = await probe.execute(request, **options)
            process = session["handler"].process
            second = await probe.execute(request, **options)
            self.assertTrue(first["ok"] and second["ok"])
            self.assertFalse(first["serverSession"]["reused"])
            self.assertTrue(second["serverSession"]["reused"])
            self.assertIs(session["handler"].process, process)
            self.assertEqual(first["result"], second["result"])
            self.assertIsNone(second["serverCleanup"]["ok"])
            self.assertTrue(await probe.close_session(session))
            self.assertEqual(session, {})
            self.assertIsNotNone(process.returncode)
        asyncio.run(check())

    def test_session_changed_content_or_file_fails_and_closes(self):
        async def check(change_path):
            session = {}
            request = {"tool": "lsp_hover", "params": {"path": str(self.file), "line": 1, "character": 1}}
            options = dict(root=self.root, commands={"python": [sys.executable, str(fixture), "normal"]}, session=session)
            first = await probe.execute(request, **options)
            self.assertTrue(first["ok"])
            process = session["handler"].process
            if change_path:
                other = self.root / "other.py"; other.write_bytes(self.file.read_bytes())
                request["params"]["path"] = str(other)
            else:
                self.file.write_text('answer = "changed"\n')
            result = await probe.execute(request, **options)
            self.assertEqual(result["reason"], "session-snapshot-mismatch")
            self.assertTrue(result["serverCleanup"]["ok"])
            self.assertFalse(session)
            self.assertIsNotNone(process.returncode)
        asyncio.run(check(False))
        asyncio.run(check(True))

    def test_session_failed_query_terminates_retained_server(self):
        async def check():
            session = {}
            options = dict(root=self.root, commands={"python": [sys.executable, str(fixture), "normal"]}, session=session)
            request = {"tool": "lsp_hover", "params": {"path": str(self.file), "line": 1, "character": 1}}
            self.assertTrue((await probe.execute(request, **options))["ok"])
            process = session["handler"].process
            request["params"]["line"] = 999
            result = await probe.execute(request, **options)
            self.assertFalse(result["ok"])
            self.assertTrue(result["serverCleanup"]["ok"])
            self.assertFalse(session)
            self.assertIsNotNone(process.returncode)
        asyncio.run(check())

    def run_probe(self, tool="lsp_hover", mode="normal", **params):
        request = {"tool": tool, "params": {"path": str(self.file), **params}}
        if tool not in ("lsp_diagnostics", "lsp_symbols") and not params:
            request["params"].update(line=1, character=1)
        result = asyncio.run(probe.execute(request, root=self.root,
            commands={"python": [sys.executable, str(fixture), mode]}, timeout=1.5, diagnostic_timeout=0.2))
        self.assertTrue(result["serverCleanup"]["ok"])
        self.assertEqual(result["engine"], "multilspy")
        self.assertEqual(result["modelCalls"], 0)
        return result

    def test_official_adapters_lifecycle_and_readonly_contract(self):
        original = probe.TSSERVER
        probe.TSSERVER = str(self.file)
        try:
            for profile, suffix, language in [("official-jedi", ".py", "python"), ("official-typescript", ".ts", "typescript"), ("official-typescript", ".mjs", "javascript")]:
                file = self.root / ("official" + suffix)
                file.write_text("answer = 42", encoding="utf-8")
                methods = list(probe.METHODS) + (["lsp_diagnostics"] if language == "typescript" else [])
                for tool in methods:
                    if language == "python" and tool == "lsp_code_actions":
                        continue
                    params = {"path": str(file)}
                    if tool not in ("lsp_diagnostics", "lsp_symbols"):
                        params.update(line=1, character=1)
                    result = asyncio.run(probe.execute({"tool": tool, "params": params}, root=self.root,
                        commands={language: [sys.executable, str(fixture), profile]}, official_for_fixture=True))
                    self.assertTrue(result["ok"] and result["serverCleanup"]["ok"], result)
                    self.assertEqual(result["adapter"], profile)
                    if tool == "lsp_code_actions":
                        self.assertTrue(result["result"]["details"]["data"][0]["applyEditDenied"])
        finally:
            probe.TSSERVER = original

    def test_official_failure_never_falls_back(self):
        for mode in ("error", "timeout", "hang-shutdown", "wrong-encoding"):
            result = asyncio.run(probe.execute({"tool": "lsp_hover", "params": {
                "path": str(self.file), "line": 1, "character": 1}}, root=self.root,
                commands={"python": [sys.executable, str(fixture), "official-jedi:" + mode]},
                official_for_fixture=True, timeout=0.8))
            self.assertEqual(result["adapter"], "official-jedi")
            self.assertTrue(result["serverCleanup"]["ok"], result)
            self.assertEqual(result["ok"], mode == "hang-shutdown", result)

    def test_diagnostics_keep_explicit_pyright_route(self):
        self.assertEqual(probe.adapter_route("python", "lsp_diagnostics"), "controlled-protocol")
        self.assertEqual(probe.adapter_route("python", "lsp_code_actions"), "controlled-protocol")
        self.assertEqual(probe.adapter_route("cpp", "lsp_hover"), "controlled-protocol")

    def run_typescript(self, mode="normal", tool="lsp_diagnostics"):
        file = self.root / "file.ts"
        file.write_text('const value: number = "wrong";\n', encoding="utf-8")
        original = probe.TSSERVER
        probe.TSSERVER = str(file)
        params = {"path": str(file)}
        if tool == "lsp_code_actions":
            params.update(line=1, character=1)
        try:
            result = asyncio.run(probe.execute({"tool": tool, "params": params}, root=self.root,
                commands={"typescript": [sys.executable, str(fixture), "official-typescript:" + mode]},
                official_for_fixture=True, timeout=1.5, diagnostic_timeout=0.3))
            self.assertTrue(result["serverCleanup"]["ok"], result)
            self.assertEqual(result["modelCalls"], 0)
            return result
        finally:
            probe.TSSERVER = original

    def test_typescript_early_empty_notification_cannot_hide_type_error(self):
        result = self.run_typescript()
        self.assertTrue(result["ok"] and result["diagnosticsPublished"], result)
        self.assertEqual(result["result"]["details"]["data"][0]["code"], 2322)
        self.assertEqual(result["diagnosticCompletion"]["commands"], list(probe.TS_DIAGNOSTIC_COMMANDS))
        self.assertTrue(result["diagnosticCompletion"]["complete"])

    def test_typescript_clean_requires_all_three_phases(self):
        result = self.run_typescript("clean")
        self.assertTrue(result["ok"] and result["diagnosticCompletion"]["complete"], result)
        self.assertEqual(result["result"]["details"]["data"], [])
        self.assertEqual(len(result["diagnosticCompletion"]["commands"]), 3)

    def test_typescript_all_diagnostic_categories_are_collected(self):
        result = self.run_typescript("all-kinds")
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(result["result"]["details"]["data"]), 3)

    def test_typescript_partial_failed_or_unpublished_never_passes(self):
        for mode in ("bad-sync", "sync-failed", "wrong-command", "bad-item", "no-sync-command",
                     "sync-timeout", "no-diagnostics", "stale-diagnostics", "wrong-uri", "error"):
            with self.subTest(mode=mode):
                result = self.run_typescript(mode)
                self.assertFalse(result["ok"], result)
                self.assertFalse(result["diagnosticCompletion"]["complete"], result)

    def test_typescript_code_actions_use_completed_diagnostics(self):
        result = self.run_typescript(tool="lsp_code_actions")
        self.assertTrue(result["ok"] and result["diagnosticCompletion"]["complete"], result)
        self.assertTrue(result["result"]["details"]["data"][0]["applyEditDenied"])

    def test_typescript_diagnostic_utf16_range_metadata_and_validation(self):
        item = {"message": "type error", "category": "suggestion", "code": 123,
                "startLocation": {"line": 1, "offset": 7}, "endLocation": {"line": 1, "offset": 8},
                "reportsUnnecessary": {}, "reportsDeprecated": True, "relatedInformation": []}
        result = probe.ts_diagnostic(item, '"😀"; answer')
        self.assertEqual(result["range"]["start"], {"line": 0, "character": 6})
        self.assertEqual(result["severity"], 4)
        self.assertEqual(result["tags"], [1, 2])
        for invalid in ({**item, "code": True}, {**item, "category": "unknown"},
                        {**item, "startLocation": {"line": 1, "offset": 9}}):
            with self.assertRaises(probe.ProbeError):
                probe.ts_diagnostic(invalid, '"😀"; answer')

    def test_all_seven_semantic_operations(self):
        for tool in ["lsp_diagnostics", *probe.METHODS]:
            with self.subTest(tool=tool):
                result = self.run_probe(tool)
                self.assertEqual(result["status"], "success", result)
                self.assertEqual(result["toolsUsed"], [tool])

    def test_diagnostics_errors_are_successful_observations(self):
        result = self.run_probe("lsp_diagnostics")
        self.assertTrue(result["diagnosticsPublished"])
        self.assertEqual(result["result"]["details"]["data"][0]["severity"], 1)

    def test_empty_published_diagnostics_are_verified(self):
        result = self.run_probe("lsp_diagnostics", "clean")
        self.assertTrue(result["ok"] and result["diagnosticsPublished"])

    def test_absent_or_stale_diagnostics_are_not_clean(self):
        for mode in ["no-diagnostics", "stale-diagnostics"]:
            with self.subTest(mode=mode):
                result = self.run_probe("lsp_diagnostics", mode)
                self.assertFalse(result["ok"])
                self.assertEqual(result["reason"], "diagnostics-not-published")

    def test_unsupported_capability(self):
        self.assertEqual(self.run_probe(mode="unsupported")["status"], "unavailable")

    def test_unsupported_encoding(self):
        self.assertEqual(self.run_probe(mode="wrong-encoding")["reason"], "unsupported-position-encoding")

    def test_empty_result(self):
        self.assertEqual(self.run_probe(mode="empty")["status"], "no-match")

    def test_protocol_error(self):
        self.assertFalse(self.run_probe(mode="error")["ok"])

    def test_request_timeout_cleans_process(self):
        self.assertEqual(self.run_probe(mode="timeout")["reason"], "language-server-timeout")

    def test_unresponsive_shutdown_is_force_cleaned(self):
        self.assertTrue(self.run_probe(mode="hang-shutdown")["ok"])

    def test_query_and_symbol_filter(self):
        self.assertTrue(self.run_probe(query="answer")["ok"])
        self.assertEqual(self.run_probe("lsp_symbols", query="absent")["status"], "no-match")

    def test_ambiguous_query_is_not_guessed(self):
        self.file.write_text("answer = 1\nprint(answer)\n")
        self.assertEqual(self.run_probe(query="answer")["reason"], "ambiguous-query-use-position")

    def test_input_position_utf16(self):
        self.assertEqual(probe.position({"query": "answer"}, '"😀"; answer = 1'), {"line": 0, "character": 6})
        for params in [{"line": True, "character": 1}, {"line": 9, "character": 1}, {"line": 1, "character": 90}]:
            with self.assertRaises(probe.ProbeError):
                probe.position(params, "x")

    def test_unknown_parameters_cannot_supply_commands(self):
        self.assertEqual(self.run_probe(command="touch hacked")["reason"], "unknown-parameters")
        self.assertFalse((self.root / "hacked").exists())

    def test_symlink_cannot_escape_scope(self):
        other = self.root.parent / (self.root.name + "-outside.py")
        other.write_text("outside = 1")
        try:
            self.file.unlink()
            self.file.symlink_to(other)
            self.assertEqual(self.run_probe()["reason"], "file-outside-workspace")
        finally:
            other.unlink()

    def test_no_server_does_not_fallback(self):
        self.file.rename(self.root / "file.unknown")
        self.file = self.root / "file.unknown"
        self.assertEqual(self.run_probe()["reason"], "language-server-not-installed")

    def test_code_actions_never_modify_input(self):
        before = self.file.read_bytes()
        result = self.run_probe("lsp_code_actions")
        self.assertTrue(result["ok"])
        self.assertTrue(result["result"]["details"]["data"][0]["applyEditDenied"])
        self.assertEqual(before, self.file.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
