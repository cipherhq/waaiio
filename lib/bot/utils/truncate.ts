/**
 * Unicode-safe slice that never splits a surrogate pair.
 * If the cut falls on a high surrogate (0xD800-0xDBFF), backs up one position.
 */
function safeSlice(text: string, end: number): string {
  if (end >= text.length) return text;
  // If we'd cut between a high and low surrogate, back up one
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) {
      // end-1 is a high surrogate — its low surrogate is at `end`, don't split
      return text.slice(0, end - 1);
    }
  }
  return text.slice(0, end);
}

/**
 * Smart truncation for WhatsApp button/list titles.
 * Cuts at word boundaries instead of mid-word.
 * Unicode-safe: never splits surrogate pairs (emoji like 🎉).
 * WhatsApp limits: button title = 20 chars, list item title = 24 chars.
 */
export function truncTitle(text: string, max = 20): string {
  if (text.length <= max) return text;

  // Try to cut at a word boundary
  const trimmed = safeSlice(text, max - 1); // leave room for ellipsis
  const lastSpace = trimmed.lastIndexOf(' ');

  if (lastSpace > max * 0.4) {
    // Cut at word boundary if it doesn't lose too much
    return trimmed.slice(0, lastSpace) + '…';
  }

  // No good word boundary — hard cut
  return trimmed + '…';
}

/**
 * Build a WhatsApp list item with smart layout.
 *
 * Reserves description space for material detail first (price, frequency),
 * then uses remaining capacity for name/context. A very long name must NOT
 * cause the configured amount or frequency to disappear.
 *
 * Layout rules:
 *  1. No detail → truncate name into title.
 *  2. Combined "name — detail" fits in title → single title, no description.
 *  3. Name fits alone in title → name as title, detail as description.
 *  4. Name too long → truncated name as title, description starts with DETAIL
 *     (material economic info first), then adds " · name" for context.
 */
export function buildListItem(opts: {
  name: string;
  detail?: string;
  postbackText: string;
  maxTitle?: number;
}): { title: string; description?: string; postbackText: string } {
  const max = opts.maxTitle ?? 24;

  // No detail? Just truncate name
  if (!opts.detail) {
    return {
      title: truncTitle(opts.name, max),
      postbackText: opts.postbackText,
    };
  }

  const combined = `${opts.name} — ${opts.detail}`;
  // Combined fits in title
  if (combined.length <= max) {
    return { title: combined, postbackText: opts.postbackText };
  }

  // Name fits alone in title — detail goes to description
  if (opts.name.length <= max) {
    return {
      title: opts.name,
      description: safeSlice(opts.detail, 72),
      postbackText: opts.postbackText,
    };
  }

  // Name too long — truncate title, description starts with DETAIL (material info first)
  return {
    title: truncTitle(opts.name, max),
    description: safeSlice(`${opts.detail} · ${opts.name}`, 72),
    postbackText: opts.postbackText,
  };
}
