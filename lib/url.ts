/**
 * Canonical public origin for customer-facing short URLs.
 *
 * Normalizes the known production apex `https://waaiio.com` to
 * `https://www.waaiio.com` so that newly generated short payment
 * links skip the Vercel apex→www redirect hop.
 *
 * Preserves non-production / custom origins unchanged.
 */
export function canonicalPublicOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  if (raw === 'https://waaiio.com') return 'https://www.waaiio.com';
  return raw;
}

/**
 * Action suffixes for permanent merchant links.
 * Maps QR template IDs to the capability IDs recognised by the existing
 * bot-code deep-link parser (bot-code-detection.ts VALID_CAPABILITIES).
 *
 * attendance is a web /checkin page — not routed through /m/.
 */
export const ACTION_CAPABILITY_MAP: Readonly<Record<string, string | null>> = {
  book: 'scheduling',
  order: 'ordering',
  pay: 'payment',
  ticket: 'ticketing',
  donate: 'crowdfunding',
  queue: 'queue',
  waitlist: 'waitlist',
  give: 'giving',
  chat: 'chat',
  generic: null,
};

export type MerchantLinkAction = keyof typeof ACTION_CAPABILITY_MAP;

/**
 * Build a permanent Waaiio link for a merchant's WhatsApp.
 *
 * /m/{uuid}          — base link (shared: bot_code, dedicated: plain wa.me)
 * /m/{uuid}/{action}  — action link (shared: bot_code:capability, dedicated: ?text=Hi)
 * attendance          — NOT built here; use /checkin/{uuid} directly
 */
export function buildMerchantLink(businessId: string, action?: MerchantLinkAction): string {
  const origin = canonicalPublicOrigin();
  if (!action || action === 'generic') {
    return `${origin}/m/${businessId}`;
  }
  return `${origin}/m/${businessId}/${action}`;
}

/**
 * Build a permanent merchant campaign link.
 */
export function buildMerchantCampaignLink(businessId: string, campaignId: string): string {
  const origin = canonicalPublicOrigin();
  return `${origin}/m/${businessId}/campaign/${campaignId}`;
}
