import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sourceWindow from '../extensions/source-window.js';

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'source-window-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let tool;
  sourceWindow({ registerTool(value) { tool = value; } });
  async function call(args) {
    const result = await tool.execute('test', args, undefined, undefined, { cwd });
    const item = result.content.find((entry) => entry.type === 'text');
    return { result, data: JSON.parse(item.text) };
  }
  return { cwd, call };
}

test('reads bounded query and offset windows from a long single-line HTML document', async (t) => {
  const { cwd, call } = await fixture(t);
  const html = `<main>${'x'.repeat(21000)}needle${'y'.repeat(21009)}</main>`;
  await writeFile(path.join(cwd, 'page.html'), html);
  const digest = createHash('sha256').update(Buffer.from(html)).digest('hex');

  const queried = await call({ path: 'page.html', query: 'needle', maxChars: 17 });
  assert.equal(queried.result.isError, undefined);
  assert.deepEqual(queried.data, {
    path: 'page.html', sha256: digest, totalLength: html.length,
    start: html.indexOf('needle'), end: html.indexOf('needle') + 17,
    truncatedStart: true, truncatedEnd: true, text: html.slice(html.indexOf('needle'), html.indexOf('needle') + 17),
  });
  assert.ok(queried.data.text.length <= 17);

  const offset = 32001;
  const window = await call({ path: 'page.html', offset, maxChars: 23 });
  assert.equal(window.result.isError, undefined);
  assert.equal(window.data.start, offset);
  assert.equal(window.data.text, html.slice(offset, offset + 23));
  assert.equal(window.data.totalLength, html.length);
  assert.equal(window.data.sha256, digest);
});

test('uses UTF-16 code-unit offsets and selects repeated query occurrences', async (t) => {
  const { cwd, call } = await fixture(t);
  const text = 'A😀 hit B😀 hit Z';
  await writeFile(path.join(cwd, 'text.txt'), text);
  const second = text.indexOf('hit', text.indexOf('hit') + 1);
  const queried = await call({ path: 'text.txt', query: 'hit', occurrence: 2, maxChars: 5 });
  assert.equal(queried.result.isError, undefined);
  assert.equal(queried.data.start, second);
  assert.equal(queried.data.text, text.slice(second, second + 5));
  const offset = await call({ path: 'text.txt', offset: 3, maxChars: 4 });
  assert.equal(offset.result.isError, undefined);
  assert.equal(offset.data.start, 3);
  assert.equal(offset.data.text, text.slice(3, 7));
  assert.equal(offset.data.totalLength, text.length);
});

test('rejects traversal and absolute paths', async (t) => {
  const { cwd, call } = await fixture(t);
  await writeFile(path.join(cwd, 'ok.txt'), 'ok');
  for (const file of ['../outside.txt', path.resolve(cwd, 'ok.txt'), '/etc/passwd']) {
    const { result, data } = await call({ path: file });
    assert.equal(result.isError, true);
    assert.match(data.error, /path|relative/i);
  }
});

test('rejects malformed UTF-8 and files larger than 8 MiB', async (t) => {
  const { cwd, call } = await fixture(t);
  await writeFile(path.join(cwd, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  const invalid = await call({ path: 'invalid.txt' });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.data.error, /UTF-8/);

  await writeFile(path.join(cwd, 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const large = await call({ path: 'large.txt' });
  assert.equal(large.result.isError, true);
  assert.match(large.data.error, /8 MiB/);
});

test('rejects a symlink path component', async (t) => {
  const { cwd, call } = await fixture(t);
  await writeFile(path.join(cwd, 'target.txt'), 'content');
  try {
    await symlink(path.join(cwd, 'target.txt'), path.join(cwd, 'link.txt'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const { result, data } = await call({ path: 'link.txt' });
  assert.equal(result.isError, true);
  assert.match(data.error, /symbolic link/i);
});
