# SPDX-License-Identifier: Apache-2.0
"""Local JSON-RPC fixture, never a network service."""
import json
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
profile = None
if mode.startswith("official-"):
    profile, _, mode = mode.partition(":")
    mode = mode or "normal"
denied = False
uri = None
pending_action = None


def send(message):
    body = json.dumps(message).encode()
    sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    sys.stdout.buffer.flush()


while True:
    line = sys.stdin.buffer.readline()
    if not line:
        break
    if not line.startswith(b"Content-Length: "):
        continue
    length = int(line.split(b":")[1])
    while sys.stdin.buffer.readline().strip():
        pass
    message = json.loads(sys.stdin.buffer.read(length))
    method = message.get("method")
    if message.get("id") == 999 and "result" in message:
        denied = message["result"].get("applied") is False
        send({"jsonrpc": "2.0", "id": pending_action, "result": [{"title": "preview only",
              "applyEditDenied": denied, "command": {"title": "do not run", "command": "fixture.write"}}]})
        continue
    if method == "exit":
        break
    if method == "textDocument/didOpen":
        if mode == "exit-on-open":
            sys.exit(9)
        uri = message["params"]["textDocument"]["uri"]
        if mode.startswith('java-non-project-'):
            send({'jsonrpc':'2.0','method':'textDocument/publishDiagnostics','params':{
                'uri':uri,'version':1,'diagnostics':[{'code':mode.rsplit('-',1)[1],
                'message':'non-project diagnostic','severity':2,
                'range':{'start':{'line':0,'character':0},'end':{'line':0,'character':1}}}]}})
            continue
        if mode not in ("no-diagnostics", "go-no-diagnostics"):
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {
                "uri": uri + ".wrong" if mode == "wrong-uri" else uri,
                "version": 0 if mode == "stale-diagnostics" else 1,
                "diagnostics": [] if mode in ("clean","java-profile") or profile == "official-typescript" else [{"message": "fixture error", "severity": 1,
                    "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}}]}})
        continue
    if "id" not in message:
        continue
    if method == "initialize":
        if mode == 'java-profile':
            options=message['params']['initializationOptions']
            assert len(options['triggerFiles'])==1 and options['triggerFiles'][0].endswith('/Sample.java')
            settings=options['settings']
            assert settings['java.import.gradle.enabled'] is False and settings['java.import.maven.enabled'] is False
            assert settings['java.project.referencedLibraries']==[] and settings['java.autobuild.enabled'] is False
        result = {"capabilities": {"hoverProvider": mode != "unsupported", "definitionProvider": True,
            "referencesProvider": True, "documentSymbolProvider": True, "completionProvider": {},
            "codeActionProvider": True}}
        if mode.startswith('go-'):
            assert message['params']['initializationOptions']['pullDiagnostics'] is True
            result['capabilities']['diagnosticProvider']={'workspaceDiagnostics':False}
        if profile:
            params = message["params"]
            assert params["clientInfo"]["name"] == "YHWH multilspy probe"
            assert params["capabilities"]["workspace"]["applyEdit"] is False
            assert params["capabilities"]["general"]["positionEncodings"] == ["utf-16"]
            result["capabilities"]["textDocumentSync"] = {"change": 2} if profile == "official-jedi" else 2
            result["capabilities"]["completionProvider"] = {
                "triggerCharacters": [".", "'", '"'] if profile == "official-jedi" else ['.', '"', "'", '/', '@', '<'],
                "resolveProvider": True}
            if profile == "official-typescript" and mode != "no-sync-command":
                result["capabilities"]["executeCommandProvider"] = {"commands": ["typescript.tsserverRequest"]}
        if mode == "wrong-encoding":
            result["capabilities"]["positionEncoding"] = "utf-8"
    elif method == "shutdown":
        if mode == "hang-shutdown":
            continue
        result = None
    elif mode == "timeout":
        continue
    elif mode == "error":
        send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": "fixture failure"}})
        continue
    elif method == "workspace/executeCommand":
        args = message["params"]
        assert args["command"] == "typescript.tsserverRequest"
        command, target, config = args["arguments"]
        assert command in ("syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync")
        assert target == {"file": uri, "includeLinePosition": True}
        assert config == {"expectsResult": True, "isAsync": False, "executionTarget": 0}
        if command == "semanticDiagnosticsSync":
            if mode == "sync-timeout":
                continue
            time.sleep(0.06)  # The first empty publish has already reached the client.
        items = []
        if mode != "clean" and (command == "semanticDiagnosticsSync" or mode == "all-kinds"):
            items = [{"message": "fixture type error", "code": 2322, "category": "error",
                      "start": 0, "length": 1,
                      "startLocation": {"line": 1, "offset": 1},
                      "endLocation": {"line": 1, "offset": 2}}]
        result = {"type": "response", "command": command, "success": True, "body": items}
        if mode == "bad-sync" and command == "semanticDiagnosticsSync":
            result["body"] = None
        if mode == "sync-failed" and command == "semanticDiagnosticsSync":
            result["success"] = False
        if mode == "wrong-command" and command == "semanticDiagnosticsSync":
            result["command"] = "syntacticDiagnosticsSync"
        if mode == "bad-item" and items:
            items[0]["endLocation"] = {"line": 90, "offset": 1}
    elif method == 'textDocument/diagnostic':
        result={'kind': '' if mode=='go-empty-kind' else 'unchanged' if mode=='go-unchanged' else 'full', 'items': []}
    elif method == "textDocument/hover":
        result = None if mode == "empty" else {"contents": {"kind": "plaintext", "value": "answer: int"}}
    elif method in ("textDocument/definition", "textDocument/references"):
        result = [{"uri": uri, "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}}}]
    elif method == "textDocument/documentSymbol":
        result = [{"name": "answer", "kind": 13, "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}},
            "selectionRange": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 6}}}]
    elif method == "textDocument/completion":
        result = {"isIncomplete": False, "items": [{"label": "answer"}]}
    elif method == "textDocument/codeAction":
        if profile == "official-typescript":
            assert message["params"]["context"]["diagnostics"][0]["code"] == 2322
        # Client must refuse server-initiated writes even while servicing queries.
        pending_action = message["id"]
        send({"jsonrpc": "2.0", "id": 999, "method": "workspace/applyEdit", "params": {"edit": {"changes": {}}}})
        continue
    else:
        result = None
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
