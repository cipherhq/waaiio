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
    .gt('remaining', 0)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString());

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
  if (amount <= 0) return { success: false, error: 'Amount must be positive' };

  const { data, error } = await supabase.rpc('reserve_credits_atomic', {
    p_business_id: businessId,
    p_campaign_id: campaignId,
    p_amount: amount,
  });

  if (error) {
    logger.error('[CREDITS] Reserve RPC failed:', error.message);
    return { success: false, error: error.message };
  }
  if (!data?.success) {
    return { success: false, error: data?.reason === 'insufficient_credits'
      ? `Insufficient credits. Available: ${data?.available}`
      : data?.reason || 'Reserve failed' };
  }
  return { success: true };
}

export async function consumeCredits(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;

  const { data, error } = await supabase.rpc('consume_credits_atomic', {
    p_business_id: businessId,
    p_campaign_id: campaignId,
    p_amount: amount,
  });

  if (error) {
    logger.error('[CREDITS] Consume RPC failed:', error.message);
    throw new Error('Credit consumption failed');
  }
  if (!data?.success) {
    logger.error('[CREDITS] Consume RPC rejected:', data?.reason);
    throw new Error(data?.reason || 'Credit consumption failed');
  }
}

export async function releaseCredits(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
): Promise<{ success: boolean; released?: number; error?: string }> {
  const { data, error } = await supabase.rpc('release_credits_atomic', {
    p_business_id: businessId,
    p_campaign_id: campaignId,
  });

  if (error) {
    logger.error('[CREDITS] Release RPC failed:', error.message);
    return { success: false, error: error.message };
  }
  if (!data?.success) {
    return { success: false, error: data?.reason || 'Release failed' };
  }
  return { success: true, released: data.released };
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
  if (amount <= 0) return { success: false };

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
