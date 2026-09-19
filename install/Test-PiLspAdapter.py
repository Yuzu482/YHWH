"""Verify the custom Pi extension through the installed SDK and isolated servers.

Uses temporary fixtures and no provider credentials or model requests.
Requires the already provisioned YHWH WSL runtime; does not deploy files.
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess

REMOTE = r'''
import base64,json,os,pathlib,shutil,subprocess,sys,tempfile,uuid
p=json.load(sys.stdin)
job=pathlib.Path('/var/lib/pi-kether/jobs')/str(uuid.uuid4())
group=pathlib.Path('/sys/fs/cgroup')/('pi-kether-'+job.name)
with tempfile.TemporaryDirectory(prefix='yhwh-pi-lsp-test-') as temp:
 stage=pathlib.Path(temp);stage.chmod(0o755)
 for name,data in p['files'].items():
  target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(base64.b64decode(data))
 if p.get('installed'):
  for name in ['extensions/lsp-proxy.js','scripts/lsp-sandbox-broker.mjs','scripts/editor-pi-bootstrap.mjs','scripts/editor-rpc.mjs','scripts/multilspy-probe.py','scripts/csharp-probe-project.mjs','scripts/java-probe-launch.py']:
   shutil.copyfile(pathlib.Path('/opt/pi-kether')/name,stage/name)
  shutil.copyfile('/usr/local/libexec/pi-kether-sandbox',stage/'pi-kether-sandbox')
 else:
  broker=stage/'scripts/lsp-sandbox-broker.mjs'
  anchor="'--ro-bind','/opt','/opt',"
  source=broker.read_text();assert source.count(anchor)==1
  broker.write_text(source.replace(anchor,anchor+"'--ro-bind',"+json.dumps(str(stage/'scripts/multilspy-probe.py'))+",'/opt/pi-kether/scripts/multilspy-probe.py','--ro-bind',"+json.dumps(str(stage/'scripts/java-probe-launch.py'))+",'/java-probe-launch.py',"))
  probe=stage/'scripts/multilspy-probe.py'
  probe.write_text(probe.read_text().replace('/opt/pi-kether/scripts/java-probe-launch.py','/java-probe-launch.py'))
 (stage/'package.json').write_text('{"type":"module"}')
 # Replace only the test stage's auth/model bootstrap with the SDK fixture.
 shutil.copyfile(stage/'tests/lsp-adapter-agent.mjs',stage/'scripts/secure-pi-bootstrap.mjs')
 subprocess.run(['/bin/bash','-n',str(stage/'pi-kether-sandbox')],check=True)
 subprocess.run(['/opt/node/bin/node','--check',str(stage/'scripts/lsp-sandbox-broker.mjs')],check=True)
 if not p.get('installed'):
  subprocess.run(['/opt/pi-kether/multilspy-venv/bin/python',str(stage/'tests/multilspy-probe.test.py')],check=True,timeout=90)
 job.mkdir(mode=0o755); workspace=job/'workspace';workspace.mkdir(mode=0o755)
 try:
  pathlib.Path('/sys/fs/cgroup/cgroup.subtree_control').write_text('+memory +cpu +pids')
  group.mkdir()
  for name,value in [('memory.max','3221225472'),('memory.swap.max','0'),('pids.max','128'),('cpu.max','100000 100000')]:
   (group/name).write_text(value)
  source=workspace/'check.ts';source.write_text('const value: number = 1;\nconsole.log(value);\n')
  subprocess.run(['/bin/chown','-R','pi-sandbox:pi-sandbox',str(workspace)],check=True)
  # Actual descriptor confinement and the exact production probe isolation args.
  verify=r"""
