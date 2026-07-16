import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface CreditBalance {
  total: number;
  reserved: number;
  available: number;
  breakdown: Array<{ type: string; remaining: number; expiresAt?: string }>;
}

export async function getBalance(supabase: SupabaseClient, businessId: string): Promise<CreditBalance> {
  const { data: credits } = await supabase
    .from('growth_credits')
    .select('type, remaining, expires_at')
    .eq('business_id', businessId)
    .gt('remaining', 0);

  const total = (credits || []).reduce((sum, c) => sum + c.remaining, 0);

  // Get reserved credits from active campaigns
  const { data: reserved } = await supabase
    .from('growth_campaigns')
    .select('credits_reserved, credits_consumed')
    .eq('business_id', businessId)
    .in('status', ['draft', 'scheduled', 'sending']);

  const totalReserved = (reserved || []).reduce((sum, c) =>
    sum + ((c.credits_reserved || 0) - (c.credits_consumed || 0)), 0);

  return {
    total,
    reserved: totalReserved,
    available: total - totalReserved,
    breakdown: (credits || []).map(c => ({
      type: c.type,
      remaining: c.remaining,
      expiresAt: c.expires_at,
    })),
  };
}

export async function reserveCredits(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  amount: number,
): Promise<{ success: boolean; error?: string }> {
  const balance = await getBalance(supabase, businessId);
  if (balance.available < amount) {
    return { success: false, error: `Insufficient credits. Available: ${balance.available}, needed: ${amount}` };
  }

  // Record reservation
  const { error } = await supabase.from('growth_credit_transactions').insert({
    business_id: businessId,
    campaign_id: campaignId,
    type: 'reserve',
    amount: -amount,
    balance_after: balance.available - amount,
  });

  if (error) {
    logger.error('[CREDITS] Reserve failed:', error.message);
    return { success: false, error: error.message };
  }
  return { success: true };
}

export async function consumeCredits(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  amount: number,
): Promise<void> {
  // Deduct from the oldest non-expired credit balance
  const { data: credits } = await supabase
    .from('growth_credits')
    .select('id, remaining')
    .eq('business_id', businessId)
    .gt('remaining', 0)
    .order('created_at', { ascending: true });

  let remaining = amount;
  for (const credit of credits || []) {
    if (remaining <= 0) break;
    const deduct = Math.min(remaining, credit.remaining);
    await supabase
      .from('growth_credits')
      .update({ remaining: credit.remaining - deduct })
      .eq('id', credit.id);
    remaining -= deduct;
  }

  await supabase.from('growth_credit_transactions').insert({
    business_id: businessId,
    campaign_id: campaignId,
    type: 'consume',
    amount: -amount,
  });
}

export async function releaseCredits(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  amount: number,
): Promise<void> {
  // Return unused credits to the newest credit balance
  const { data: credits } = await supabase
    .from('growth_credits')
    .select('id, remaining, amount')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (credits) {
    await supabase
      .from('growth_credits')
      .update({ remaining: credits.remaining + amount })
      .eq('id', credits.id);
  }

  await supabase.from('growth_credit_transactions').insert({
    business_id: businessId,
    campaign_id: campaignId,
    type: 'release',
    amount,
  });
}

export async function grantCredits(
  supabase: SupabaseClient,
  businessId: string,
  type: 'included' | 'purchased' | 'promotional',
  amount: number,
  source: string,
  reference?: string,
  expiresAt?: string,
): Promise<{ success: boolean }> {
  const { error } = await supabase.from('growth_credits').insert({
    business_id: businessId,
    type,
    amount,
    remaining: amount,
    source,
    reference: reference || null,
    expires_at: expiresAt || null,
  });

  if (!error) {
    await supabase.from('growth_credit_transactions').insert({
      business_id: businessId,
      type: 'grant',
      amount,
    });
  }

  return { success: !error };
}
