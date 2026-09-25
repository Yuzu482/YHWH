import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = dirname(fileURLToPath(import.meta.url));
const dispatchRoot = resolve(electronDir, '../../..');
const repoRoot = resolve(dispatchRoot, '../..');
const outputDir = join(repoRoot, 'release', 'desktop-console');
const runtimeDir = join(electronDir, 'node_modules', 'electron', 'dist');
const appSourceDir = join(dispatchRoot, 'pi-extensions', 'desktop-monitor', 'electron');
const feedSource = join(dispatchRoot, 'pi-extensions', 'desktop-monitor', 'feed.mjs');
const proxySource = join(dispatchRoot, 'scripts', 'stdio-proxy.mjs');
const dependenciesDir = join(dispatchRoot, 'node_modules');
const licenseSource = join(repoRoot, 'LICENSE');
const appFiles = ['main.mjs', 'config-store.mjs', 'preload.cjs', 'index.html', 'renderer.js', 'style.css'];

async function requireFile(path) {
  if (!(await stat(path)).isFile()) throw new Error(`Required file missing: ${path}`);
}
async function requireDirectory(path) {
  if (!(await stat(path)).isDirectory()) throw new Error(`Required directory missing: ${path}`);
}
async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() || entry.isFile()) await copyTree(from, to);
    }
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

let stagingDir;
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Packaging is supported only on Windows x64');
  await requireDirectory(runtimeDir);
  await requireFile(join(runtimeDir, 'electron.exe'));
  await requireFile(join(runtimeDir, 'LICENSE'));
  await requireFile(join(runtimeDir, 'LICENSES.chromium.html'));
  await requireDirectory(appSourceDir);
  for (const name of appFiles) await requireFile(join(appSourceDir, name));
  await requireFile(feedSource);
  await requireFile(proxySource);
  await requireDirectory(dependenciesDir);
  await requireFile(licenseSource);

  try {
    await lstat(outputDir);
    throw new Error(`Refusing to overwrite existing destination: ${outputDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const releaseDir = dirname(outputDir);
  await mkdir(releaseDir, { recursive: true });
  stagingDir = await mkdtemp(join(releaseDir, '.desktop-console-staging-'));
  await copyTree(runtimeDir, stagingDir);
  await rename(join(stagingDir, 'electron.exe'), join(stagingDir, 'YHWH-Pi-Gateway.exe'));

  const appDir = join(stagingDir, 'resources', 'app');
  const electronAppDir = join(appDir, 'pi-extensions', 'desktop-monitor', 'electron');
  await mkdir(electronAppDir, { recursive: true });
  for (const name of appFiles) await copyFile(join(appSourceDir, name), join(electronAppDir, name));
  await mkdir(join(appDir, 'pi-extensions', 'desktop-monitor'), { recursive: true });
  await copyFile(feedSource, join(appDir, 'pi-extensions', 'desktop-monitor', 'feed.mjs'));
  await copyTree(proxySource, join(appDir, 'scripts', 'stdio-proxy.mjs'));
  await copyTree(dependenciesDir, join(appDir, 'node_modules'));
  await copyFile(licenseSource, join(appDir, 'LICENSE'));
  await writeFile(join(appDir, 'package.json'), `${JSON.stringify({
    name: 'yhwh-pi-desktop-console',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'pi-extensions/desktop-monitor/electron/main.mjs'
  }, null, 2)}\n`);

  await rename(stagingDir, outputDir);
  stagingDir = undefined;
  console.log(`Windows x64 portable package staged at ${outputDir}`);
} catch (error) {
  if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  console.error(error?.message ?? error);
  process.exitCode = 1;
}
