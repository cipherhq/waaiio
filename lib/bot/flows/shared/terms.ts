import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `By tapping *Continue*, you agree to *${businessName}*'s and *Waaiio*'s terms and policies.`;

/**
 * Generate the T&C prompt with optional business-specific terms URL.
 * @param businessName - Display name of the business
 * @param customTermsText - Custom terms text from business metadata (optional)
 * @param businessSlug - Business slug for linking to their terms page (optional)
 */
export function getTermsPrompt(businessName: string, customTermsText?: string | null, businessSlug?: string | null): PromptMessage[] {
  const termsUrl = businessSlug
    ? `https://www.waaiio.com/b/${businessSlug}/terms`
    : 'https://www.waaiio.com/terms';

  const termsLink = `\n\n📎 View full terms: ${termsUrl}`;

  let body: string;
  if (customTermsText) {
    body = `📜 *Terms & Conditions*\n\n${customTermsText}${termsLink}\n\nTap *Continue* to accept or *Cancel* to go back.`;
  } else {
    body = `📜 *Terms & Conditions*\n\n${DEFAULT_TERMS(businessName)}${termsLink}`;
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
