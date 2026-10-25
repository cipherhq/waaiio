/**
 * Party slug generation for shareable URLs.
 * Format: slugified-name-random6 (e.g., "summer-bbq-a7k2m9")
 */
export function generatePartySlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${base || 'party'}-${suffix}`;
}
