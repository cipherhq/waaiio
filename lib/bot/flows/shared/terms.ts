import type { PromptMessage } from '../types';

const DEFAULT_TERMS = (businessName: string) =>
  `Almost there! 🎉\n\nBy continuing, you confirm your order with *${businessName}* and acknowledge that:\n\n✅ Payment secures your booking/order\n✅ Contact *${businessName}* for any changes\n✅ Cancellations follow the business's policy\n\nThank you for your trust! 🙏`;

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
