import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

export const RECORD_THRESHOLD_BYTES = 2048;
export const RECORD_CEILING_BYTES = 262144;

export function encodeRecordedText(value) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return { text: '', encoding: 'plain', truncated: false };
  if (Buffer.byteLength(text, 'utf8') < RECORD_THRESHOLD_BYTES) {
    return { text, encoding: 'plain', truncated: false };
  }

  let candidate = text;
  let truncated = false;
  let encoded = brotliCompressSync(Buffer.from(candidate, 'utf8')).toString('base64');
  while (Buffer.byteLength(encoded, 'utf8') > RECORD_CEILING_BYTES && candidate.length > 1) {
    candidate = candidate.slice(0, Math.floor(candidate.length / 2));
    truncated = true;
    encoded = brotliCompressSync(Buffer.from(candidate, 'utf8')).toString('base64');
  }
  return { text: encoded, encoding: 'br+b64', truncated };
}

export function decodeRecordedText(field) {
  if (field === null || typeof field !== 'object') return { text: '', truncated: false };
  const truncated = field.truncated === true;
  if (field.encoding !== 'br+b64') {
    return { text: typeof field.text === 'string' ? field.text : '', truncated };
  }
  try {
    const raw = brotliDecompressSync(Buffer.from(String(field.text), 'base64'));
    return { text: raw.toString('utf8'), truncated };
  } catch {
    return { text: '(recorded output could not be decoded)', truncated };
  }
}
