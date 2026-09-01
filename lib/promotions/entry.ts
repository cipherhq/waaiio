/**
 * Promotions entry helper — shared read-only authority for active campaign visibility.
 *
 * Used by:
 * - prepareCapabilityMenu() for menu visibility
 * - BotService deterministic cap_promo_verification intercept
 * - capability-selection validate() inline dispatch
 *
 * Single definition of "active campaign" = status='active' in promo_campaigns.
 * Same authority as hasActiveKeywordCampaign / hasActiveBareCodeCampaign.
 */
import { createServiceClient } from '@/lib/supabase/service';

export interface PromoEntryCampaign {
  id: string;
  name: string;
  keyword: string | null;
  code_entry_mode: string;
  accept_bare_codes: boolean;
  code_format: string | null;
}

/**
 * Get active promo campaigns for a business.
 * Returns only the metadata needed for menu visibility and entry rendering.
 */
export async function getActivePromoEntryCampaigns(businessId: string): Promise<PromoEntryCampaign[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('promo_campaigns')
    .select('id, name, keyword, code_entry_mode, accept_bare_codes, code_format')
    .eq('business_id', businessId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(10);
  return (data || []) as PromoEntryCampaign[];
}

/**
 * Check if a business has any active promo campaigns (for menu visibility).
 */
export async function hasActivePromoCampaigns(businessId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('promo_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('status', 'active');
  return (count ?? 0) > 0;
}

/**
 * Build a format hint line from the code_format column.
 * Only shown when code_format is populated and not the bare default.
 */
function formatHint(codeFormat: string | null): string {
  if (!codeFormat) return '';
  return `\n📝 Code format: *${codeFormat}*`;
}

/**
 * Render the Instant Win entry message for one or multiple active campaigns.
 */
export function renderPromoEntryMessage(campaigns: PromoEntryCampaign[]): string {
  if (campaigns.length === 1) {
    const c = campaigns[0];
    const instruction = c.keyword
      ? `Send: *${c.keyword} <your code>*`
      : 'Send your promo code now:';
    const hint = formatHint(c.code_format);
    return `🎰 *${c.name}*\n\n${instruction}${hint}`;
  }
  const lines = campaigns.map(c => {
    const hint = c.code_format ? ` (format: ${c.code_format})` : '';
    if (c.keyword) return `• *${c.name}*: Send *${c.keyword} <code>*${hint}`;
    return `• *${c.name}*: Send your code directly${hint}`;
  });
  return `🎰 *Active Promotions*\n\n${lines.join('\n')}\n\nSend your code to check if you've won!`;
}
