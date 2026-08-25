/**
 * Promotions customer history helper — trusted server-side reads.
 *
 * Single authority for customer Instant Win history:
 *   promo_redemptions WHERE business_id AND phone_e164
 *
 * Used by:
 * - My Account discoverability (hasPromoHistory)
 * - My Instant Win History menu visibility (hasPromoHistory)
 * - My Instant Win History rendering (getPromoHistory)
 *
 * Uses service client (RLS blocks customer reads on promo_redemptions).
 * Returns only customer-safe DTO — never raw DB rows.
 */
import { createServiceClient } from '@/lib/supabase/service';

// ── Customer-safe DTO ──

export interface PromoHistoryEntry {
  campaignName: string;
  isWinner: boolean;
  prizeName: string | null;
  prizeValue: number | null;
  prizeCurrency: string | null;
  claimReference: string;
  claimedAt: string;
  fulfillmentLabel: string;
  verificationLabel: string | null;
}

// ── Exhaustive status mappings (fail-closed) ──

const FULFILLMENT_LABELS: Record<string, string> = {
  pending: '⏳ Pending',
  processing: '🔄 Processing',
  fulfilled: '✅ Collected',
  rejected: '❌ Rejected',
  cancelled: '❌ Cancelled',
};

const VERIFICATION_LABELS: Record<string, string | null> = {
  not_required: null, // omit
  phone_verified: '✅ Verified',
  verified: '✅ Verified',
  locked: '🔒 Locked',
};

function safeFulfillmentLabel(status: string): string {
  return FULFILLMENT_LABELS[status] || '⏳ Processing'; // fail closed
}

function safeVerificationLabel(status: string): string | null {
  if (status in VERIFICATION_LABELS) return VERIFICATION_LABELS[status];
  return null; // fail closed — omit unknown
}

// ── History authority ──

/**
 * Check if a customer has any promo redemption history for this business.
 * Uses canonical phone identity (ctx.from — no + prefix).
 */
export async function hasPromoHistory(businessId: string, phone: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('promo_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('phone_e164', phone)
    .limit(1);
  return (count ?? 0) > 0;
}

/**
 * Get customer promo redemption history for this business.
 * Returns customer-safe DTO only — never raw DB rows.
 * Newest first, bounded to 10 records.
 */
export async function getPromoHistory(businessId: string, phone: string): Promise<PromoHistoryEntry[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('promo_redemptions')
    .select(`
      outcome, claim_reference, claimed_at,
      fulfillment_status, verification_status,
      promo_campaigns!inner ( name ),
      promo_prizes ( name, value, currency )
    `)
    .eq('business_id', businessId)
    .eq('phone_e164', phone)
    .order('claimed_at', { ascending: false })
    .limit(10);

  if (!data || data.length === 0) return [];

  return data.map((row: any) => {
    const isWinner = row.outcome === 'winner';
    const campaign = row.promo_campaigns as { name: string } | null;
    const prize = row.promo_prizes as { name: string; value: number | null; currency: string | null } | null;

    return {
      campaignName: campaign?.name || 'Promotion',
      isWinner,
      prizeName: isWinner ? (prize?.name || null) : null,
      prizeValue: isWinner ? (prize?.value || null) : null,
      prizeCurrency: isWinner ? (prize?.currency || null) : null,
      claimReference: row.claim_reference,
      claimedAt: row.claimed_at,
      fulfillmentLabel: safeFulfillmentLabel(row.fulfillment_status),
      verificationLabel: isWinner ? safeVerificationLabel(row.verification_status) : null,
    };
  });
}

/**
 * Render customer-safe history text for WhatsApp.
 */
export function renderPromoHistoryMessage(entries: PromoHistoryEntry[]): string {
  if (entries.length === 0) {
    return "You don't have any Instant Win history yet. 🎰";
  }

  const lines = ['🎰 *My Instant Win History*', ''];

  for (const entry of entries) {
    const date = new Date(entry.claimedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    if (entry.isWinner) {
      lines.push(`🏆 *${entry.campaignName}*`);
      lines.push(`Result: Winner`);
      if (entry.prizeName) {
        let prizeText = `🎁 Prize: ${entry.prizeName}`;
        if (entry.prizeValue && entry.prizeCurrency) {
          prizeText += ` (${entry.prizeCurrency} ${entry.prizeValue})`;
        }
        lines.push(prizeText);
      }
      lines.push(`🔖 Ref: ${entry.claimReference}`);
      lines.push(`📅 ${date}`);
      lines.push(entry.fulfillmentLabel);
      if (entry.verificationLabel) lines.push(entry.verificationLabel);
    } else {
      lines.push(`🎰 *${entry.campaignName}*`);
      lines.push(`Result: Not a winner this time`);
      lines.push(`📅 ${date}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
