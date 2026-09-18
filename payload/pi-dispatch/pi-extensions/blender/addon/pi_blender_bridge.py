"""Pi Blender Bridge: authenticated loopback MCP, typed operations only."""
bl_info = {"name": "Pi Blender Bridge", "author": "Local Pi workflow", "version": (1, 0, 0), "blender": (4, 0, 0), "category": "System"}
import json
import math
import os
from pathlib import Path
import queue
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import bpy

def schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}
NAME = {"type": "string", "minLength": 1, "maxLength": 128}
VEC = {"type": "array", "items": {"type": "number", "minimum": -1000000, "maximum": 1000000}, "minItems": 3, "maxItems": 3}
COLOR = {"type": "array", "items": {"type": "number", "minimum": 0, "maximum": 1}, "minItems": 4, "maxItems": 4}
TOOLS = [
    {"name": "blender_scene_info", "description": "Read the active scene and up to 200 objects.", "inputSchema": schema(), "annotations": {"readOnlyHint": True}},
    {"name": "blender_create_object", "description": "Create a named primitive in the current scene.", "inputSchema": schema({"name": NAME, "primitive": {"type": "string", "enum": ["cube", "sphere", "cylinder", "plane"]}}, ["name", "primitive"])},
    {"name": "blender_set_transform", "description": "Set object position, Euler rotation in degrees and scale.", "inputSchema": schema({"name": NAME, "position": VEC, "rotation": VEC, "scale": VEC}, ["name", "position", "rotation", "scale"])},
    {"name": "blender_delete_object", "description": "Delete an object from the active scene.", "inputSchema": schema({"name": NAME}, ["name"])},
    {"name": "blender_set_material", "description": "Create a new material and assign it to a mesh.", "inputSchema": schema({"name": NAME, "materialName": NAME, "color": COLOR}, ["name", "materialName", "color"])},
    {"name": "blender_save_copy", "description": "Save a .blend copy inside the configured assetRoot, without overwriting.", "inputSchema": schema({"fileName": NAME}, ["fileName"])},
    {"name": "blender_export_glb", "description": "Export the scene to a new .glb inside assetRoot.", "inputSchema": schema({"fileName": NAME}, ["fileName"])},
]
for tool in TOOLS:
    if tool["name"] != "blender_scene_info":
        tool["inputSchema"]["properties"]["_piScene"] = schema({"name": NAME, "path": {"type": "string", "maxLength": 4096}}, ["name", "path"])
TOOL_MAP = {t["name"]: t for t in TOOLS}
_server = None
_thread = None
_config = None
_token = None
_jobs = queue.Queue(maxsize=16)

def validate(value, rule):
    kind = rule["type"]
    if kind == "object":
        if not isinstance(value, dict) or set(value) - set(rule["properties"]) or any(k not in value for k in rule["required"]):
            raise ValueError("Invalid object fields")
        for key, item in value.items():
            validate(item, rule["properties"][key])
    elif kind == "string":
        if not isinstance(value, str) or not rule.get("minLength", 0) <= len(value) <= rule.get("maxLength", 8192) or any(ord(c) < 32 for c in value):
            raise ValueError("Invalid string")
    elif kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not rule.get("minimum", -1e100) <= value <= rule.get("maximum", 1e100):
            raise ValueError("Invalid number")
    elif kind == "array":
        if not isinstance(value, list) or not rule["minItems"] <= len(value) <= rule["maxItems"]:
            raise ValueError("Invalid array")
        for item in value:
            validate(item, rule["items"])
    if "enum" in rule and value not in rule["enum"]:
        raise ValueError("Invalid enum")

def output_path(file_name, suffix):
    if Path(file_name).name != file_name or "/" in file_name or "\\" in file_name or ":" in file_name or not file_name.lower().endswith(suffix):
        raise ValueError("A simple filename with the required extension is required")
    root = Path(_config["assetRoot"]).resolve(strict=True)
    target = (root / file_name).resolve()
    if target.parent != root or target.exists():
        raise ValueError("Output must be a new file inside assetRoot")
    return str(target)

def scene_object(name):
    obj = bpy.context.scene.objects.get(name)
    if obj is None or obj.library is not None:
        raise ValueError("Editable object not found in current scene")
    return obj