import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {snapshotProbeFile,probeSandboxArgs} from './scripts/lsp-sandbox-broker.mjs';
const w=process.argv[2];assert.match(snapshotProbeFile(w,'check.ts').toString(),/number/);
fs.symlinkSync('/etc',w+'/outside');assert.throws(()=>snapshotProbeFile(w,'outside/passwd'));
fs.symlinkSync('/etc/passwd',w+'/escape.ts');assert.throws(()=>snapshotProbeFile(w,'escape.ts'));
fs.unlinkSync(w+'/outside');fs.unlinkSync(w+'/escape.ts');
const args=probeSandboxArgs(w);args.splice(args.lastIndexOf('--')+1,99,'/opt/node/bin/node','-e',
  `const fs=require('fs'),net=require('net');if(fs.readdirSync('/proc').length||process.env.TEST_SECRET)process.exit(10);try{fs.writeFileSync('/workspace/check.ts','bad');process.exit(11);}catch(e){if(!['EROFS','EACCES'].includes(e.code))process.exit(12);}const s=net.connect(9,'192.0.2.1');s.on('connect',()=>process.exit(13));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(14),2000);`);
const r=spawnSync('/usr/bin/setpriv',args,{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin',TEST_SECRET:'synthetic-not-a-key'}});assert.equal(r.status,0,r.stderr);
console.log(JSON.stringify({fixture:'descriptor-confinement-and-isolation',passed:true,modelCalls:0}));
const cs=probeSandboxArgs(w,'fixture.cs');cs.splice(cs.lastIndexOf('--')+1,99,'/opt/node/bin/node','-e',
  `const fs=require('fs'),net=require('net');if(!fs.readFileSync('/proc/self/maps','utf8')||process.env.TEST_SECRET||fs.existsSync('/proc/${process.pid}'))process.exit(20);try{fs.writeFileSync('/proc/yhwh-write','x');process.exit(21);}catch(e){if(!['EROFS','EACCES','ENOENT'].includes(e.code))process.exit(22);}try{fs.writeFileSync('/workspace/check.ts','bad');process.exit(23);}catch(e){if(!['EROFS','EACCES'].includes(e.code))process.exit(24);}if(fs.existsSync('/proc/1/root/var/lib/pi-kether/jobs')||fs.existsSync('/mnt/c'))process.exit(25);const s=net.connect(9,'192.0.2.1');s.on('connect',()=>process.exit(26));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(27),2000);`);
const cr=spawnSync('/usr/bin/setpriv',cs,{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin',TEST_SECRET:'synthetic-not-a-key'}});assert.equal(cr.status,0,cr.stderr);
console.log(JSON.stringify({fixture:'csharp-private-pid-readonly-no-network-no-host-root',passed:true,modelCalls:0}));
const go=probeSandboxArgs(w,'fixture.go');go.splice(go.lastIndexOf('--')+1,99,...cs.slice(cs.lastIndexOf('--')+1));
const gr=spawnSync('/usr/bin/setpriv',go,{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin',TEST_SECRET:'synthetic-not-a-key'}});assert.equal(gr.status,0,gr.stderr);
console.log(JSON.stringify({fixture:'go-private-pid-readonly-no-network-no-host-root',passed:true,modelCalls:0}));
const ja=probeSandboxArgs(w,'Sample.java');ja.splice(ja.lastIndexOf('--')+1,99,'/opt/node/bin/node','-e',
 `const fs=require('fs'),net=require('net');if(fs.readdirSync('/proc').length||process.env.TEST_SECRET||fs.existsSync('/etc/java-21-openjdk/management'))process.exit(30);if(!fs.readFileSync('/etc/java-21-openjdk/security/java.security','utf8'))process.exit(31);for(const p of ['/workspace/check.ts','/etc/java-21-openjdk/security/java.security']){try{fs.writeFileSync(p,'bad');process.exit(32);}catch(e){if(!['EROFS','EACCES'].includes(e.code))process.exit(33);}}const s=net.connect(9,'192.0.2.1');s.on('connect',()=>process.exit(34));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(35),2000);`);
const jr=spawnSync('/usr/bin/setpriv',ja,{encoding:'utf8',timeout:8000,env:{PATH:'/usr/bin:/bin',TEST_SECRET:'synthetic-not-a-key'}});assert.equal(jr.status,0,jr.stderr);
console.log(JSON.stringify({fixture:'java-readonly-security-empty-proc-no-network',passed:true,modelCalls:0}));
"""
  (stage/'verify.mjs').write_text(verify)
  subprocess.run(['/opt/node/bin/node',str(stage/'verify.mjs'),str(workspace)],check=True,timeout=15)
  if p.get('benchmark'):
   subprocess.run(['/opt/node/bin/node',str(stage/'tests/lsp-reuse-benchmark.mjs'),str(workspace)],check=True,timeout=180,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
   source.write_text('const value: number = 1;\nconsole.log(value);\n')
  if p.get('pythonBenchmark'):
   subprocess.run(['/opt/node/bin/node',str(stage/'tests/python-reuse-benchmark.mjs'),str(workspace)],check=True,timeout=180,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
  if p.get('cppBenchmark'):
   probe=(stage/'scripts/multilspy-probe.py').read_text()
   for mode in ['baseline','tuned']:
    profile=probe
    anchor='handler_type = ClangdHandler if language in ("c", "cpp") else SandboxedHandler'
    assert profile.count(anchor)==1
    if mode=='baseline':profile=profile.replace(anchor,'handler_type = SandboxedHandler')
    (stage/('clangd-'+mode+'.py')).write_text(profile)
   subprocess.run(['/opt/node/bin/node',str(stage/'tests/cpp-reuse-benchmark.mjs'),str(workspace)],check=True,timeout=180,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
  if p.get('csharpBenchmark'):
   probe=(stage/'scripts/multilspy-probe.py').read_text()
   for mode in ['baseline','tuned']:
    assert probe.count('class CsharpHandler(ClangdHandler):')==1
    profile=probe.replace('class CsharpHandler(ClangdHandler):','class CsharpHandler(SandboxedHandler):') if mode=='baseline' else probe
    (stage/('csharp-'+mode+'.py')).write_text(profile)
   subprocess.run(['/opt/node/bin/node',str(stage/'tests/csharp-reuse-benchmark.mjs'),str(workspace)],check=True,timeout=180,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
  if p.get('javaBenchmark'):
   probe=(stage/'scripts/multilspy-probe.py').read_text().replace('/opt/pi-kether/scripts/java-probe-launch.py','/java-probe-launch.py')
   (stage/'java-probe.py').write_text(probe)
   launcher=(stage/'scripts/java-probe-launch.py').read_text()
   for mode in ['baseline','tuned']:
    assert launcher.count(', "-XX:TieredStopAtLevel=1"')==1
    profile=launcher.replace(', "-XX:TieredStopAtLevel=1"','') if mode=='baseline' else launcher
    (stage/('java-'+mode+'.py')).write_text(profile)
   subprocess.run(['/opt/node/bin/node',str(stage/'tests/java-reuse-benchmark.mjs'),str(workspace)],check=True,timeout=240,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
  base=['/usr/bin/setpriv','--reuid=pi-sandbox','--regid=pi-sandbox','--init-groups','/usr/bin/bwrap',
   '--die-with-parent','--new-session','--unshare-user','--unshare-pid','--unshare-uts','--unshare-ipc','--cap-drop','ALL',
   '--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind','/opt','/opt',
   '--ro-bind',str(stage),'/adapter','--bind',str(workspace),'/workspace','--dev','/dev','--tmpfs','/tmp','--dir','/proc',
   '--chdir','/workspace','--clearenv','--setenv','HOME','/tmp','--setenv','PATH','/opt/node/bin:/usr/bin:/bin',
   '--','/opt/node/bin/node','/adapter/scripts/editor-pi-bootstrap.mjs']
  nullfd=os.open('/dev/null',os.O_RDONLY)
  if nullfd!=3:os.dup2(nullfd,3);os.close(nullfd)
  try:
   for mode in ['queries','cancel','python','cpp','csharp','java','go','rust']:
    result=subprocess.run(['/opt/node/bin/node',str(stage/'scripts/lsp-sandbox-broker.mjs'),str(workspace),'false','--',*base],
       input=mode,text=True,capture_output=True,pass_fds=(3,),timeout=120,
       preexec_fn=lambda:(group/'cgroup.procs').write_text(str(os.getpid())))
    if result.returncode:raise RuntimeError((result.returncode,result.stdout,result.stderr))
    rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    assert len(rows)==(8 if mode=='queries' else 1),(mode,result.stdout,result.stderr)
    for row in rows:assert row['passed'] and row['modelCalls']==0;print(json.dumps(row),flush=True)
    assert not list(job.glob('lsp-probe-*')),'Probe snapshots were not removed'
  finally:os.close(3)
  print('PASS: real Pi 0.84.4 SDK, IPC broker, seven multilspy tools, current edits, cancellation and isolation; zero model calls.',flush=True)
 finally:
  assert job.parent==pathlib.Path('/var/lib/pi-kether/jobs') and job.name.count('-')==4
  if group.exists():
   (group/'cgroup.kill').write_text('1')
   import time
   for _ in range(50):
    if 'populated 0' in (group/'cgroup.events').read_text():break
    time.sleep(0.1)
   group.rmdir()
  shutil.rmtree(job)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distro', default='Ubuntu-24.04')
    parser.add_argument('--installed', action='store_true', help='Stage the installed runtime adapter bytes instead of repository modules; never modifies installed files')
    parser.add_argument('--benchmark', action='store_true', help='Compare cold and reused real-server queries, and check idle cleanup')
    parser.add_argument('--python-benchmark', action='store_true', help='Compare single-slot and dual-backend Python reuse, including sampled cgroup memory')
    parser.add_argument('--cpp-benchmark', action='store_true', help='Compare old and exit-aware clangd cleanup for C and C++ with identical commands and resource sampling')
    parser.add_argument('--csharp-benchmark', action='store_true', help='Compare C# probe profiles under identical isolation and resource limits')
    parser.add_argument('--java-benchmark', action='store_true', help='Compare default and tier-1 Java JIT with identical isolation and queries')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    plugin = root/'payload/pi-dispatch'
    names = ['extensions/lsp-proxy.js', 'scripts/lsp-sandbox-broker.mjs','scripts/csharp-probe-project.mjs','scripts/java-probe-launch.py',
             'scripts/editor-pi-bootstrap.mjs', 'scripts/editor-rpc.mjs',
             'tests/lsp-adapter-agent.mjs', 'scripts/multilspy-probe.py',
             'tests/multilspy-probe.test.py','tests/multilspy-server-fixture.py','tests/lsp-reuse-benchmark.mjs','tests/python-reuse-benchmark.mjs','tests/cpp-reuse-benchmark.mjs','tests/csharp-reuse-benchmark.mjs','tests/java-reuse-benchmark.mjs']
    files = {name: base64.b64encode((plugin/name).read_bytes()).decode('ascii') for name in names}
    files['pi-kether-sandbox'] = base64.b64encode((plugin/'sandbox/pi-kether-sandbox').read_bytes()).decode('ascii')
    return subprocess.run(['wsl.exe','-d',args.distro,'-u','root','--cd','/','--exec','python3','-c',REMOTE],
                          input=json.dumps({'files':files,'installed':args.installed,'benchmark':args.benchmark,'pythonBenchmark':args.python_benchmark,'cppBenchmark':args.cpp_benchmark,'csharpBenchmark':args.csharp_benchmark,'javaBenchmark':args.java_benchmark}).encode('utf-8')).returncode


if __name__ == '__main__':
    raise SystemExit(main())
