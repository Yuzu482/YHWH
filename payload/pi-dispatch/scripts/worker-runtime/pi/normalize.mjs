const MAX_BUFFER_CHARACTERS = 1024 * 1024;

// Preserve the dispatcher's historical JSON-lines parser: malformed lines are ignored.
export function eventsFrom(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

export function normalizePiEvent(raw) {
  // Retain the legacy native null error; primitive/array unknown events remain ignored.
  const type = raw.type;
  if (type === 'agent_start') return [{ type: 'start', sourceType: type }];
  if (type === 'agent_end') return [{ type: 'end', sourceType: type }];
  if (type === 'message_update') {
    const update = raw.assistantMessageEvent;
    if (!update || typeof update !== 'object') return [];
    if (update.type === 'text_delta') {
      const event = { type: 'text_delta', sourceType: type };
      if (Object.hasOwn(update, 'delta')) event.delta = update.delta;
      return [event];
    }
    if (update.type === 'thinking_delta') return [{ type: 'thinking_delta', sourceType: type }];
    return [];
  }
  if (type === 'message_end') {
    const message = raw.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return [{ type: 'message_end', sourceType: type }];
    }
    const event = { type: 'message_end', sourceType: type };
    for (const field of ['role', 'provider', 'model', 'content', 'usage', 'stopReason', 'errorMessage']) {
      if (Object.hasOwn(message, field)) event[field] = message[field];
    }
    return [event];
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_end') {
    const event = { type: type === 'tool_execution_start' ? 'tool_start' : 'tool_end', sourceType: type };
    if (Object.hasOwn(raw, 'toolCallId')) event.callId = raw.toolCallId;
    if (Object.hasOwn(raw, 'toolName')) event.name = raw.toolName;
    if (Object.hasOwn(raw, 'args') && raw.args && typeof raw.args === 'object' && Object.hasOwn(raw.args, 'path')) {
      event.path = raw.args.path;
    }
    if (Object.hasOwn(raw, 'isError')) event.isError = raw.isError;
    if (type === 'tool_execution_end' && event.name === 'yhwh_submit_result') {
      const details = raw.result?.details ?? raw.details;
      let kind = 'submission';
      let validRejection = false;
      let canonicalText;
      if (details?.type === 'kether_result_rejection') {
        kind = 'role-schema-rejection';
        validRejection = details.code === 'RESULT_ROLE_SCHEMA_INVALID' && Object.keys(details).length === 2;
      } else if (details?.type === 'kether_result_submission') {
        canonicalText = details.canonicalText;
      }
      const submission = { type: 'result_submission', kind, validRejection };
      if (canonicalText !== undefined) submission.canonicalText = canonicalText;
      // Keep result payload metadata separate from the ordinary tool completion.
      return [event, submission];
    }
    return [event];
  }
  return [];
}

export function normalizePiEvents(rawEvents) {
  const normalized = [];
  for (const raw of rawEvents) normalized.push(...normalizePiEvent(raw));
  return normalized;
}

export function createPiNormalizer({ onEvent = () => {}, retainEvents = true,
  maxBufferCharacters = MAX_BUFFER_CHARACTERS, flushAtClose = true,
  maxRetainedEvents = 8192, maxRetainedBytes = 4 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBufferCharacters) || maxBufferCharacters < 1) throw new RangeError('Invalid parser buffer limit');
  if (![maxRetainedEvents,maxRetainedBytes].every(n=>Number.isSafeInteger(n)&&n>0)) throw new RangeError('Invalid event retention limit');
  let buffer = '';
  let discard = false;
  let closed = false;
  let disposed = false;
  const retained = [];
  let retainedBytes=0, retentionFailure=null;
  const emit = raw => {
    try {
      for (const event of normalizePiEvent(raw)) {
        if (retainEvents) {
          const bytes=Buffer.byteLength(JSON.stringify(event));
          if(retentionFailure||retained.length>=maxRetainedEvents||retainedBytes+bytes>maxRetainedBytes){retentionFailure??=new RangeError('RUNTIME_EVENT_LIMIT_EXCEEDED');continue;}
          retained.push(event);retainedBytes+=bytes;
        }
        try { onEvent(event); } catch {}
      }
    } catch {}
  };
  const line = value => {
    try { emit(JSON.parse(value)); } catch {}
  };
  const consume = chunk => {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (!discard) buffer += part;
      if (buffer.length > maxBufferCharacters) { buffer = ''; discard = true; }
      if (part.endsWith('\n')) {
        if (!discard) line(buffer);
        buffer = '';
        discard = false;
      }
    }
  };
  return {
    feed(chunk) {
      if (closed || disposed || typeof chunk !== 'string') return;
      try { consume(chunk); } catch {}
    },
    events() { if(retentionFailure)throw retentionFailure;return disposed ? [] : retained.slice(); },
    close() {
      if (closed || disposed) return;
      closed = true;
      if (flushAtClose && !discard && buffer.length) line(buffer);
      buffer = '';
      discard = false;
    },
    dispose() {
      if (disposed) return;
      closed = true;
      disposed = true;
      buffer = '';
      discard = false;
      retained.length = 0;
      retainedBytes=0;retentionFailure=null;
    },
  };
}
