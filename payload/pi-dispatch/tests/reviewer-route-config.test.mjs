import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReviewerRouteConfig, validateReviewerRouteConfig } from '../scripts/reviewer-route-config.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'reviewer-route-'));
  const dir = join(home, '.local', 'state', 'pi-kether');
  mkdirSync(dir, { recursive: true });
  return { home, file: join(dir, 'reviewer-transport.json'), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('missing host config defaults to Claude Code CLI', () => {
  const home = mkdtempSync(join(tmpdir(), 'reviewer-route-'));
  try { assert.deepEqual(loadReviewerRouteConfig(home), { schemaVersion: 1, defaultTransport: 'claude-code-cli' }); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('strict schema accepts only an explicit supported transport', () => {
  assert.deepEqual(validateReviewerRouteConfig({ schemaVersion: 1, defaultTransport: 'anthropic' }), { schemaVersion: 1, defaultTransport: 'anthropic' });
  for (const value of [
    { schemaVersion: 2, defaultTransport: 'anthropic' },
    { schemaVersion: 1, defaultTransport: 'other' },
    { schemaVersion: 1, defaultTransport: 'anthropic', credential: 'secret' },
    { schemaVersion: 1, defaultTransport: 'claude-code-cli', apiKey: 'secret' },
  ]) assert.throws(() => validateReviewerRouteConfig(value), /PI_REVIEWER_ROUTE_CONFIG_INVALID/);
});

test('invalid files and unsafe home paths fail closed', () => {
  const f = fixture();
  try {
    writeFileSync(f.file, '{');
    assert.throws(() => loadReviewerRouteConfig(f.home), /PI_REVIEWER_ROUTE_CONFIG_INVALID/);
    assert.throws(() => loadReviewerRouteConfig('relative-home'), /PI_REVIEWER_ROUTE_CONFIG_INVALID/);
    writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, defaultTransport: 'anthropic', extra: true }));
    assert.throws(() => loadReviewerRouteConfig(f.home), /PI_REVIEWER_ROUTE_CONFIG_INVALID/);
  } finally { f.cleanup(); }
});

test('symbolic-link config is rejected', (t) => {
  const f = fixture();
  const target = join(f.home, 'elsewhere.json');
  try {
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, defaultTransport: 'anthropic' }));
    try {
      symlinkSync(target, f.file);
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`symlink creation unavailable on this Windows account (${error.code})`);
        return;
      }
      throw error;
    }
    assert.throws(() => loadReviewerRouteConfig(f.home), /PI_REVIEWER_ROUTE_CONFIG_INVALID/);
  } finally { f.cleanup(); }
});
