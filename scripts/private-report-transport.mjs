import { gunzipSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

export const REPORT_TRANSPORT_PREFIX = 'gzip-base64-v1:';
export const MAX_REPORT_TRANSPORT_BYTES = 48 * 1024 - 1;
export const MAX_REPORT_BYTES = 1024 * 1024;
const invalid = () => { throw new Error('Private acceptance report transport invalid'); };

// Transport only: approval and schema validation always consume the original
// decoded report text. Never hash the compressed envelope as report approval.
export function decodePrivateReport(value) {
  try {
    if (typeof value !== 'string' || !value.length) return invalid();
    if (!value.startsWith(REPORT_TRANSPORT_PREFIX)) {
      // Legacy JSON retains its exact whitespace/bytes; unknown envelopes fail.
      if (!/^\s*[{[]/.test(value) || Buffer.byteLength(value, 'utf8') > MAX_REPORT_BYTES
        || Buffer.from(value, 'utf8').toString('utf8') !== value) return invalid();
      return value;
    }
    if (Buffer.byteLength(value, 'utf8') > MAX_REPORT_TRANSPORT_BYTES) return invalid();
    const encoded = value.slice(REPORT_TRANSPORT_PREFIX.length);
    if (!encoded.length || encoded.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid();
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) return invalid();
    const bytes = gunzipSync(compressed, { maxOutputLength: MAX_REPORT_BYTES });
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.length || !/^\s*[{[]/.test(text)) return invalid();
    return text;
  } catch {
    return invalid(); // No zlib error details, payload, or credentials in logs.
  }
}
