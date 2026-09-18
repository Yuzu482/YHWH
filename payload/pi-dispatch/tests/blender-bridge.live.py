import importlib.util
import json
import os
import sys
from pathlib import Path
import time
import bpy

sys.dont_write_bytecode = True

root = Path(os.environ['PI_EDITOR_TEST_ROOT'])
source = Path(os.environ['PI_EDITOR_ADDON'])
spec = importlib.util.spec_from_file_location('pi_blender_bridge', source)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
addon.start(str(root / 'server.json'), timers=False)
print('PI_BLENDER_READY', flush=True)
try:
    deadline = time.monotonic() + 90
    while not (root / 'stop').exists() and time.monotonic() < deadline:
        addon.tick()
        time.sleep(0.02)
finally:
    addon.stop()
    print('PI_BLENDER_STOPPED', flush=True)
