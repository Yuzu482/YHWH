import test from 'node:test';
import assert from 'node:assert/strict';
import resultSubmit from '../extensions/result-submit.js';

function setup() {
  const handlers = {};
  let tool;
  resultSubmit({
    on(name, handler) { handlers[name] = handler; },
    registerTool(value) { tool = value; },
  });
  return { handlers, tool };
}

const invoke = (tool, payload) => tool.execute('call-1', { payload });

test('submits canonical prefixed JSON and marks details for tool_execution_end', async () => {
  const { tool } = setup();
  const result = await invoke(tool, { status: 'completed', z: [1, true], a: { y: 'ok', b: null } });
  const canonicalText = 'KETHER_RESULT_JSON={"a":{"b":null,"y":"ok"},"status":"completed","z":[1,true]}';
  assert.deepEqual(result.content, [{ type: 'text', text: canonicalText }]);
  assert.deepEqual(result.details, { type: 'kether_result_submission', canonicalText });
});

test('rejects a second successful submission in the same turn and resets on next turn', async () => {
  const { handlers, tool } = setup();
  await invoke(tool, { ok: true });
  await assert.rejects(invoke(tool, { ok: false }), /RESULT_ALREADY_SUBMITTED/);
  handlers.agent_start();
  assert.equal((await invoke(tool, { ok: false })).details.canonicalText, 'KETHER_RESULT_JSON={"ok":false}');
});

test('rejects malformed and non-JSON-safe payloads deterministically', async () => {
  const { tool } = setup();
  for (const payload of [null, [], 'text', { value: undefined }, { value: NaN }, { get value() { return 1; } }]) {
    await assert.rejects(invoke(tool, payload), /RESULT_/);
  }
  await assert.rejects(tool.execute('call-2', {}), /RESULT_ARGUMENT_INVALID/);
});

test('rejects oversize payload and produces stable key-sorted output', async () => {
  const { tool } = setup();
  await assert.rejects(invoke(tool, { text: 'x'.repeat(512 * 1024) }), /RESULT_(?:STRING_TOO_LARGE|TOO_LARGE)/);
  assert.equal((await invoke(tool, { z: 1, a: 2 })).details.canonicalText, 'KETHER_RESULT_JSON={"a":2,"z":1}');
});
