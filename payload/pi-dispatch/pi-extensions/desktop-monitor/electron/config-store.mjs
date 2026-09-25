import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

const LIMITS = Object.freeze({
  maxConcurrency: [1, 4, 4],
  maxQueue: [1, 64, 16],
  maxRequestBytes: [1024, 1048576, 102400],
});
const KEYS = Object.keys(LIMITS);

function publicError(code = 'CONFIG_INVALID') {
  const error = new Error('Configuration operation failed');
  error.code = code;
  return error;
}

function parseConfig(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw publicError();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw publicError();
  }
  const settings = {};
  for (const key of KEYS) {
    const [min, max, fallback] = LIMITS[key];
    const value = parsed[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw publicError();
    }
    settings[key] = value;
  }
  return settings;
}

export async function readConfig(configPath) {
  let bytes;
  try {
    bytes = await readFile(configPath);
  } catch {
    throw publicError('CONFIG_IO');
  }
  const settings = parseConfig(bytes);
  return {
    settings,
    revision: createHash('sha256').update(bytes).digest('hex'),
    restartRequired: false,
  };
}

export async function saveConfig(configPath, settings, expectedRevision) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      Object.keys(settings).length !== KEYS.length ||
      KEYS.some((key) => !Object.prototype.hasOwnProperty.call(settings, key)) ||
      typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)) {
    throw publicError();
  }
  for (const key of KEYS) {
    const value = settings[key];
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      throw publicError();
    }
  }

  let originalBytes;
  let original;
  try {
    originalBytes = await readFile(configPath);
  } catch {
    throw publicError('CONFIG_IO');
  }
  if (createHash('sha256').update(originalBytes).digest('hex') !== expectedRevision) {
    throw publicError('CONFIG_STALE');
  }
  try {
    original = JSON.parse(originalBytes.toString('utf8'));
  } catch {
    throw publicError();
  }
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw publicError();
  }

  const updated = { ...original, ...settings };
  const tempPath = join(dirname(configPath), `.${basename(configPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tempPath, configPath);
  } catch {
    try {
      await unlink(tempPath);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
    throw publicError('CONFIG_IO');
  }

  const result = await readConfig(configPath);
  return { ...result, restartRequired: true };
}
