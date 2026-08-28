/**
 * Canonical Promo WhatsApp template definitions.
 *
 * Single source of truth imported by:
 * - `lib/channels/provision-templates.ts` (generic provisioner — Embedded Signup)
 * - `app/api/whatsapp/templates/provision/route.ts` (capability provisioner — on-demand)
 * - `lib/__tests__/acc-211-template-provisioning.test.ts` (contract tests)
 *
 * Template bodies are owner-approved and MUST NOT be modified without explicit owner sign-off.
 */

export interface PromoTemplateContract {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  components: Array<{
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    format?: string;
    text?: string;
    buttons?: Array<{ type: string; text: string; url?: string }>;
    example?: { body_text?: string[][] };
  }>;
}

export const PROMO_TEMPLATE_CONTRACTS: Record<string, PromoTemplateContract> = {
  promo_pickup_verification_v2: {
    name: 'promo_pickup_verification_v2',
    language: 'en_US',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: '{{1}} — Your {{2}} pickup verification code is {{3}}. It expires in {{4}} minutes. Only share this code with the sponsoring business when collecting your prize.',
      example: { body_text: [['Acme Corp', 'Gold Watch', '123456', '10']] },
    }],
  },
  promo_winner_status_v1: {
    name: 'promo_winner_status_v1',
    language: 'en_US',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: '{{1}} — You won {{3}} in the {{2}} promotion. Claim reference: {{4}}. Keep this reference for lookup and status checks. It does not replace any required pickup verification.',
      example: { body_text: [['Acme Corp', 'Summer Giveaway', 'Gold Watch', 'WAA-XXXX-XXXX-XXXX-XXXX']] },
    }],
  },
  promo_fulfillment_status_v1: {
    name: 'promo_fulfillment_status_v1',
    language: 'en_US',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: '{{1}} — Update for {{2}}: {{3}}. Claim reference: {{4}}. Status: {{5}}.',
      example: { body_text: [['Acme Corp', 'Summer Giveaway', 'Gold Watch', 'WAA-XXXX-XXXX-XXXX-XXXX', 'Fulfilled']] },
    }],
  },
};
