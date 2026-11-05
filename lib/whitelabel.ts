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
 * Footer line for WhatsApp interactive messages (buttons/lists, max 60 chars)
 * under a completed transaction's next-steps menu, or undefined for
 * white-label accounts. Owner decision 2026-11-05.
 *
 * `businessIsWhitelabel` is the per-business `businesses.is_whitelabel` switch.
 * When known it wins over the plan, the same rule the greeting uses
 * (`checkTierLimitsFromBusiness`: `isWhitelabel ?? tier.whitelabel`).
 */
export function getPoweredByInteractiveFooter(
  subscriptionTier: string | null | undefined,
  businessIsWhitelabel?: boolean | null,
): string | undefined {
  if (businessIsWhitelabel ?? isWhiteLabel(subscriptionTier)) return undefined;
  return 'Powered by Waaiio.com';
}

/**
 * Returns the "Powered by Waaiio" footer as HTML, or empty string for white-label accounts.
 */
export function getPoweredByHtml(subscriptionTier: string | null | undefined): string {
  if (isWhiteLabel(subscriptionTier)) return '';
  return '<p style="color:#999;font-size:12px">Powered by Waaiio</p>';
}
