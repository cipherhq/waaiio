import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `By tapping *Continue*, you agree to *${businessName}*'s terms and policies.`;

/**
 * The link the bot sends next to "📎 Terms:" in payment summaries.
 * A merchant-set metadata.terms_url wins. Otherwise it is the business's public
 * terms page (app/t/[slug]) on this deployment's own domain, so staging links
 * open on staging. Without a slug it is Waaiio's own /terms page.
 */
export function getBusinessTermsUrl(business?: { slug?: string | null; metadata?: unknown } | null): string {
  const meta = (business?.metadata || {}) as Record<string, unknown>;
  if (typeof meta.terms_url === 'string' && meta.terms_url) return meta.terms_url;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com').replace(/\/+$/, '');
  return business?.slug ? `${appUrl}/t/${encodeURIComponent(business.slug)}` : `${appUrl}/terms`;
}

/**
 * Generate the T&C prompt with optional business-specific terms URL.
 * @param businessName - Display name of the business
 * @param customTermsText - Custom terms text from business metadata (optional)
 * @param businessSlug - Business slug for linking to their terms page (optional)
 * @param termsUrl - Custom terms URL from business metadata (optional)
 */
export function getTermsPrompt(businessName: string, customTermsText?: string | null, businessSlug?: string | null, termsUrl?: string | null): PromptMessage[] {
  // Use business's own terms URL if set, otherwise link to Waaiio's standard terms
  const link = termsUrl || 'https://www.waaiio.com/terms';

  const termsLink = link ? `\n\n📎 View T&Cs: ${link}` : '';

  let body: string;
  if (customTermsText) {
    body = `📜 *${businessName} — Terms & Conditions*\n\n${customTermsText}${termsLink}\n\nTap *Continue* to accept or *Cancel* to go back.`;
  } else {
    body = `📜 *${businessName} — Terms & Conditions*\n\n${DEFAULT_TERMS(businessName)}${termsLink}`;
  }

  return [{
    type: 'buttons',
    body,
    buttons: [
      { id: 'accept_terms', title: 'Continue ✅' },
      { id: 'cancel_terms', title: 'Cancel' },
    ],
  }];
}
