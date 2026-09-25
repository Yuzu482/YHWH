# SPDX-License-Identifier: Apache-2.0
"""YHWH read-only wrapper for multilspy 0.0.15's official adapters and client.

Use already provisioned servers; never invoke multilspy's downloading factories.
The CLI accepts no commands, environment overrides or alternate workspace roots.
"""
import asyncio
import json
import hashlib
import os
from pathlib import Path
import re
import shlex
import signal
import sys
import tempfile
from importlib.metadata import version as package_version

from multilspy.lsp_protocol_handler.server import LanguageServerHandler, ProcessLaunchInfo
from multilspy import LanguageServer
from multilspy.multilspy_config import MultilspyConfig
from multilspy.multilspy_logger import MultilspyLogger
from multilspy.language_servers.typescript_language_server.typescript_language_server import TypeScriptLanguageServer

VERSION = "0.0.15"
TS_DIAGNOSTIC_COMMANDS = (
    "syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync")
TS_REQUEST_COMMAND = "typescript.tsserverRequest"
METHODS = {
    "lsp_hover": ("textDocument/hover", "hoverProvider"),
    "lsp_definition": ("textDocument/definition", "definitionProvider"),
    "lsp_references": ("textDocument/references", "referencesProvider"),
    "lsp_symbols": ("textDocument/documentSymbol", "documentSymbolProvider"),
    "lsp_completions": ("textDocument/completion", "completionProvider"),
    "lsp_code_actions": ("textDocument/codeAction", "codeActionProvider"),
}
LANGUAGES = {".py": "python", ".js": "javascript", ".mjs": "javascript", ".jsx": "javascriptreact",
             ".ts": "typescript", ".tsx": "typescriptreact", ".java": "java",
             ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp",
             ".cxx": "cpp", ".hpp": "cpp", ".cs": "csharp", ".go": "go", ".rs": "rust"}
NODE_BIN = "/opt/pi-kether/node_modules/.bin/"
TSSERVER = "/opt/pi-kether/node_modules/typescript-lsp/lib/tsserver.js"
JEDI_COMMAND = ["/opt/pi-kether/multilspy-venv/bin/python", "-I", "-c",
                "from jedi_language_server.cli import cli; cli()"]
COMMANDS = {
    "python": [NODE_BIN + "pyright-langserver", "--stdio"],
    **{lang: [NODE_BIN + "typescript-language-server", "--stdio"]
       for lang in ("javascript", "javascriptreact", "typescript", "typescriptreact")},
    "java": ["/opt/pi-kether/multilspy-venv/bin/python", "-I", "/opt/pi-kether/scripts/java-probe-launch.py"],
    "c": ["/usr/bin/clangd", "--enable-config=0"],
    "cpp": ["/usr/bin/clangd", "--enable-config=0"],
    "csharp": ["/usr/local/bin/csharp-ls"],
    "go": ["/opt/pi-kether/gopls/gopls", "serve"],
    "rust": ["/opt/pi-kether/rust/bin/rust-analyzer"],
}


class ProbeError(Exception):
    def __init__(self, reason, status="failed"):
        super().__init__(reason)
        self.status = status


class SandboxedHandler(LanguageServerHandler):
    """Signal our own process group without requiring /proc or psutil traversal."""
    official_init = None
    initialize_response = None
    protect_callbacks = False

    def on_notification(self, method, cb):
        if self.protect_callbacks and method == "textDocument/publishDiagnostics":
            return
        super().on_notification(method, cb)

    def on_request(self, method, cb):
        if self.protect_callbacks and method in {
            "workspace/applyEdit", "workspace/configuration", "workspace/workspaceFolders",
            "client/registerCapability", "workspace/executeClientCommand"}:
            return
        super().on_request(method, cb)

    async def send_request(self, method, params=None):
        if method == "initialize" and self.official_init is not None:
            # Keep official server-specific settings, but advertise only supported
            # read-only capabilities and our own identity, never an editor identity.
            params = {**params, **self.official_init}
        result = await super().send_request(method, params)
        if method == "initialize":
            self.initialize_response = result
        return result

    def _signal_process_tree(self, process, terminate=True):
        try:
            os.killpg(process.pid, signal.SIGTERM if terminate else signal.SIGKILL)
        except ProcessLookupError:
            pass

    async def stop(self):
        process = self.process
        # Include descendants even if the shell/parent exited before stop().
        if process is not None:
            self._signal_process_tree(process, terminate=False)
        await super().stop()
        if process is not None and process.returncode is None:
            raise ProbeError("language-server-cleanup-failed")


