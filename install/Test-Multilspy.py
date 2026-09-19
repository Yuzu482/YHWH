# SPDX-License-Identifier: Apache-2.0
"""Optional Windows -> WSL verification using temporary fixtures, no service upgrade.

Supply wheel files matching payload/multilspy-requirements.txt and the TypeScript
6.0.3 archive matching payload/wsl-package-lock.json. This script never downloads.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess

REMOTE = r'''
import asyncio,base64,importlib.util,json,os,pathlib,pwd,shutil,subprocess,sys,tarfile,tempfile,venv,zipfile
packet=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='yhwh-multilspy-check-') as temp:
 root=pathlib.Path(temp);deps=root/'deps';deps.mkdir()
 for name,data in packet['files'].items():
  p=root/name
  if not p.resolve().is_relative_to(root):raise RuntimeError('Unsafe fixture path')
  p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(data))
 for wheel in (root/'wheels').glob('*.whl'):
  with zipfile.ZipFile(wheel) as archive:
   for name in archive.namelist():
    if not (deps/name).resolve().is_relative_to(deps):raise RuntimeError('Unsafe wheel path')
   archive.extractall(deps)
 env={**os.environ,'PYTHONPATH':str(deps),'PATH':'/opt/node/bin:/opt/pi-kether/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'}
 subprocess.run([sys.executable,str(root/'tests/multilspy-probe.test.py')],env=env,check=True)
 if not packet['live']:sys.exit(0)
 with tarfile.open(root/'typescript.tgz') as archive:archive.extractall(root/'typescript-lsp',filter='data')
 sys.path.insert(0,str(deps));spec=importlib.util.spec_from_file_location('probe',root/'scripts/multilspy-probe.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
 probe.TSSERVER=str(root/'typescript-lsp/package/lib/tsserver.js');os.environ['PATH']=env['PATH'];os.environ['PYTHONPATH']=str(deps)
 probe.JEDI_COMMAND=[sys.executable,'-c','from jedi_language_server.cli import cli; cli()']
 workspace=root/'workspace';workspace.mkdir()
 py=workspace/'check.py';py.write_text(chr(10).join(['def answer() -> int:', '    return 42', 'value: int = "wrong"', 'answer()', '']))
 ts=workspace/'check.ts';ts.write_text(chr(10).join(['const value: number = "wrong";', 'value;', '']))
 for path,tool,params in [(py,'lsp_diagnostics',{}),(py,'lsp_definition',{'line':4,'character':2}),(ts,'lsp_diagnostics',{}),(ts,'lsp_hover',{'line':2,'character':2})]:
  result=asyncio.run(probe.execute({'tool':tool,'params':{'path':str(path),**params}},root=workspace))
  assert result['ok'] and result['serverCleanup']['ok'],result
  if tool=='lsp_diagnostics':assert result['diagnosticsPublished'] and result['result']['details']['data'],result
  if path==ts and tool=='lsp_diagnostics':assert result['diagnosticCompletion']['complete'],result
  print('LIVE PASS',path.suffix,tool,result['status'],flush=True)
 # Repeat both erroneous and clean snapshots: a single nonempty notification
 # previously hid an intermittent early-empty TypeScript result.
 large=workspace/'large.ts'
 large.write_text(''.join(f'function item_{i}(value: number): number {{ return value + {i}; }}\n' for i in range(1000))
                  +'const wrong: number = "wrong";\n')
 clean=workspace/'clean.ts';clean.write_text('export const value: number = 42;\n')
 for repetition in range(3):
  for path in (ts,large,clean):
   result=asyncio.run(probe.execute({'tool':'lsp_diagnostics','params':{'path':str(path)}},root=workspace))
   assert result['ok'] and result['serverCleanup']['ok'] and result['diagnosticsPublished'],result
   complete=result['diagnosticCompletion'];assert complete['complete'] and complete['commands']==list(probe.TS_DIAGNOSTIC_COMMANDS),result
   diagnostics=result['result']['details']['data']
   assert (diagnostics==[]) if path==clean else any(d.get('code')==2322 for d in diagnostics),result
   print('REPEATED TS PASS',path.name,repetition+1,flush=True)
 # Overlay a temporary /opt/pi-kether inside bwrap. The real installed tree is read-only.
 runtime=root/'runtime';runtime.mkdir();modules=runtime/'node_modules';modules.mkdir()
 for item in pathlib.Path('/opt/pi-kether/node_modules').iterdir():
  if item.name!='typescript-lsp':(modules/item.name).symlink_to('/upstream/node_modules/'+item.name)
 shutil.copytree(root/'typescript-lsp/package',modules/'typescript-lsp')
 shutil.copytree(root/'scripts',runtime/'scripts')
 venv.EnvBuilder(with_pip=False).create(runtime/'multilspy-venv')
 site=runtime/'multilspy-venv/lib/python3.12/site-packages'
 # venv is new and empty; copy verified wheels' contents without installing into the host.
 shutil.copytree(deps,site,dirs_exist_ok=True)
 home=root/'home';home.mkdir()
 for base,dirs,files in os.walk(root):
  os.chmod(base,0o755)
  for name in files:
   path=pathlib.Path(base)/name
   if not path.is_symlink():path.chmod(0o644)
 runtime.joinpath('multilspy-venv/bin/python').resolve().is_file() or sys.exit(2)
 for executable in runtime.joinpath('multilspy-venv/bin').glob('python*'):executable.chmod(0o755)
 account=pwd.getpwnam('pi-sandbox');os.chown(home,account.pw_uid,account.pw_gid);home.chmod(0o700)
 baseline={p.name:p.read_bytes() for p in workspace.iterdir()}
 base=['setpriv','--reuid=pi-sandbox','--regid=pi-sandbox','--init-groups','bwrap','--die-with-parent','--new-session',
  '--unshare-net','--unshare-user','--unshare-pid','--unshare-uts','--unshare-ipc','--cap-drop','ALL',
  '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64',
  '--ro-bind','/opt','/opt','--ro-bind','/opt/pi-kether','/upstream','--ro-bind',str(runtime),'/opt/pi-kether',
  '--dev','/dev','--tmpfs','/tmp','--dir','/proc','--ro-bind',str(workspace),'/workspace',
  '--dir','/home','--bind',str(home),'/home/pi-sandbox','--chdir','/workspace','--clearenv',
  '--setenv','HOME','/home/pi-sandbox','--setenv','PATH','/opt/node/bin:/opt/pi-kether/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  '--','/bin/bash','-c','exec 3</dev/null; exec /opt/node/bin/node -e "$1"','fixture',
  "const f=require('fs');if(f.readdirSync('/proc').length)process.exit(10);f.fstatSync(3);import('/opt/pi-kether/scripts/direct-lsp-bootstrap.mjs')"]
 for name,tool,params in [('check.py','lsp_diagnostics',{}),('check.ts','lsp_diagnostics',{}),('check.py','lsp_definition',{'line':4,'character':2}),('check.ts','lsp_hover',{'line':2,'character':2}),('check.py','code_overview',{}),('check.py','ast_search',{'pattern':'answer()','language':'python'})]:
  request={'tool':tool,'params':{'path':'/workspace/'+name,**params}}
  completed=subprocess.run(base,input=json.dumps(request),capture_output=True,text=True,timeout=90)
  assert completed.returncode==0,(completed.returncode,completed.stdout,completed.stderr)
  result=json.loads(completed.stdout);assert result['ok'] and result['modelCalls']==0,result
  expected='multilspy' if tool.startswith('lsp_') else 'pi-lsp-extension'
  assert result['engine']==expected,result
  if tool=='lsp_diagnostics':assert result['diagnosticsPublished'] and result['serverCleanup']['ok'] and result['result']['details']['data'],result
  if name.endswith('.ts') and tool=='lsp_diagnostics':assert result['diagnosticCompletion']['complete'],result
  if tool.startswith('lsp_'):
   expected_adapter='official-typescript' if name.endswith('.ts') else ('controlled-protocol' if tool=='lsp_diagnostics' else 'official-jedi')
   assert result['adapter']==expected_adapter and result['serverCleanup']['ok'],result
  print('SANDBOX PASS',name,tool,result['engine'],'empty /proc, no network, read-only workspace',flush=True)
 assert baseline=={p.name:p.read_bytes() for p in workspace.iterdir()}
 print('PASS: fixture files unchanged; installed runtime and credentials untouched.',flush=True)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheel-dir', type=Path, required=True)
    parser.add_argument('--typescript-archive', type=Path)
    parser.add_argument('--distro', default='Ubuntu-24.04')
    parser.add_argument('--skip-live', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    files = {}
    def add(name, data):
        files[name] = base64.b64encode(data).decode('ascii')
    for name in ['multilspy-probe.py','direct-lsp-bootstrap.mjs','legacy-structural-bootstrap.mjs','lsp-result.mjs']:
        add('scripts/'+name, (root/'payload/pi-dispatch/scripts'/name).read_bytes())
    for name in ['multilspy-probe.test.py','multilspy-server-fixture.py']:
        add('tests/'+name, (root/'payload/pi-dispatch/tests'/name).read_bytes())
    inventory = json.loads((root/'licenses/multilspy-dependencies.json').read_text(encoding='utf-8'))
    for entry in inventory['packages']:
        data = (args.wheel_dir/entry['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Wheel digest mismatch: '+entry['file'])
        add('wheels/'+entry['file'], data)
    if not args.skip_live:
        if args.typescript_archive is None:
            parser.error('--typescript-archive is required for live checks')
        data = args.typescript_archive.read_bytes()
        lock = json.loads((root/'payload/wsl-package-lock.json').read_text(encoding='utf-8'))
        expected = lock['packages']['node_modules/typescript-lsp']['integrity']
        actual = 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode('ascii')
        if actual != expected:
            raise ValueError('TypeScript archive integrity mismatch')
        add('typescript.tgz', data)
    result = subprocess.run(['wsl.exe','-d',args.distro,'-u','root','--exec','python3','-c',REMOTE],
                            input=json.dumps({'files':files,'live':not args.skip_live}).encode('utf-8'))
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
