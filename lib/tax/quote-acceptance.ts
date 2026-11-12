import { createHash } from 'node:crypto';

/** JSONB key order is not stable across reads. Keep array order (line order) and
 * sort object keys so a button binds the exact persisted customer-facing terms. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function quoteAcceptanceDigest(quoteId: string, snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson({ quoteId: quoteId.toLowerCase(), snapshot: snapshot ?? null })).digest('hex');
}

export function quoteAcceptButtonId(quoteId: string, snapshot: unknown): string {
  return `accept_quote_${quoteId}_${quoteAcceptanceDigest(quoteId, snapshot)}`;
}

export function parseQuoteResponseButton(text: string): { action: 'accept' | 'reject'; quoteId: string; digest?: string } | null {
  const match = text.match(/^(accept|reject)_quote_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{64}))?$/i);
  if (!match || (match[1].toLowerCase() === 'reject' && match[3])) return null;
  return { action: match[1].toLowerCase() as 'accept' | 'reject', quoteId: match[2], ...(match[3] ? { digest: match[3].toLowerCase() } : {}) };
}
