import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `Tap *Continue* to confirm your order with *${businessName}* and proceed to payment.`;

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
