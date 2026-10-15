/**
 * Unicode-safe slice that never splits a UTF-16 surrogate pair.
 */
function safeSlice(text: string, end: number): string {
  if (end >= text.length) return text;
  if (end <= 0) return '';

  const lastIncluded = text.charCodeAt(end - 1);
  if (lastIncluded >= 0xD800 && lastIncluded <= 0xDBFF) {
    return text.slice(0, end - 1);
  }
  return text.slice(0, end);
}

/**
 * Smart truncation for WhatsApp button/list titles.
 * Cuts at word boundaries instead of mid-word.
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
 * Build a WhatsApp list row while preserving material detail.
 *
 * WhatsApp list row constraints:
 * - title: 24 chars
 * - description: 72 chars
 *
 * Material detail (price/frequency/progress/etc.) always gets description
 * priority over optional long-name context. Postback identity is never changed.
 */
export function buildListItem(opts: {
  name: string;
  detail?: string;
  postbackText: string;
  maxTitle?: number;
  maxDescription?: number;
}): { title: string; description?: string; postbackText: string } {
  const maxTitle = opts.maxTitle ?? 24;
  const maxDescription = opts.maxDescription ?? 72;
  const name = opts.name.trim() || 'Option';
  const detail = opts.detail?.trim();

  if (!detail) {
    return {
      title: truncTitle(name, maxTitle),
      postbackText: opts.postbackText,
    };
  }

  const combined = `${name} — ${detail}`;
  if (combined.length <= maxTitle) {
    return {
      title: combined,
      postbackText: opts.postbackText,
    };
  }

  if (name.length <= maxTitle) {
    return {
      title: name,
      description: safeSlice(detail, maxDescription),
      postbackText: opts.postbackText,
    };
  }

  // Long name: material detail must survive first. Only use leftover
  // description capacity for additional name context.
  const safeDetail = safeSlice(detail, maxDescription);
  const separator = ' · ';
  const remaining = maxDescription - safeDetail.length - separator.length;
  const description = remaining > 0
    ? `${safeDetail}${separator}${safeSlice(name, remaining)}`
    : safeDetail;

  return {
    title: truncTitle(name, maxTitle),
    description,
    postbackText: opts.postbackText,
  };
}
