import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `By tapping *Continue*, you agree to *${businessName}*'s and *Waaiio*'s terms and policies.`;

export function getTermsPrompt(businessName: string, customTermsText?: string | null): PromptMessage[] {
  const body = customTermsText
    ? `${customTermsText}\n\nTap *Continue* to accept or *Cancel* to go back.`
    : DEFAULT_TERMS(businessName);

  return [{
    type: 'buttons',
    body,
    buttons: [
      { id: 'accept_terms', title: 'Continue ✅' },
      { id: 'cancel_terms', title: 'Cancel' },
    ],
  }];
}
