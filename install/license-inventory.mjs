// SPDX-License-Identifier: Apache-2.0
// Deterministic metadata inventory; not a complete license/provenance audit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => !['--check','--public'].includes(arg))) throw new Error('Usage: node install/license-inventory.mjs [--check] [--public]');
const check = args.includes('--check');
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file).toString('utf8').replace(/^\uFEFF/, ''));
const requireTrue = (value, message) => { if (!value) throw new Error(message); };
const plugin = 'payload/pi-dispatch/';
if(args.includes('--public')) {
  const version=json('portable.manifest.json').components.piLspExtension;
  requireTrue(['1.3.0','1.4.0'].includes(version),'Public release blocked: unsupported pi-lsp-extension licensing evidence.');
  // Preserve the historical 1.3.0 hold. The new evidence applies only to the
  // 1.4.0 npm archive, which itself includes the verified upstream notice.
  const evidence=json(version==='1.3.0'?'licenses/pi-lsp-extension-evidence.json':'licenses/pi-lsp-extension-1.4.0-evidence.json');
  requireTrue(evidence.status === 'upstream-notice-verified', 'Public release blocked: the upstream pi-lsp-extension notice or its explicit coverage of the pinned version is not verified. Local preview packaging remains available.');
  const notice=evidence.upstreamNotice;
  requireTrue(notice && typeof notice.file==='string' && notice.file.startsWith('licenses/') && !notice.file.includes('..') && /^https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/samfoy\/pi-lsp-extension\//.test(notice.source), 'Public release requires a traceable upstream notice.');
  requireTrue(createHash('sha256').update(read(notice.file)).digest('hex')===notice.sha256, 'Upstream notice digest mismatch.');
  if(version==='1.4.0') {
    const lock=json('payload/wsl-package-lock.json'), entry=lock.packages['node_modules/pi-lsp-extension'];
    const metadata=json('licenses/pi-lsp-extension-1.4.0.package.json');
    requireTrue(evidence.version===version && evidence.declaredLicense==='MIT' && evidence.licenseInPublishedTarball===true &&
      evidence.gitHead==='ca0b3b8e53da5b814bf851bca0be47e7b413b122' &&
      evidence.integrity==='sha512-FOwGIivoZt5YfVY/LGqQZf4+wPXT+73loKOQ3Lu6zeG2UAPCxelHT21zXG/qCVD32epq8FymH9dJ8EnotXkv4Q==' &&
      notice.sha256==='65966b294b74544c0fbd282e30d64a736956110370a20d3f86dc2b7358cda3ba' &&
      notice.source==='https://raw.githubusercontent.com/samfoy/pi-lsp-extension/ca0b3b8e53da5b814bf851bca0be47e7b413b122/LICENSE' &&
      lock.packages[''].dependencies['pi-lsp-extension']===version && entry?.version===version && entry.integrity===evidence.integrity &&
      metadata.name==='pi-lsp-extension' && metadata.version===version && metadata.license==='MIT',
      'Public release requires matching 1.4.0 archive, lockfile and upstream license evidence.');
  }
}
requireTrue(json('portable.manifest.json').license === 'Apache-2.0', 'Manifest license mismatch');
requireTrue(json(plugin+'package.json').license === 'Apache-2.0', 'Package license mismatch');
requireTrue(json(plugin+'package-lock.json').packages[''].license === 'Apache-2.0', 'Lockfile license mismatch');
for (const material of json('licenses/sources.json').materials) {
  requireTrue(createHash('sha256').update(read(material.file)).digest('hex') === material.sha256, `Original material changed: ${material.file}`);
}
const pythonPackages=json('licenses/multilspy-dependencies.json').packages;
const toolchains=json('licenses/go-rust-runtime.json');
const provision=read('install/provision-go-rust.sh').toString('utf8').replace(/\r\n/g,'\n');
for(const [name,version] of Object.entries(toolchains.versions)) requireTrue(json('portable.manifest.json').components[name]===version, `Toolchain manifest mismatch: ${name}`);
for(const item of toolchains.artifacts) requireTrue(provision.includes(item.sha256), `Toolchain checksum missing: ${item.url}`);
for(const [name,value] of [['GO_VERSION',toolchains.versions.go],['GOPLS_VERSION','v'+toolchains.versions.gopls],['RUST_VERSION',toolchains.versions.rust]]) requireTrue(provision.includes(`${name}=${value}\n`), `Toolchain version mismatch: ${name}`);
const pythonLock=read('payload/multilspy-requirements.txt').toString('utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
requireTrue(pythonLock.length===pythonPackages.length, 'Python lock/inventory package count mismatch');
for(const entry of pythonPackages) requireTrue(pythonLock.includes(`${entry.name}==${entry.version} --hash=sha256:${entry.sha256}`), `Python dependency pin mismatch: ${entry.name}`);
requireTrue(pythonPackages.find(entry=>entry.name==='multilspy')?.version===json('portable.manifest.json').components.multilspy, 'multilspy manifest mismatch');
const locks = [plugin+'package-lock.json', 'payload/wsl-package-lock.json'];
const packages = locks.flatMap(lockfile => Object.entries(json(lockfile).packages).filter(([key]) => key).sort(([a],[b])=> a < b ? -1 : a > b ? 1 : 0).map(([packagePath, entry]) => ({
  lockfile, packagePath, name: entry.name ?? packagePath.split('node_modules/').at(-1),
  version: entry.version ?? null, declaredLicense: entry.license ?? null,
  resolved: entry.resolved ?? null, integrity: entry.integrity ?? null,
  optional: entry.optional === true,
})));
const inventory = {schemaVersion:1, scope:'npm lockfile declarations only; includes optional/transitive packages; excludes system dependencies; not a license-text or provenance audit', packages};
const notices = ['licenses/code-graph-tree-sitter-notices.txt','licenses/multilspy-dependency-notices.txt','licenses/pi-1.5.1-MIT.txt','licenses/pi-claude-code-provider-0.1.4-MIT.txt','licenses/MIT-standard-reference.txt','licenses/pi-lsp-extension-NOTICE.txt','licenses/pi-lsp-extension-upstream-20260924-LICENSE.txt','licenses/claude-code-2.1.250-NOTICE.txt'];
const standalone = 'Third-party notices for the YHWH Pi integration\n\nDependencies retain their own licenses. These notices do not license Claude services.\nThe complete source distribution also contains THIRD_PARTY.md and a lockfile inventory.\n\n'+notices.map(file => `${path.basename(file)}\n${'='.repeat(60)}\n${read(file).toString('utf8').trim()}\n`).join('\n');
const outputs = new Map([
  ['licenses/dependency-inventory.json', Buffer.from(JSON.stringify(inventory,null,2)+'\n')],
  [plugin+'LICENSE',read('LICENSE')], [plugin+'NOTICE',read('NOTICE')],
  [plugin+'THIRD_PARTY_NOTICES.txt',Buffer.from(standalone)],
]);
for (const [file, data] of outputs) {
  if (check) requireTrue(fs.existsSync(path.join(root,file)) && read(file).equals(data), `Generated licensing material is missing/stale: ${file}`);
  else fs.writeFileSync(path.join(root,file),data);
}
console.log(`${check?'Verified':'Generated'} licensing materials; ${packages.length} lockfile entries; ${packages.filter(p=>p.declaredLicense===null).length} missing license declarations. This does not approve redistribution or service use.`);