def execute(name, args):
    if name not in TOOL_MAP:
        raise ValueError("Tool not allowed")
    validate(args, TOOL_MAP[name]["inputSchema"])
    if name == "blender_scene_info":
        return {"version": bpy.app.version_string, "scene": bpy.context.scene.name, "file": bpy.data.filepath,
                "objects": [{"name": o.name, "type": o.type, "position": list(o.location)} for o in list(bpy.context.scene.objects)[:200]],
                "objectCount": len(bpy.context.scene.objects), "allowWrites": _config["allowWrites"]}
    if not _config["allowWrites"]:
        raise ValueError("Writes disabled by Blender server")
    expected = args.get("_piScene")
    if expected is not None and (expected["name"] != bpy.context.scene.name or expected["path"] != bpy.data.filepath):
        raise ValueError("Authorized Blender scene changed")
    if bpy.context.mode != "OBJECT":
        raise ValueError("Switch Blender to Object Mode before editing")
    if name == "blender_create_object":
        if bpy.data.objects.get(args["name"]):
            raise ValueError("Object name already exists")
        factories = {"cube": bpy.ops.mesh.primitive_cube_add, "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
                     "cylinder": bpy.ops.mesh.primitive_cylinder_add, "plane": bpy.ops.mesh.primitive_plane_add}
        factories[args["primitive"]]()
        bpy.context.object.name = args["name"]
        return {"created": bpy.context.object.name}
    if name == "blender_set_transform":
        obj = scene_object(args["name"])
        obj.location = args["position"]
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = [math.radians(n) for n in args["rotation"]]
        obj.scale = args["scale"]
        return {"modified": obj.name}
    if name == "blender_delete_object":
        obj = scene_object(args["name"])
        bpy.data.objects.remove(obj, do_unlink=True)
        return {"deleted": args["name"]}
    if name == "blender_set_material":
        obj = scene_object(args["name"])
        if obj.type != "MESH" or bpy.data.materials.get(args["materialName"]):
            raise ValueError("Expected mesh and a new material name")
        material = bpy.data.materials.new(args["materialName"])
        material.diffuse_color = args["color"]
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = args["color"]
        obj.data.materials.append(material)
        return {"material": material.name, "object": obj.name}
    if name == "blender_save_copy":
        path = output_path(args["fileName"], ".blend")
        result = bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=True, copy=True)
        if "FINISHED" not in result:
            raise RuntimeError("Blender save did not finish")
        return {"savedCopy": path}
    if name == "blender_export_glb":
        path = output_path(args["fileName"], ".glb")
        result = bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", check_existing=True)
        if "FINISHED" not in result:
            raise RuntimeError("Blender export did not finish")
        return {"exported": path}
    raise ValueError("Unknown tool")

def tick():
    for _ in range(4):
        try:
            job = _jobs.get_nowait()
        except queue.Empty:
            break
        with job["lock"]:
            if job["cancelled"] or time.monotonic() >= job["deadline"]:
                job["cancelled"] = True
                job["done"].set()
                continue
            job["started"] = True
        try:
            value = execute(job["name"], job["args"])
            job["result"] = {"content": [{"type": "text", "text": json.dumps(value)}], "isError": False}
        except Exception:
            job["result"] = {"content": [{"type": "text", "text": "Blender operation rejected or failed; inspect scene before retrying a write."}], "isError": True}
        job["done"].set()
    return 0.05 if _server else None

class LimitedServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    slots = threading.BoundedSemaphore(4)
    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise
    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass
    def setup(self):
        super().setup()
        self.connection.settimeout(35)
    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode("utf-8")
        if len(data) > 2097152:
            status, data = 500, b'{"error":"output limit exceeded"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def do_GET(self):
        self.reply(405)
    def do_DELETE(self):
        self.reply(405)
    def do_POST(self):
        if self.path != "/mcp" or self.headers.get("Origin") or not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + _token):
            self.reply(403)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if self.headers.get("Transfer-Encoding") or not 1 <= size <= 262144:
                self.reply(413)
                return
            req = json.loads(self.rfile.read(size))
            if not isinstance(req, dict) or req.get("jsonrpc") != "2.0":
                raise ValueError()
            method, params, rid = req.get("method"), req.get("params", {}), req.get("id")
            if "id" not in req:
                self.reply(202)
                return
            if method == "initialize":
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "pi-blender-bridge", "version": "1.0.0"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                name, args = params.get("name"), params.get("arguments", {})
                if name not in TOOL_MAP:
                    raise ValueError()
                validate(args, TOOL_MAP[name]["inputSchema"])
                job = {"name": name, "args": args, "done": threading.Event(), "lock": threading.Lock(),
                       "deadline": time.monotonic() + 25, "cancelled": False, "started": False}
                try:
                    _jobs.put_nowait(job)
                except queue.Full:
                    self.reply(503, {"error": "queue full"})
                    return
                if not job["done"].wait(25):
                    with job["lock"]:
                        job["cancelled"] = True
                    self.reply(504, {"error": "timeout; reconcile write before retry"})
                    return
                result = job.get("result", {"isError": True, "content": [{"type": "text", "text": "Request expired before execution"}]})
            else:
                self.reply(200, {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Unknown method"}})
                return
            self.reply(200, {"jsonrpc": "2.0", "id": rid, "result": result})
        except Exception:
            self.reply(400, {"error": "Invalid request"})

def start(config_path=None, timers=True):
    global _server, _thread, _config, _token
    if _server:
        return
    path = config_path or os.environ.get("PI_BLENDER_SERVER_CONFIG") or str(Path.home() / ".pi/agent/editors/blender-server.json")
    config = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if set(config) != {"version", "port", "tokenFile", "assetRoot", "allowWrites"} or config["version"] != 1 or type(config["allowWrites"]) is not bool or type(config["port"]) is not int or not 1024 <= config["port"] <= 65535:
        raise ValueError("Invalid server config")
    if not Path(config["tokenFile"]).is_absolute() or not Path(config["assetRoot"]).is_absolute() or not Path(config["assetRoot"]).is_dir():
        raise ValueError("Server paths must be absolute and assetRoot must exist")
    token = Path(config["tokenFile"]).read_text().strip()
    if not 24 <= len(token) <= 256 or not all(c.isalnum() or c in "_-" for c in token):
        raise ValueError("Invalid token")
    server = LimitedServer(("127.0.0.1", config["port"]), Handler)
    _config, _token, _server = config, token, server
    _thread = threading.Thread(target=server.serve_forever, daemon=True)
    _thread.start()
    if timers:
        bpy.app.timers.register(tick, first_interval=0.05)
def stop():
    global _server, _thread, _token
    server, _server = _server, None
    if server:
        server.shutdown()
        server.server_close()
    if _thread:
        _thread.join(timeout=2)
        _thread = None
    while not _jobs.empty():
        job = _jobs.get_nowait()
        job["cancelled"] = True
        job["done"].set()
    _token = None
    if bpy.app.timers.is_registered(tick):
        bpy.app.timers.unregister(tick)
def before_load(_dummy):
    stop()
class PI_OT_start(bpy.types.Operator):
    bl_idname = "pi_bridge.start"
    bl_label = "Start Pi Blender Bridge"
    def execute(self, context):
        try:
            start()
            self.report({"INFO"}, "Pi Blender Bridge connected to localhost")
            return {"FINISHED"}
        except Exception:
            self.report({"ERROR"}, "Check Pi Blender server config and port")
            return {"CANCELLED"}
class PI_OT_stop(bpy.types.Operator):
    bl_idname = "pi_bridge.stop"
    bl_label = "Stop Pi Blender Bridge"
    def execute(self, context):
        stop()
        return {"FINISHED"}
def draw_bridge_menu(self, context):
    self.layout.separator()
    row = self.layout.row()
    row.enabled = _server is None
    row.operator(PI_OT_start.bl_idname, text="Start Pi Blender Bridge")
    row = self.layout.row()
    row.enabled = _server is not None
    row.operator(PI_OT_stop.bl_idname, text="Stop Pi Blender Bridge")

def register():
    bpy.utils.register_class(PI_OT_start)
    bpy.utils.register_class(PI_OT_stop)
    bpy.types.TOPBAR_MT_edit.append(draw_bridge_menu)
    if before_load not in bpy.app.handlers.load_pre:
        bpy.app.handlers.load_pre.append(before_load)
def unregister():
    stop()
    bpy.types.TOPBAR_MT_edit.remove(draw_bridge_menu)
    if before_load in bpy.app.handlers.load_pre:
        bpy.app.handlers.load_pre.remove(before_load)
    bpy.utils.unregister_class(PI_OT_stop)
    bpy.utils.unregister_class(PI_OT_start)
