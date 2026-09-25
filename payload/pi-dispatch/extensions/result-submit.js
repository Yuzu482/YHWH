// Submit one structured result per Pi turn. This extension deliberately has no
// filesystem, network, credential, or host-IPC access.
const RESULT_PREFIX = 'KETHER_RESULT_JSON=';
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 4096;
const MAX_STRING_LENGTH = 256 * 1024;

function canonicalJson(root) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('RESULT_PAYLOAD_NOT_OBJECT');
  let nodes = 0;
  const ancestors = new Set();
  function encode(value, depth) {
    nodes++;
    if (nodes > MAX_NODES) throw new Error('RESULT_TOO_COMPLEX');
    if (depth > MAX_DEPTH) throw new Error('RESULT_TOO_DEEP');
    if (value === null) return 'null';
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LENGTH) throw new Error('RESULT_STRING_TOO_LARGE');
      return JSON.stringify(value);
    }
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('RESULT_NON_JSON_NUMBER');
      return JSON.stringify(value);
    }
    if (typeof value !== 'object') throw new Error('RESULT_NON_JSON_VALUE');
    if (ancestors.has(value)) throw new Error('RESULT_CIRCULAR_REFERENCE');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || Object.getOwnPropertySymbols(value).length) throw new Error('RESULT_NON_JSON_ARRAY');
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('RESULT_SPARSE_OR_EXTENDED_ARRAY');
      if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) throw new Error('RESULT_ACCESSOR_PROPERTY');
      ancestors.add(value);
      const encoded = value.map(item => encode(item, depth + 1)).join(',');
      ancestors.delete(value);
      return `[${encoded}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) throw new Error('RESULT_NON_JSON_OBJECT');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('RESULT_SYMBOL_KEY');
    const keys = Object.keys(value).sort();
    const allKeys = Reflect.ownKeys(value);
    if (allKeys.length !== keys.length) throw new Error('RESULT_NON_JSON_PROPERTY');
    ancestors.add(value);
    const encoded = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('RESULT_ACCESSOR_PROPERTY');
      return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
    }).join(',');
    ancestors.delete(value);
    return `{${encoded}}`;
  }
  const text = encode(root, 0);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new Error('RESULT_TOO_LARGE');
  return text;
}

export default function resultSubmit(pi) {
  let submitted = false;
  pi.on?.('agent_start', () => { submitted = false; });
  pi.registerTool({
    name: 'yhwh_submit_result',
    label: 'Submit Kether result',
    description: 'Submit the final structured Kether result. This is the authoritative result; do not translate or reproduce it in final text.',
    parameters: {
      type: 'object',
      properties: { payload: { type: 'object', description: 'The structured result object' } },
      required: ['payload'],
      additionalProperties: false,
    },
    async execute(_id, args) {
      if (submitted) throw new Error('RESULT_ALREADY_SUBMITTED');
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !Object.hasOwn(args, 'payload')) {
        throw new Error('RESULT_ARGUMENT_INVALID');
      }
      const canonicalText = RESULT_PREFIX + canonicalJson(args.payload);
      submitted = true;
      return {
        content: [{ type: 'text', text: canonicalText }],
        details: { type: 'kether_result_submission', canonicalText },
      };
    },
  });
}

export { canonicalJson, RESULT_PREFIX };
