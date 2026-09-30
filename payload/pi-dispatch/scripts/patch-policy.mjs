import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from '../extensions/audit-log.js';

export const ISSUED_BLOCK = 'PI_PATCH_CONTAINS_ISSUED_CREDENTIAL';
export const TOKEN_INVALID = 'PI_PATCH_TOKEN_INVALID';
export const PATCH_INVALID = 'PI_PATCH_INVALID_BYTES';
export const PATCH_POLICY = 'issued-credential-v1';
const MAX_BYTES = 4 * 1024 * 1024;

function formsFor(value) {
  const forms = new Set([value, Buffer.from(value, 'utf8').toString('base64')]);
  const encoded = encodeURIComponent(value);
  forms.add(encoded);
  forms.add(encoded.replace(/%[0-9A-F]{2}/g, match => match.toLowerCase()));
  return [...forms].filter(form => form.length > 0);
}

export function checkPatchBytes(patchBytes, selectedIssuedToken) {
  try {
    if (typeof selectedIssuedToken !== 'string' || selectedIssuedToken.length === 0 || /[\s\u0000]/u.test(selectedIssuedToken)) {
      return { ok: false, code: TOKEN_INVALID };
    }
    const tokenBytes = Buffer.from(selectedIssuedToken, 'utf8');
    if (tokenBytes.toString('utf8') !== selectedIssuedToken) return { ok: false, code: TOKEN_INVALID };
    if (!Buffer.isBuffer(patchBytes) || patchBytes.length > MAX_BYTES) return { ok: false, code: PATCH_INVALID };
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(patchBytes);
    if (!Buffer.from(decoded, 'utf8').equals(patchBytes)) return { ok: false, code: PATCH_INVALID };
    const text = patchBytes.toString('utf8');
    for (const form of formsFor(selectedIssuedToken)) {
      if (patchBytes.includes(Buffer.from(form, 'utf8'))) return { ok: false, code: ISSUED_BLOCK };
    }
    let secretLikeContent;
    try {
      secretLikeContent = redactSensitiveText(text, { compact: false }) !== text;
    } catch {
      secretLikeContent = true;
    }
    return {
      ok: true,
      patchPolicy: PATCH_POLICY,
      secretLikeContent,
      patchSha256: createHash('sha256').update(patchBytes).digest('hex'),
      patchBytes: patchBytes.length,
    };
  } catch {
    return { ok: false, code: PATCH_INVALID };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const filePath = process.argv[2];
    const token = readFileSync(0, 'utf8');
    const bytes = readFileSync(filePath);
    const result = checkPatchBytes(bytes, token);
    if (!result.ok) {
      process.stderr.write(result.code);
      process.exitCode = result.code === ISSUED_BLOCK ? 4 : 3;
    } else {
      process.stdout.write(JSON.stringify(result));
    }
  } catch {
    process.stderr.write(PATCH_INVALID);
    process.exitCode = 3;
  }
}
