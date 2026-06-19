import { PRICING_TIERS, type SubscriptionTier } from '@/lib/constants';

/**
 * Check if a subscription tier qualifies for white-label (no Waaiio branding).
 * Uses PRICING_TIERS as the single source of truth.
 */
export function isWhiteLabel(subscriptionTier: string | null | undefined): boolean {
  const tier = (subscriptionTier || 'free') as SubscriptionTier;
  return PRICING_TIERS[tier]?.whitelabel === true;
}

/**
 * Returns the "Powered by Waaiio" footer for WhatsApp messages (Markdown italic),
 * or empty string for white-label accounts.
 */
export function getPoweredByFooter(subscriptionTier: string | null | undefined): string {
  if (isWhiteLabel(subscriptionTier)) return '';
  return '\n\n_Powered by Waaiio_';
}

/**
 * Returns the "Powered by Waaiio" footer as HTML, or empty string for white-label accounts.
 */
export function getPoweredByHtml(subscriptionTier: string | null | undefined): string {
  if (isWhiteLabel(subscriptionTier)) return '';
  return '<p style="color:#999;font-size:12px">Powered by Waaiio</p>';
}
