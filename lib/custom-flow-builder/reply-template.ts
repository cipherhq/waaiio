import type { DataColumn } from '@/lib/bot/custom-flow/data';

/**
 * Reply templates stay stored as text with {{column}} tokens (engine
 * `substitute`). The builder shows each token as a named chip instead, and
 * keeps the token's original spelling so a reply round-trips exactly.
 */
export type ReplySegment = { kind: 'text'; text: string } | { kind: 'field'; key: string; raw: string };

// Same token pattern as lib/bot/custom-flow/engine.ts `substitute`.
const TOKEN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function parseReply(template: string): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: 'text', text: template.slice(last, index) });
    segments.push({ kind: 'field', key: match[1], raw: match[0] });
    last = index + match[0].length;
  }
  if (last < template.length) segments.push({ kind: 'text', text: template.slice(last) });
  return segments;
}

export function joinReply(segments: ReplySegment[]): string {
  return segments.map(segment => segment.kind === 'text' ? segment.text : segment.raw).join('');
}

/** The stored form of a newly inserted detail. */
export const fieldToken = (key: string) => `{{${key}}}`;

/** Plain name for a detail: the list's column label, else a tidied key. */
export function fieldLabel(key: string, columns: DataColumn[] = []): string {
  const column = columns.find(item => item.name === key);
  if (column?.label?.trim()) return column.label.trim();
  const words = key.replace(/^business\./, 'business ').replace(/[_.-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** Example text built like the engine does: unknown details become empty. */
export function fillExample(template: string, values: Record<string, unknown>): string {
  return template.replace(TOKEN, (_match, key: string) => {
    const value = values[key];
    // Objects (such as a linked record) are never shown as "[object Object]".
    return value === undefined || value === null || typeof value === 'object' ? '' : String(value);
  });
}
