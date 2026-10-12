// Different layers deliberately use different units. These are existing budgets,
// not a promise that a maximum patch plus its JSON envelope fits every layer.
export const DATA_CAPACITY = Object.freeze({
  patchMaxUtf8Bytes: 4 * 1024 * 1024,
  fullResultMaxUtf16Units: 4 * 1024 * 1024,
  pageMaxUtf16Units: 65536,
  pageCountMax: 128,
  persistentRecordMaxUtf8Bytes: 32 * 1024 * 1024,
});

export function measureCapacity(serialized, {location, unit, limit}) {
  if (typeof serialized !== 'string' || typeof location !== 'string' || !location ||
      !['utf8-bytes', 'utf16-units'].includes(unit) || !Number.isSafeInteger(limit) || limit < 1)
    throw new TypeError('Invalid capacity measurement');
  const actual = unit === 'utf8-bytes' ? Buffer.byteLength(serialized, 'utf8') : serialized.length;
  return {location, unit, actual, limit, ok: actual <= limit};
}

export function assertCapacity(serialized, {code, ...options}) {
  const measured = measureCapacity(serialized, options);
  if (!measured.ok) throw Object.assign(new Error(`${code}: ${measured.location} ${measured.actual} > ${measured.limit} ${measured.unit}`),
    {code, ...measured, violations: [{code, ...measured}]});
  return measured;
}

export function assertPersistentRecord(serialized, location = 'persistentRecord') {
  return assertCapacity(serialized, {code: 'PI_RESULT_OVERSIZED', location,
    unit: 'utf8-bytes', limit: DATA_CAPACITY.persistentRecordMaxUtf8Bytes});
}
