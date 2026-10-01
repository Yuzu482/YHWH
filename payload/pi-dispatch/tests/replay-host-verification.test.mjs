import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGatewayReplay } from '../scripts/replay-host-verification.mjs';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/od8445-system-changed-20260928-chesed-2.final.json',
);

test('classifies od8445 response failure without an explicit host-pending signal', () => {
  const bytes = readFileSync(fixturePath);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '80975110b6f1ee3cdb63758c52c2b20c00d683aa87a722ed34d418e784c0d291');
  assert.equal(classifyGatewayReplay(JSON.parse(bytes.toString('utf8'))), 'Tool execution failed');
});
