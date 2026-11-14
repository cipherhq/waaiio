import type { SupabaseClient } from '@supabase/supabase-js';
import { requireCurrentCapability } from '@/lib/bot/flows/shared/capability-guard';
import { resolveBusinessGateway } from '@/lib/payments/gateway-resolver';
import { canonicalSavedCardPhone } from '@/lib/payments/saved-card-compat';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadPublicCampaign(supabase: SupabaseClient, campaignId: string) {
  if (!UUID_PATTERN.test(campaignId)) return null;
  const { data: campaign, error } = await supabase.from('campaigns')
    .select('id, business_id, title, description, goal_amount, raised_amount, currency, start_date, end_date, min_donation, max_donation, allow_after_end_date, allow_after_goal_met, businesses!inner(name, country_code, subscription_tier, status)')
    .eq('id', campaignId).eq('status', 'active').is('deleted_at', null).maybeSingle();
  if (error) throw new Error('Campaign lookup failed');
  if (!campaign) return null;
  const business = campaign.businesses as unknown as {
    name: string; country_code: string; subscription_tier: string; status: string;
  };
  const today = new Date().toISOString().slice(0, 10);
  if (business.status !== 'active' || (campaign.start_date && campaign.start_date > today)
    || (campaign.end_date && campaign.end_date < today && campaign.allow_after_end_date === false)
    || (campaign.goal_amount > 0 && campaign.raised_amount >= campaign.goal_amount && campaign.allow_after_goal_met === false)) return null;
  const capability = await requireCurrentCapability(supabase, {
    businessId: campaign.business_id, capability: 'crowdfunding', action: 'create_new',
  });
  if (!capability.allowed) return null;
  const gateway = await resolveBusinessGateway(supabase, campaign.business_id);
  if (!gateway.gateway || !gateway.currency || campaign.currency !== gateway.currency) return null;
  return { ...campaign, business, currency: gateway.currency };
}

export function parseDonationInput(body: unknown) {
  if (!body || typeof body !== 'object') return { error: 'Unable to start payment. Please try again.' };
  const input = body as Record<string, unknown>;
  if (typeof input.attemptId !== 'string' || !UUID_PATTERN.test(input.attemptId)) {
    return { error: 'Unable to start payment. Please try again.' };
  }
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)
    || input.amount < 1 || input.amount > 10_000_000
    || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.00001) {
    return { error: 'Enter a valid donation amount.' };
  }
  if (typeof input.phone !== 'string' || input.phone.length > 40) return { error: 'Enter a valid phone number.' };
  const phone = canonicalSavedCardPhone(input.phone.replace(/[\s()\-]/g, ''));
  if (!phone) return { error: 'Enter a valid phone number.' };
  if (input.name != null && (typeof input.name !== 'string' || input.name.length > 120)) {
    return { error: 'Unable to start payment. Please try again.' };
  }
  if (input.email != null && (typeof input.email !== 'string' || input.email.length > 254)) {
    return { error: 'Enter a valid email address.' };
  }
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  return { value: { attemptId: input.attemptId.toLowerCase(), amount: input.amount, phone,
    name: typeof input.name === 'string' ? input.name.trim() : '', email } };
}
