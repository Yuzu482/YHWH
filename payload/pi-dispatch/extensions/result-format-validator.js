export const RESULT_PREFIX = 'KETHER_RESULT_JSON=';
export const RESULT_STATUSES = Object.freeze(['completed', 'failed', 'blocked', 'unverified']);

const MAX_RESULT_BYTES = 512 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 4096;
const MAX_STRING_LENGTH = 256 * 1024;

function invalid(code, message, expectedFields) {
  return { ok: false, code, message, expectedFields: [...expectedFields] };
}

function validateShape(value, expectedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('root_not_object', 'result payload must be a JSON object', expectedFields);
  const actual = Object.keys(value);
  const missing = expectedFields.filter(field => !Object.hasOwn(value, field));
  const extra = actual.filter(field => !expectedFields.includes(field));
  if (missing.length || extra.length || actual.length !== expectedFields.length) {
    return invalid('field_mismatch', `result fields must match returnFields exactly; missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`, expectedFields);
  }
  if (Object.hasOwn(value, 'status') && !RESULT_STATUSES.includes(value.status)) {
    return invalid('invalid_status', `status must be one of ${RESULT_STATUSES.join(', ')}`, expectedFields);
  }
  let nodes = 0;
  const visit = (node, depth) => {
    nodes++;
    if (nodes > MAX_NODES) throw new Error(`result exceeds ${MAX_NODES} JSON nodes`);
    if (depth > MAX_DEPTH) throw new Error(`result exceeds maximum depth ${MAX_DEPTH}`);
    if (typeof node === 'string' && node.length > MAX_STRING_LENGTH) throw new Error(`result string exceeds ${MAX_STRING_LENGTH} characters`);
    if (Array.isArray(node)) for (const item of node) visit(item, depth + 1);
    else if (node && typeof node === 'object') for (const item of Object.values(node)) visit(item, depth + 1);
  };
  try { visit(value, 0); } catch (error) { return invalid('complexity_limit', error.message, expectedFields); }
  return { ok: true, code: 'valid', expectedFields: [...expectedFields], value };
}

export function validateKetherResult(text, expectedFields) {
  if (!Array.isArray(expectedFields) || expectedFields.length === 0) throw new Error('expectedFields must be a non-empty array');
  if (typeof text !== 'string' || !text.trim()) return invalid('empty_output', 'agent output is empty', expectedFields);
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_RESULT_BYTES) return invalid('result_too_large', `formatted result exceeds ${MAX_RESULT_BYTES} bytes`, expectedFields);
  if (!trimmed.startsWith(RESULT_PREFIX)) return invalid('missing_prefix', `agent output must start with ${RESULT_PREFIX}`, expectedFields);
  const payload = trimmed.slice(RESULT_PREFIX.length);
  let value;
  try { value = JSON.parse(payload); } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const offsetMatch = message.match(/\bposition (\d+)\b/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : null;
    let category = 'syntax_error/unknown';
    if (offset !== null && offset >= payload.length) category = 'incomplete';
    else if (/unexpected end|unterminated|end of JSON input/i.test(message)) category = 'incomplete';
    else if (offset !== null && /unexpected non-whitespace character/i.test(message)) category = 'trailing_data';
    return {
      ...invalid('invalid_json', 'result payload is not valid JSON', expectedFields),
      diagnostic: { category, categoryIsHeuristic: true, payloadLength: payload.length, parseErrorOffset: offset },
    };
  }
  return validateShape(value, expectedFields);
}

export function recoverPrefacedKetherResult(text, expectedFields) {
  if (typeof text !== 'string' || !text) return null;
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) return null;
  const newline = text.indexOf('\n');
  if (newline === -1) return null;
  let preface = text.slice(0, newline);
  if (preface.endsWith('\r')) preface = preface.slice(0, -1);
  if (!preface || Buffer.byteLength(preface, 'utf8') > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(preface)) return null;
  const envelope = text.slice(newline + 1);
  if (!envelope.startsWith(RESULT_PREFIX)) return null;
  if (text.indexOf(RESULT_PREFIX) !== text.lastIndexOf(RESULT_PREFIX)) return null;
  let validation;
  try { validation = validateKetherResult(envelope, expectedFields); } catch { return null; }
  if (!validation.ok) return null;
  return { canonicalText: RESULT_PREFIX + JSON.stringify(validation.value), validation };
}

export function publicFormatValidation(value) {
  const result = { ok: value.ok, code: value.code, message: value.message, expectedFields: value.expectedFields };
  if (value.code === 'invalid_json' && value.diagnostic) result.diagnostic = { ...value.diagnostic };
  return result;
}
