/**
 * Internal host events; never an MCP response or persisted raw tool transcript.
 * @typedef {Object} RuntimeEvent
 * @property {'start'|'end'|'text_delta'|'thinking_delta'|'tool_start'|'tool_end'|'message_end'|'result_submission'} type
 * @property {string} [sourceType] Compatibility timing label supplied by the adapter.
 * @property {string} [callId] Private tool correlation identity.
 * @property {string} [path] Private target used only for recovery accounting.
 * @property {string} [name]
 * @property {boolean} [isError]
 * @property {string} [role]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {Array|String} [content]
 * @property {Object} [usage]
 * @property {string} [stopReason]
 * @property {'submission'|'role-schema-rejection'|'malformed'} [kind]
 * @property {string} [canonicalText]
 * @property {boolean} [validRejection]
 */
// Each adapter owns its unchanged sparse result projection; absent is distinct from null.
const EVENT_TYPES = new Set([
  'start', 'end', 'text_delta', 'thinking_delta', 'tool_start', 'tool_end',
  'message_end', 'result_submission',
]);
const STRING_FIELDS = new Set([
  'sourceType', 'delta', 'role', 'provider', 'model', 'stopReason',
  'errorMessage', 'name', 'callId', 'path', 'canonicalText',
]);

export function validateRuntimeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('Runtime event must be an object');
  }
  if (!EVENT_TYPES.has(event.type)) throw new TypeError('Invalid runtime event type');
  for (const field of STRING_FIELDS) {
    if (Object.hasOwn(event, field) && event[field] !== undefined && typeof event[field] !== 'string') {
      throw new TypeError(`Runtime event ${field} must be a string`);
    }
  }
  if (Object.hasOwn(event, 'bytes') && event.bytes !== undefined &&
      (typeof event.bytes !== 'number' || !Number.isFinite(event.bytes) || event.bytes < 0)) {
    throw new TypeError('Runtime event bytes must be a finite nonnegative number');
  }
  if (Object.hasOwn(event, 'isError') && event.isError !== undefined && typeof event.isError !== 'boolean') {
    throw new TypeError('Runtime event isError must be a boolean');
  }
  if (Object.hasOwn(event, 'validRejection') && event.validRejection !== undefined && typeof event.validRejection !== 'boolean') {
    throw new TypeError('Runtime event validRejection must be a boolean');
  }
  if (Object.hasOwn(event, 'content') && event.content !== undefined &&
      typeof event.content !== 'string' && !Array.isArray(event.content)) {
    throw new TypeError('Runtime event content must be a string or array');
  }
  if (Object.hasOwn(event, 'usage') && event.usage !== undefined &&
      (event.usage === null || typeof event.usage !== 'object' || Array.isArray(event.usage))) {
    throw new TypeError('Runtime event usage must be an object');
  }
  if (event.type === 'result_submission' &&
      !['submission', 'role-schema-rejection', 'malformed'].includes(event.kind)) {
    throw new TypeError('Invalid result submission kind');
  }
  if (Object.hasOwn(event, 'kind') && event.kind !== undefined &&
      !['submission', 'role-schema-rejection', 'malformed'].includes(event.kind)) {
    throw new TypeError('Invalid runtime event kind');
  }
  return event;
}
