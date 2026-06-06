import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `By tapping *Continue*, you agree to *${businessName}*'s terms and policies.`;

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

  const termsLink = link ? `\n\n📎 View details: ${link}` : '';

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
