import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const MAX_FULL_REPORT_BYTES = 4 * 1024 * 1024;
export const MAX_FULL_REPORT_CHUNK_BYTES = 40 * 1024;
export const FULL_REPORT_CHUNK_SLOTS = 10;
const prefix = 'PRIVATE_RELEASE_ACCEPTANCE_CHUNK_';
const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = () => { throw new Error('Full acceptance report transport invalid'); };

// Only the schema5 gate calls this decoder. Transport integrity confers no
// release authority: existing raw-report approval and evidence checks still run.
export function decodeFullReportTransport(descriptorText, env = process.env) {
  try {
    if (typeof descriptorText !== 'string' || Buffer.byteLength(descriptorText) > 4096) return invalid();
    const d = JSON.parse(descriptorText);
    if (!d || Array.isArray(d) || Object.keys(d).sort().join(',') !== 'chunk_count,chunk_sha256,decoded_sha256,encoding,transport_version'
      || d.transport_version !== 2 || d.encoding !== 'gzip-base64'
      || !Number.isInteger(d.chunk_count) || d.chunk_count < 1 || d.chunk_count > FULL_REPORT_CHUNK_SLOTS
      || !Array.isArray(d.chunk_sha256) || d.chunk_sha256.length !== d.chunk_count
      || ![d.decoded_sha256, ...d.chunk_sha256].every(h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h))) return invalid();
    // Empty inactive workflow slots are permitted; no populated surplus or alias
    // (including slot 0, 09, or 11) can silently enter the transport.
    for (const key of Object.keys(env)) {
      if (!key.startsWith(prefix) || env[key] === '' || env[key] === undefined) continue;
      if (!Array.from({ length: d.chunk_count }, (_, i) => prefix + (i + 1)).includes(key)) return invalid();
    }
    const chunks = [];
    for (let i = 1; i <= d.chunk_count; i++) {
      const chunk = env[prefix + i];
      if (typeof chunk !== 'string' || !chunk.length || Buffer.byteLength(chunk) > MAX_FULL_REPORT_CHUNK_BYTES
        || !/^[A-Za-z0-9+/=]+$/.test(chunk) || digest(chunk) !== d.chunk_sha256[i - 1]) return invalid();
      chunks.push(chunk);
    }
    const encoded = chunks.join('');
    if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid();
    const compressed = Buffer.from(encoded, 'base64');
    if (compressed.toString('base64') !== encoded) return invalid();
    const bytes = gunzipSync(compressed, { maxOutputLength: MAX_FULL_REPORT_BYTES });
    if (digest(bytes) !== d.decoded_sha256) return invalid();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.length || !/^\s*[{[]/.test(text)) return invalid();
    return text;
  } catch {
    return invalid(); // Never expose chunks, report text, or decompressor details.
  }
}
