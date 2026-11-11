import type { SupabaseClient } from '@supabase/supabase-js';

export interface TaxPayoutProjection {
  affected: true;
  gross: number;
  platformFee: number;
  gatewayFee: number;
  adjustments: number;
  commitments: number;
  netAvailable: number;
}
export async function taxPayoutCurrencies(client: SupabaseClient, businessId: string): Promise<string[]> {
  const { data, error } = await client.rpc('tax_refund_payout_currencies_980', { p_business_id: businessId });
  if (error || !Array.isArray(data) || data.some(c => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c))) {
    throw new Error('Tax payout currencies unavailable');
  }
  return data;
}
export async function taxPayoutProjection(client: SupabaseClient, businessId: string, currency: string): Promise<TaxPayoutProjection | null> {
  const { data, error } = await client.rpc('tax_refund_payout_projection_980', { p_business_id: businessId, p_currency: currency });
  if (error || !data || typeof data.affected !== 'boolean') throw new Error('Tax payout projection unavailable');
  if (!data.affected) return null;
  for (const key of ['gross','platformFee','gatewayFee','adjustments','commitments','netAvailable']) {
    if (typeof data[key] !== 'number' || !Number.isFinite(data[key])) throw new Error('Invalid tax payout projection');
  }
  return data as TaxPayoutProjection;
}
