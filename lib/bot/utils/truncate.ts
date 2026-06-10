/**
 * Smart truncation for WhatsApp button/list titles.
 * Cuts at word boundaries instead of mid-word.
 * WhatsApp limits: button title = 20 chars, list item title = 24 chars.
 */
export function truncTitle(text: string, max = 20): string {
  if (text.length <= max) return text;

  // Try to cut at a word boundary
  const trimmed = text.slice(0, max - 1); // leave room for ellipsis
  const lastSpace = trimmed.lastIndexOf(' ');

  if (lastSpace > max * 0.4) {
    // Cut at word boundary if it doesn't lose too much
    return trimmed.slice(0, lastSpace) + '…';
  }

  // No good word boundary — hard cut
  return trimmed + '…';
}
