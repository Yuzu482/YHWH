import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicAuthWrite } from '../scripts/openai-auth-store.mjs';

const sections = '[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group';
const runPs = (script, root, fixture, expected) => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 65536, stdio: 'pipe', env: { ...process.env, YHWH_ACL_FIXTURE: fixture, YHWH_ACL_EXPECTED: expected, PSModulePath: '', PSModuleAnalysisCachePath: '' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), '');
};

test('preserves protected ACL metadata', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-preservation-'));
  try {
    const file = path.join(root, 'fixture.json');
    const expected = path.join(root, 'snapshot.txt');
    fs.writeFileSync(file, `${JSON.stringify({ version: 1 })}\n`);
    runPs(`$file=$env:YHWH_ACL_FIXTURE
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl=[System.IO.File]::GetAccessControl($file,${sections})
$acl.SetAccessRuleProtection($true,$false)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity.User,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetAccessRule($rule)
[System.IO.File]::SetAccessControl($file,$acl)
$check=[System.IO.File]::GetAccessControl($file,${sections})
if(-not $check.AreAccessRulesProtected){exit 1}
[System.IO.File]::WriteAllText($env:YHWH_ACL_EXPECTED,$check.GetSecurityDescriptorSddlForm(${sections}))`, root, file, expected);
    atomicAuthWrite(file, { version: 2 }, { preserveAclFrom: file });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 2 });
    runPs(`$acl=[System.IO.File]::GetAccessControl($env:YHWH_ACL_FIXTURE,${sections})
$sddl=$acl.GetSecurityDescriptorSddlForm(${sections})
if(-not $acl.AreAccessRulesProtected -or $sddl -ne [System.IO.File]::ReadAllText($env:YHWH_ACL_EXPECTED)){exit 1}`, root, file, expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fails without ACL source without changing the fixture', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-preservation-'));
  try {
    const file = path.join(root, 'fixture.json');
    const source = path.join(root, 'missing.json');
    fs.writeFileSync(file, `${JSON.stringify({ version: 1 })}\n`);
    const before = fs.readFileSync(file);
    assert.throws(() => atomicAuthWrite(file, { version: 2 }, { preserveAclFrom: source }), { code: 'PI_AUTH_RENEW_PERSIST_FAILED' });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.readdirSync(root).some(name => name.includes('.tmp')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
