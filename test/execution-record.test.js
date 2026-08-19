import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeRecordedText,
  encodeRecordedText,
  RECORD_CEILING_BYTES,
  RECORD_THRESHOLD_BYTES,
} from '../src/execution-record.js';

test('small text stays plain and greppable', () => {
  const encoded = encodeRecordedText('ok\n');
  assert.equal(encoded.encoding, 'plain');
  assert.equal(encoded.text, 'ok\n');
  assert.equal(encoded.truncated, false);
});

test('large text is compressed and round-trips byte-identically', () => {
  const big = 'x'.repeat(RECORD_THRESHOLD_BYTES + 1);
  const encoded = encodeRecordedText(big);
  assert.equal(encoded.encoding, 'br+b64');
  assert.notEqual(encoded.text, big, 'compressed form must differ from the raw text');
  assert.equal(decodeRecordedText(encoded).text, big);
});

test('the threshold produces observably different stored forms on each side', () => {
  const under = encodeRecordedText('a'.repeat(RECORD_THRESHOLD_BYTES - 1));
  const over = encodeRecordedText('a'.repeat(RECORD_THRESHOLD_BYTES + 1));
  assert.equal(under.encoding, 'plain');
  assert.equal(over.encoding, 'br+b64');
});

test('text beyond the ceiling is truncated and marked', () => {
  let state = 0x12345678;
  const chars = new Array(RECORD_CEILING_BYTES * 2);
  for (let index = 0; index < chars.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    chars[index] = String.fromCharCode(32 + ((state >>> 0) % 95));
  }
  const huge = chars.join('');
  const encoded = encodeRecordedText(huge);
  assert.equal(encoded.truncated, true);
  assert.ok(Buffer.byteLength(encoded.text, 'utf8') <= RECORD_CEILING_BYTES);
  assert.equal(decodeRecordedText(encoded).truncated, true);
});

test('decode tolerates a corrupt compressed payload instead of throwing', () => {
  const result = decodeRecordedText({ text: 'not-valid-base64-brotli', encoding: 'br+b64' });
  assert.equal(typeof result.text, 'string');
  assert.match(result.text, /could not be decoded/i);
});

test('decode passes plain text through unchanged', () => {
  assert.equal(decodeRecordedText({ text: 'hello', encoding: 'plain' }).text, 'hello');
});

test('absent or non-string input yields empty text rather than throwing', () => {
  assert.equal(decodeRecordedText(undefined).text, '');
  assert.equal(encodeRecordedText(undefined).text, '');
});