class ClangdHandler(SandboxedHandler):
    """Await Linux process/pipe completion rather than a fixed release delay."""
    async def _cleanup_process(self, process):
        if process.stdin is not None:
            process.stdin.close()
        self._signal_process_tree(process, terminate=False)

        async def drain(reader):
            if reader is not None:
                while await reader.read(65536):
                    pass

        # stop() has canceled the protocol readers. Drain remaining bytes so a
        # full stdout/stderr pipe cannot prevent asyncio's process wait finishing.
        await asyncio.wait_for(asyncio.gather(
            process.wait(), drain(process.stdout), drain(process.stderr)), 2)
        if process.returncode is None:
            raise ProbeError("language-server-cleanup-failed")


class CsharpHandler(ClangdHandler):
    async def while_alive(self, operation):
        request = asyncio.create_task(operation)
        exited = asyncio.create_task(self.process.wait())
        try:
            done, _ = await asyncio.wait((request, exited), return_when=asyncio.FIRST_COMPLETED)
            if request in done:
                return await request
            raise ProbeError("language-server-exited", "unavailable")
        finally:
            for task in (request, exited):
                if not task.done():
                    task.cancel()
            await asyncio.gather(request, exited, return_exceptions=True)

    async def send_request(self, method, params=None):
        return await self.while_alive(super().send_request(method, params))


CSHARP_ENV = {"PATH": "/opt/dotnet:/usr/local/bin:/usr/bin:/bin",
              "DOTNET_ROOT": "/opt/dotnet", "DOTNET_GCHeapHardLimit": "0x20000000",
              "DOTNET_PROCESSOR_COUNT": "1", "DOTNET_EnableDiagnostics": "0",
              "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_CLI_HOME": "/tmp",
              "MSBuildEnableWorkloadResolver": "false", "DOTNET_CLI_USE_MSBUILD_SERVER": "0",
              "MSBUILDDISABLENODEREUSE": "1"}


class JavaHandler(CsharpHandler):
    """Share the exit-aware request/cleanup lifecycle; no C# environment."""


JAVA_SETTINGS = {"java.import.gradle.enabled": False, "java.import.maven.enabled": False,
                 "java.autobuild.enabled": False, "java.maxConcurrentBuilds": 1,
                 "java.project.referencedLibraries": [],
                 "java.import.generatesMetadataFilesAtProjectRoot": False}

GO_ENV = {"PATH": "/opt/pi-kether/go/bin:/usr/bin:/bin", "HOME": "/tmp",
          "GOROOT": "/opt/pi-kether/go", "GOPATH": "/tmp/gopath", "GOCACHE": "/tmp/go-cache",
          "GOMODCACHE": "/tmp/go-mod", "GOTOOLCHAIN": "local", "GOWORK": "off",
          "GO111MODULE": "off", "GOPROXY": "off", "GOSUMDB": "off",
          "GOPACKAGESDRIVER": "off", "CGO_ENABLED": "0", "GOMAXPROCS": "1",
          "GOTELEMETRY": "off"}
RUST_ENV = {"PATH": "/opt/pi-kether/rust/bin:/usr/bin:/bin", "HOME": "/tmp",
            "RUSTC": "/opt/pi-kether/rust/bin/rustc", "CARGO_HOME": "/tmp/cargo",
            "CARGO_NET_OFFLINE": "true", "LD_LIBRARY_PATH": "/opt/pi-kether/rust/lib",
            "RUST_SRC_PATH": "/opt/pi-kether/rust/lib/rustlib/src/rust/library"}

