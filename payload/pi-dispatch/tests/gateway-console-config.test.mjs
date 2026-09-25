import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig, saveConfig } from '../pi-extensions/desktop-monitor/electron/config-store.mjs';

const defaults = { maxConcurrency: 4, maxQueue: 16, maxRequestBytes: 102400 };
const valid = { maxConcurrency: 3, maxQueue: 12, maxRequestBytes: 2048 };

async function withConfig(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gateway-console-config-'));
  try {
    await run(path.join(dir, 'config.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('existing empty config uses defaults and read exposes only the public result', async () => {
  await withConfig(async file => {
    await writeFile(file, '{}');
    const result = await readConfig(file);
    assert.deepEqual(result.settings, defaults);
    assert.equal(result.restartRequired, false);
    assert.match(result.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(result).sort(), ['restartRequired', 'revision', 'settings']);
  });
});

test('null and omitted root-level settings default; save preserves unrelated benign data', async () => {
  await withConfig(async file => {
    await writeFile(file, JSON.stringify({ maxConcurrency: null, internalNote: 'opaque-marker' }));
    const initial = await readConfig(file);
    assert.deepEqual(initial.settings, defaults);
    const saved = await saveConfig(file, valid, initial.revision);
    assert.deepEqual(saved.settings, valid);
    assert.equal(saved.restartRequired, true);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.internalNote, 'opaque-marker');
    assert.deepEqual({
      maxConcurrency: stored.maxConcurrency,
      maxQueue: stored.maxQueue,
      maxRequestBytes: stored.maxRequestBytes,
    }, valid);
    assert.equal('settings' in stored, false);
  });
});

test('save validates numeric limits, types, and extra settings keys', async () => {
  await withConfig(async file => {
    await writeFile(file, '{}');
    const initial = await readConfig(file);
    const cases = [
      { ...valid, maxConcurrency: 0 },
      { ...valid, maxConcurrency: 5 },
      { ...valid, maxQueue: 0 },
      { ...valid, maxQueue: 65 },
      { ...valid, maxRequestBytes: 1023 },
      { ...valid, maxRequestBytes: 1048577 },
      { ...valid, maxQueue: '12' },
      { ...valid, internalNote: 'opaque-marker' },
    ];
    for (const settings of cases) {
      await assert.rejects(saveConfig(file, settings, initial.revision), error => error.code === 'CONFIG_INVALID');
    }
  });
});

test('stale valid revision is rejected without modifying the file', async () => {
  await withConfig(async file => {
    const original = JSON.stringify({ ...defaults, internalNote: 'opaque-marker' });
    await writeFile(file, original);
    const actualRevision = createHash('sha256').update(original).digest('hex');
    const staleRevision = actualRevision === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await assert.rejects(saveConfig(file, valid, staleRevision), error => error.code === 'CONFIG_STALE');
    assert.equal(await readFile(file, 'utf8'), original);
  });
});

test('malformed config and missing file report generic coded errors', async () => {
  await withConfig(async file => {
    await writeFile(file, '{');
    await assert.rejects(readConfig(file), error => error.code === 'CONFIG_INVALID' && !error.message.includes('{'));
    await rm(file);
    await assert.rejects(readConfig(file), error => error.code === 'CONFIG_IO');
  });
});
