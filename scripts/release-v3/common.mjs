// Shared helpers for the Release V3 (schema 8) gate. No I/O here.
import { createHash } from 'node:crypto';

export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
export const REPO = 'cipherhq/waaiio';
export const OWNER = 'cipherhq';
export const POLICY = 'release-v3-reusable-v1';
export const SCHEMA_VERSION = 8;

export class GateError extends Error {}
export const fail = message => { throw new GateError(message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const sortKeys = value => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
    : value;
// Deterministic JSON: sorted keys, one-space indent, trailing newline.
export const canonicalJson = value => `${JSON.stringify(sortKeys(value), null, 1)}\n`;
export const canonicalDigest = value => sha256(JSON.stringify(sortKeys(value)));

// Byte-wise (C collation) ordering, matching ORDER BY ... COLLATE "C".
export const byteCompare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

export const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
