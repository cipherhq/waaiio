import { cache } from 'react';
import { createServiceClient } from '@/lib/supabase/service';

export interface BusinessTerms {
  name: string;
  /** The business's own terms, or null when it has none to show. */
  termsText: string | null;
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Public read of one business's terms for /t/[slug].
 *
 * Terms live in businesses.metadata.terms_text (Settings → Payments → Checkout).
 * Anonymous visitors cannot read businesses or its metadata, so this uses the
 * service client, but selects only the name and two metadata keys, never the
 * whole metadata object. Same visibility rule as businesses_public:
 * active businesses only.
 *
 * Returns null for an unknown, malformed or inactive slug. Text the merchant
 * saved and then switched off (require_terms_before_payment = false) is not
 * shown, because the dashboard hides it once terms are off.
 */
export const getBusinessTerms = cache(async (slug: string): Promise<BusinessTerms | null> => {
  if (!SLUG_RE.test(slug)) return null;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('businesses')
    .select('name, terms_text:metadata->>terms_text, require_terms:metadata->>require_terms_before_payment')
    .eq('slug', slug)
    .eq('status', 'active')
    .maybeSingle();

  if (error) throw new Error('Could not load business terms');
  if (!data) return null;

  const row = data as { name: string; terms_text: unknown; require_terms: unknown };
  const text = typeof row.terms_text === 'string' ? row.terms_text.trim() : '';
  const termsOn = row.require_terms !== 'false';
  return { name: row.name, termsText: termsOn && text ? text : null };
});
