/**
 * Shareable giving-category links (Owner request 2026-11-18).
 *
 * A giving category is a `services` row with service_type 'giving'. Its share
 * link is the permanent merchant link /m/{businessId}/giving/{categoryId}, which
 * redirects to WhatsApp with the prefill "{BOT_CODE}:giving:{ref}". The ref is the
 * first 8 hex characters of the category's own id, so no new column is needed.
 * The bot looks the ref up only inside the business that owns the bot code, and
 * only among active, non-deleted giving categories; anything else falls back to
 * the business's normal giving menu.
 *
 * Client-safe: no server-only imports.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalPublicOrigin } from '@/lib/url';

export const GIVING_CATEGORY_REF_LENGTH = 8;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "{BOT_CODE}:giving:{ref}" — the bot code charset matches app/m/resolve.ts.
const PREFILL_RE = /^([A-Za-z0-9-]{1,30}):giving:([0-9a-f]{8})$/i;

/** Permanent share link for one giving category (QR code, Copy Link, WhatsApp share). */
export function buildGivingCategoryLink(businessId: string, categoryId: string): string {
  return `${canonicalPublicOrigin()}/m/${businessId}/giving/${categoryId}`;
}

/** Short reference the bot matches: the first 8 hex characters of the category id. */
export function givingCategoryRef(categoryId: string): string | null {
  if (!UUID_RE.test(categoryId)) return null;
  return categoryId.slice(0, GIVING_CATEGORY_REF_LENGTH).toLowerCase();
}

/** WhatsApp prefill text for a giving category, or null when it cannot be built. */
export function buildGivingCategoryPrefill(botCode: string, categoryId: string): string | null {
  const ref = givingCategoryRef(categoryId);
  const code = botCode.trim();
  if (!ref || !/^[A-Za-z0-9-]{1,30}$/.test(code)) return null;
  return `${code}:giving:${ref}`;
}

/** Parse "{BOT_CODE}:giving:{ref}". Returns null for any other text. */
export function parseGivingCategoryPrefill(text: string): { botCode: string; ref: string } | null {
  const m = PREFILL_RE.exec(text.trim());
  if (!m) return null;
  return { botCode: m[1], ref: m[2].toLowerCase() };
}

/**
 * Find the active, non-deleted giving category of this business whose id starts
 * with the ref. Scoped to businessId, so another business's ref never matches.
 * Returns null when there is no single match.
 */
export async function resolveGivingCategoryRef(
  supabase: SupabaseClient,
  businessId: string,
  ref: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await supabase
    .from('services')
    .select('id, name')
    .eq('business_id', businessId)
    .eq('service_type', 'giving')
    .eq('is_active', true)
    .is('deleted_at', null);
  if (error || !data) return null;
  const matches = (data as Array<{ id: string; name: string }>).filter(s => String(s.id).toLowerCase().startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}