def rust_initialization(file):
    return {"linkedProjects": [{"sysroot": "/opt/pi-kether/rust",
             "sysroot_src": RUST_ENV["RUST_SRC_PATH"], "crates": [{"root_module": str(file),
             "edition": "2024", "deps": [], "cfg": [], "env": {}, "is_workspace_member": True}]}],
            "cargo": {"buildScripts": {"enable": False}, "offline": True},
            "procMacro": {"enable": False}, "checkOnSave": False,
            "numThreads": 1, "cachePriming": {"enable": False},
            "diagnostics": {"experimental": {"enable": False}}}


def rust_diagnostics(raw, file, text, returncode):
    """Normalize compiler spans by byte offset, including non-BMP UTF-16 positions."""
    data = []
    source = text.encode('utf-8')
    def point(offset):
        if type(offset) is not int or not 0 <= offset <= len(source):
            raise ProbeError('invalid-rust-diagnostic-response')
        before = source[:offset].decode('utf-8')
        return {'line': before.count('\n'), 'character': len(before.rsplit('\n', 1)[-1].encode('utf-16-le')) // 2}
    for line in raw.splitlines():
        item = json.loads(line)
        if item.get('$message_type') != 'diagnostic' or item.get('level') not in ('error','warning','note','help','failure-note'):
            raise ProbeError('invalid-rust-diagnostic-response')
        spans = [s for s in item.get('spans', []) if s.get('is_primary') and s.get('file_name') == str(file)]
        if not spans:
            continue  # rustc's final error/warning summary has no source span.
        for span in spans:
            data.append({'range': {'start': point(span['byte_start']), 'end': point(span['byte_end'])},
                         'message': item['message'], 'code': (item.get('code') or {}).get('code'),
                         'source': 'rustc', 'severity': 1 if item['level'] == 'error' else 2})
    errors = any(d['severity'] == 1 for d in data)
    if returncode not in (0, 1) or (returncode == 1) != errors:
        raise ProbeError('rust-compiler-diagnostics-incomplete', 'unavailable')
    return data


async def rust_compiler_diagnostics(file, text, evidence):
    """Check only the immutable library crate; no Cargo, linking or user code execution."""
    with tempfile.TemporaryDirectory(prefix='yhwh-rust-check-') as directory:
        process = await asyncio.create_subprocess_exec(
            RUST_ENV['RUSTC'], '--sysroot', '/opt/pi-kether/rust', '--crate-type=lib',
            '--crate-name=yhwh_probe', '--edition=2024', '--emit=metadata', '--error-format=json',
            '-o', str(Path(directory)/'probe.rmeta'), str(file), env=RUST_ENV,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        evidence['compilerCleanup'] = False
        try:
            chunks = []
            size = 0
            while chunk := await process.stderr.read(65536):
                size += len(chunk)
                if size > 2 * 1024 * 1024:
                    raise ProbeError('rust-diagnostic-output-limit', 'unavailable')
                chunks.append(chunk)
            code = await process.wait()
            return rust_diagnostics(b''.join(chunks), file, text, code)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            async def drain():
                while await process.stderr.read(65536):
                    pass
            await asyncio.wait_for(asyncio.gather(process.wait(), drain()), 2)
            evidence['compilerCleanup'] = True


class ProvisionedTypeScriptAdapter(TypeScriptLanguageServer):
    """Use the upstream adapter lifecycle with already locked runtime artifacts."""
    def setup_runtime_dependencies(self, logger, config):
        return "exec " + shlex.join(COMMANDS["typescript"])


def adapter_route(language, tool):
    if language == "python" and tool not in ("lsp_diagnostics", "lsp_code_actions"):
        return "official-jedi"
    if language in ("javascript", "javascriptreact", "typescript", "typescriptreact"):
        return "official-typescript"
    return "controlled-protocol"


def official_adapter(route, root, command):
    config = MultilspyConfig.from_dict({"code_language": "python" if route == "official-jedi" else "typescript",
                                       "start_independent_lsp_process": True})
    logger = MultilspyLogger()
    if route == "official-jedi":
        adapter = LanguageServer.create(config, logger, str(root))
    else:
        adapter = ProvisionedTypeScriptAdapter(config, logger, str(root))
    # No process has started. Replace transport only to retain sandbox cleanup.
    adapter.server = SandboxedHandler(ProcessLaunchInfo("exec " + shlex.join(command), cwd=str(root)),
                                     start_independent_lsp_process=True)
    return adapter


def position(params, text):
    lines = text.split("\n")
    if "line" in params or "character" in params:
        line, char = params.get("line"), params.get("character")
        if type(line) is not int or type(char) is not int or line < 1 or char < 1:
            raise ProbeError("invalid-position")
        if line > len(lines) or char - 1 > len(lines[line - 1].encode("utf-16-le")) // 2:
            raise ProbeError("position-outside-file")
        return {"line": line - 1, "character": char - 1}
    query = params.get("query")
    if not isinstance(query, str) or not query or len(query) > 4000:
        raise ProbeError("position-required")
    matches = list(re.finditer(r"(?<!\w)" + re.escape(query) + r"(?!\w)", text))
    if len(matches) != 1:
        raise ProbeError("query-not-found" if not matches else "ambiguous-query-use-position")
    before = text[:matches[0].start()]
    return {"line": before.count("\n"),
            "character": len(before.rsplit("\n", 1)[-1].encode("utf-16-le")) // 2}


def response(tool, status, reason=None, **extra):
    return {"ok": status in ("success", "no-match"), "status": status,
            "reason": reason, "requestedTool": tool, "toolsUsed": [tool],
            "unexpectedTools": [], "backend": "lsp", "engine": "multilspy",
            "engineVersion": VERSION, "modelCalls": 0, "executionMode": "direct",
            "diagnosticsPublished": False, **extra}


def ts_diagnostic(item, text):
    """Normalize the pinned tsserver DiagnosticWithLinePosition wire format."""
    if (not isinstance(item, dict) or not isinstance(item.get("message"), str)
            or type(item.get("code")) is not int
            or item.get("category") not in ("error", "warning", "suggestion", "message")):
        raise ProbeError("invalid-typescript-diagnostic-response")
    points = []
    for key in ("startLocation", "endLocation"):
        value = item.get(key)
        if not isinstance(value, dict):
            raise ProbeError("invalid-typescript-diagnostic-response")
        points.append(position({"line": value.get("line"), "character": value.get("offset")}, text))
    if (points[0]["line"], points[0]["character"]) > (points[1]["line"], points[1]["character"]):
        raise ProbeError("invalid-typescript-diagnostic-response")
    result = {"range": {"start": points[0], "end": points[1]}, "message": item["message"],
              "code": item["code"], "source": "typescript",
              "severity": {"error": 1, "warning": 2, "message": 3, "suggestion": 4}[item["category"]]}
    tags = [tag for key, tag in (("reportsUnnecessary", 1), ("reportsDeprecated", 2))
            if key in item and item[key] is not None and item[key] is not False]
    if tags:
        result["tags"] = tags
    # Keep supplemental protocol evidence without pretending it is an LSP Location.
    if "relatedInformation" in item:
        result["data"] = {"tsserverRelatedInformation": item["relatedInformation"]}
    return result


async def typescript_diagnostics(handler, caps, uri, text, evidence):
    provider = caps.get("executeCommandProvider")
    if not isinstance(provider, dict) or TS_REQUEST_COMMAND not in provider.get("commands", []):
        raise ProbeError("typescript-diagnostic-command-unavailable", "unavailable")
    data = []
    # A publishDiagnostics notification can contain only the syntax phase. These
    # fixed read-only requests return after each phase actually finishes. Never
    # accept commands, execution settings or paths from an external tool result.
    for command in TS_DIAGNOSTIC_COMMANDS:
        result = await handler.send_request("workspace/executeCommand", {
            "command": TS_REQUEST_COMMAND,
            "arguments": [command, {"file": uri, "includeLinePosition": True},
                          {"expectsResult": True, "isAsync": False, "executionTarget": 0}]})
        if (not isinstance(result, dict) or result.get("type") != "response"
                or result.get("success") is not True or result.get("command") != command
                or not isinstance(result.get("body"), list)):
            raise ProbeError("invalid-typescript-diagnostic-response")
        data.extend(ts_diagnostic(item, text) for item in result["body"])
        evidence["commands"].append(command)
    return data


async def close_session(session):
    """Await shutdown before clearing a retained server's state."""
    handler = session.get("handler")
    cleanup = True
    try:
        if handler is not None:
            if session.get("opened"):
                handler.send_notification("textDocument/didClose", {"textDocument": {"uri": session["uri"]}})
            try:
                if session.get("lifecycle_entered"):
                    await asyncio.wait_for(session["lifecycle"].__aexit__(None, None, None), 2)
                elif session.get("initialized"):
                    await asyncio.wait_for(handler.send_request("shutdown"), 2)
                    handler.send_notification("exit")
            except Exception:
                pass
            finally:
                await asyncio.wait_for(handler.stop(), 5)
    except Exception:
        cleanup = False
    finally:
        session.clear()
    return cleanup


async def execute(request, *, root=Path("/workspace"), commands=None, timeout=60,
                  diagnostic_timeout=15, official_for_fixture=False, session=None):
    """Dependency injection is for fixtures only; CLI always uses fixed defaults."""
    tool = request.get("tool") if isinstance(request, dict) else None
    handler = None
    lifecycle = None
    lifecycle_entered = False
    route = "unselected"
    opened = False
    initialized = False
    diagnostic_event = asyncio.Event()
    diagnostic_state = {"data": []}
    reused = False
    key = None
    diagnostic_completion = None
    caps = {}
    uri = None
    answer = response(tool, "failed", "interrupted")
    try:
        if package_version("multilspy") != VERSION:
            raise ProbeError("multilspy-version-mismatch", "unavailable")
        if tool not in METHODS and tool != "lsp_diagnostics":
            raise ProbeError("unsupported-semantic-operation", "unavailable")
        params = request.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("path"), str):
            raise ProbeError("invalid-parameters")
        if set(params) - {"path", "line", "character", "query"}:
            raise ProbeError("unknown-parameters")
        if tool in ("lsp_diagnostics", "lsp_symbols") and ("line" in params or "character" in params):
            raise ProbeError("unexpected-position")
        if tool == "lsp_diagnostics" and "query" in params:
            raise ProbeError("unexpected-query")
        if "query" in params and (not isinstance(params["query"], str) or not params["query"].strip() or len(params["query"]) > 4000):
            raise ProbeError("invalid-query")
        root = root.resolve(strict=True)
        file = Path(params["path"]).resolve(strict=True)
        if not file.is_relative_to(root) or not file.is_file():
            raise ProbeError("file-outside-workspace")
        if file.stat().st_size > 4 * 1024 * 1024:
            raise ProbeError("file-size-limit")
        language = LANGUAGES.get(file.suffix.lower())
        route = adapter_route(language, tool) if commands is None or official_for_fixture else "fixture-protocol"
        command = (COMMANDS if commands is None else commands).get(language)
        if route == "official-jedi" and commands is None:
            command = JEDI_COMMAND
        if not command or not Path(command[0]).is_file():
            raise ProbeError("language-server-not-installed", "unavailable")
        raw = file.read_bytes()
        text = raw.decode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        key = (str(file), digest, route, tuple(command))
        if session and session.get("key") != key:
            raise ProbeError("session-snapshot-mismatch")
        pos = None if tool in ("lsp_diagnostics", "lsp_symbols") else position(params, text)
        uri = file.as_uri()
        async with asyncio.timeout(timeout):
            if session:
                handler = session["handler"]
                lifecycle = session["lifecycle"]
                lifecycle_entered = session["lifecycle_entered"]
                initialized = opened = True
                caps = session["caps"]
                diagnostic_event = session["event"]
                diagnostic_state = session["diagnostics"]
                reused = True
            else:
                # Command strings are exclusively assembled from trusted server profiles.
                if route.startswith("official-"):
                    adapter = official_adapter(route, root, command)
                    handler = adapter.server
                    lifecycle = adapter.start_server()
                else:
                    handler_type = ClangdHandler if language in ("c", "cpp") else SandboxedHandler
                    if language == "csharp":
                        handler_type = CsharpHandler
                    elif language == "java":
                        handler_type = JavaHandler
                    elif language in ("go", "rust"):
                        handler_type = CsharpHandler
                    handler = handler_type(ProcessLaunchInfo("exec " + shlex.join(command), cwd=str(root),
                                               env=({"csharp":CSHARP_ENV,"go":GO_ENV,"rust":RUST_ENV}.get(language,{}) if commands is None else {})),
                                               start_independent_lsp_process=True)

                async def on_diagnostics(payload):
                    if (opened and isinstance(payload, dict) and payload.get("uri") == uri
                            and payload.get("version", 1) == 1
                            and isinstance(payload.get("diagnostics"), list)):
                        diagnostic_state["data"] = payload["diagnostics"]
                        diagnostic_event.set()

                async def configuration(payload):
                    return [{} for _ in (payload or {}).get("items", [])]

                async def folders(_):
                    return [{"uri": root.as_uri(), "name": "workspace"}]

                async def deny_edit(_):
                    return {"applied": False, "failureReason": "YHWH probe is read-only"}

                async def register(_):
                    # Do not claim support for dynamically registered methods.
                    return None

                handler.on_notification("textDocument/publishDiagnostics", on_diagnostics)
                handler.on_request("workspace/configuration", configuration)
                handler.on_request("workspace/workspaceFolders", folders)
                handler.on_request("workspace/applyEdit", deny_edit)
                handler.on_request("client/registerCapability", register)
                handler.on_request("window/workDoneProgress/create", register)
                handler.on_request("workspace/executeClientCommand", deny_edit)
                initialization = {}
                if language == "java":
                    initialization = {"triggerFiles": [uri], "settings": JAVA_SETTINGS}
                elif language == "go":
                    initialization = {"expandWorkspaceToModule": False, "staticcheck": False,
                                      "checkUpdates": "off", "telemetryPrompt": False, "pullDiagnostics": True}
                elif language == "rust":
                    initialization = rust_initialization(file)
                if language in ("javascript", "javascriptreact", "typescript", "typescriptreact"):
                    if not Path(TSSERVER).is_file():
                        raise ProbeError("pinned-tsserver-not-installed", "unavailable")
                    initialization = {"disableAutomaticTypingAcquisition": True, "plugins": [],
                        "tsserver": {"path": TSSERVER, "useSyntaxServer": "never", "logVerbosity": "off"}}
                initialize_params = {
                    "processId": None, "rootUri": root.as_uri(),
                    "workspaceFolders": await folders(None),
                    "capabilities": {"general": {"positionEncodings": ["utf-16"]},
                        "workspace": {"configuration": True, "workspaceFolders": True, "applyEdit": False},
                        "textDocument": {"documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                            "publishDiagnostics": {"versionSupport": True},
                            "completion": {"completionItem": {"snippetSupport": False}}}},
                    "initializationOptions": initialization,
                    "clientInfo": {"name": "YHWH multilspy probe"}}
                if lifecycle is not None:
                    handler.official_init = initialize_params
                    handler.protect_callbacks = True
                    await lifecycle.__aenter__()
                    lifecycle_entered = True
                    init = handler.initialize_response
                else:
                    await handler.start()
                    init = await handler.send_request("initialize", initialize_params)
                if not isinstance(init, dict) or not isinstance(init.get("capabilities"), dict):
                    raise ProbeError("invalid-initialize-response")
                caps = init["capabilities"]
                if caps.get("positionEncoding", "utf-16") != "utf-16":
                    raise ProbeError("unsupported-position-encoding", "unavailable")
                if lifecycle is None:
                    handler.send_notification("initialized", {})
                initialized = True
                opened = True
                handler.send_notification("textDocument/didOpen", {"textDocument": {
                    "uri": uri, "languageId": language, "version": 1, "text": text}})
            ts_data = None
            if language in ('go', 'rust') and tool in ('lsp_diagnostics', 'lsp_code_actions'):
                diagnostic_completion = {'method': 'gopls-pull' if language == 'go' else 'rustc-single-file',
                                         'complete': False, 'documentVersion': 1}
                try:
                    async with asyncio.timeout(diagnostic_timeout):
                        if language == 'go':
                            if not caps.get('diagnosticProvider'):
                                raise ProbeError('go-pull-diagnostics-unavailable', 'unavailable')
                            report = await handler.send_request('textDocument/diagnostic', {'textDocument': {'uri': uri}})
                            # Pinned gopls 0.23.0 leaves kind empty on its complete
                            # DiagnoseFile response. Never accept an unchanged report.
                            if not isinstance(report, dict) or report.get('kind') not in ('full', '') or not isinstance(report.get('items'), list):
                                raise ProbeError('invalid-go-diagnostic-response')
                            ts_data = report['items']
                        else:
                            diagnostic_completion['edition'] = '2024'
                            ts_data = await rust_compiler_diagnostics(file, text, diagnostic_completion)
                        await handler.while_alive(diagnostic_event.wait())
                    diagnostic_completion['complete'] = True
                except TimeoutError:
                    raise ProbeError(language + '-diagnostics-incomplete', 'unavailable')
            if language in ("javascript", "javascriptreact", "typescript", "typescriptreact") and tool in (
                    "lsp_diagnostics", "lsp_code_actions"):
                diagnostic_completion = {"method": "tsserver-sync", "complete": False,
                                         "documentVersion": 1, "commands": []}
                try:
                    async with asyncio.timeout(diagnostic_timeout):
                        ts_data = await typescript_diagnostics(handler, caps, uri, text, diagnostic_completion)
                        # Retain the independent evidence that the opened document
                        # was published; its possibly partial contents are not used.
                        await diagnostic_event.wait()
                    diagnostic_completion["complete"] = True
                except TimeoutError:
                    raise ProbeError("typescript-diagnostics-incomplete", "unavailable")
            if tool == "lsp_diagnostics":
                try:
                    waiting = handler.while_alive(diagnostic_event.wait()) if isinstance(handler, CsharpHandler) else diagnostic_event.wait()
                    await asyncio.wait_for(waiting, diagnostic_timeout)
                except TimeoutError:
                    raise ProbeError("diagnostics-not-published", "unavailable")
                data = ts_data if ts_data is not None else diagnostic_state["data"]
                if language == "java" and any(str(item.get("code")) in ("16", "32") for item in data):
                    raise ProbeError("java-semantic-diagnostics-unavailable", "unavailable")
            else:
                method, capability = METHODS[tool]
                if capability not in caps or caps[capability] is False or caps[capability] is None:
                    raise ProbeError("server-capability-unavailable", "unavailable")
                arguments = {"textDocument": {"uri": uri}}
                if pos is not None:
                    arguments["position"] = pos
                if tool == "lsp_references":
                    arguments["context"] = {"includeDeclaration": True}
                if tool == "lsp_code_actions":
                    arguments.pop("position")
                    arguments.update(range={"start": pos, "end": pos},
                                     context={"diagnostics": ts_data if ts_data is not None else diagnostic_state["data"]})
                data = await handler.send_request(method, arguments)
                if tool == "lsp_symbols" and params.get("query"):
                    query = params["query"]
                    def select(items):
                        found = []
                        for item in items or []:
                            if item.get("name") == query:
                                found.append(item)
                            found.extend(select(item.get("children", [])))
                        return found
                    data = select(data)
            empty = data is None or data == [] or data == {} or (isinstance(data, dict) and data.get("items") == [])
            status = "success" if tool == "lsp_diagnostics" or not empty else "no-match"
            result = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                      "details": {"data": data, "language": language, "positions": "LSP 0-based UTF-16",
                                  "readOnly": True, "scope": "single-file snapshot"}}
            answer = response(tool, status, result=result, diagnosticsPublished=diagnostic_event.is_set())
    except ProbeError as error:
        answer = response(tool, error.status, str(error), diagnosticsPublished=diagnostic_event.is_set())
    except TimeoutError:
        answer = response(tool, "failed", "language-server-timeout")
    except Exception as error:
        # Avoid printing server-controlled content or environment data in errors.
        answer = response(tool, "failed", "language-server-error", errorType=type(error).__name__)
    finally:
        retained = session is not None and answer["ok"] and handler is not None
        if retained:
            session.update(key=key, handler=handler, lifecycle=lifecycle,
                lifecycle_entered=lifecycle_entered, initialized=initialized,
                opened=opened, uri=uri, caps=caps, event=diagnostic_event,
                diagnostics=diagnostic_state)
            cleanup = True
            answer["serverCleanup"] = {"ok": None, "state": "retained-until-session-close"}
            answer["serverSession"] = {"reused": reused, "documentSha256": key[1], "documentVersion": 1}
        else:
            current = dict(handler=handler, lifecycle=lifecycle, lifecycle_entered=lifecycle_entered,
                           initialized=initialized, opened=opened, uri=uri)
            cleanup = await close_session(session if session else current)
            answer["serverCleanup"] = {"ok": cleanup}
        answer["adapter"] = route
        answer["adapterVersion"] = VERSION
        if diagnostic_completion is not None:
            answer["diagnosticCompletion"] = diagnostic_completion
        if not cleanup:
            answer.update(ok=False, status="failed", reason="language-server-cleanup-failed")
    return answer


async def session_main():
    """One immutable snapshot, sequential bounded requests, no external configuration."""
    session = {}
    reader = asyncio.StreamReader(limit=65536)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    count = 0
    try:
        while True:
            line = await asyncio.wait_for(reader.readline(), 20)
            if not line:
                break
            if len(line) > 65536:
                raise ValueError("session-input-limit")
            request = json.loads(line)
            if request == {"close": True}:
                break
            if count >= 64:
                raise ValueError("session-input-limit")
            if not isinstance(request, dict) or set(request) != {"tool", "params"}:
                raise ValueError("invalid-session-request")
            count += 1
            answer = await execute(request, session=session)
            encoded = json.dumps(answer, ensure_ascii=False)
            if len(encoded.encode("utf-8")) > 1024 * 1024:
                raise ValueError("session-output-limit")
            print(encoded, flush=True)
            if not answer["ok"]:
                break
    finally:
        cleanup = await close_session(session)
        print(json.dumps({"sessionClosed": True, "serverCleanup": {"ok": cleanup}}), flush=True)
        transport.close()
    return 0 if cleanup else 1


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("request too large")
        request = json.loads(raw)
        answer = asyncio.run(execute(request))
        encoded = json.dumps(answer, ensure_ascii=False)
        if len(encoded.encode("utf-8")) > 1024 * 1024:
            answer = response(request.get("tool"), "failed", "output-size-limit")
            encoded = json.dumps(answer)
    except Exception:
        answer = {"ok": False, "status": "failed", "reason": "invalid-probe-input", "modelCalls": 0}
        encoded = json.dumps(answer)
    print(encoded)
    return 0 if answer["ok"] else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--session"]:
        try:
            sys.exit(asyncio.run(session_main()))
        except Exception:
            sys.exit(1)
    elif sys.argv[1:]:
        sys.exit(2)
    else:
        sys.exit(main())
