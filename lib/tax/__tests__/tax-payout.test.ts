import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { taxPayoutCurrencies, taxPayoutProjection } from '@/lib/payments/tax-payout';
function client(data: unknown, error: unknown = null) {
  return { rpc: vi.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient;
}
describe('tax payout projection adapter', () => {
  it('keeps unaffected merchants on legacy calculation', async () => {
    const db = client({ affected: false });
    expect(await taxPayoutProjection(db, 'business', 'USD')).toBeNull();
    expect(db.rpc).toHaveBeenCalledWith('tax_refund_payout_projection_980', { p_business_id: 'business', p_currency: 'USD' });
  });
  it('discovers affected currencies independently of current period earnings', async () => {
    const db = client(['USD','NGN']);
    expect(await taxPayoutCurrencies(db,'business')).toEqual(['USD','NGN']);
    expect(db.rpc).toHaveBeenCalledWith('tax_refund_payout_currencies_980',{p_business_id:'business'});
  });
  it('retains signed adjustment debt and server-calculated spendable balance', async () => {
    const projection = {affected:true,gross:315,platformFee:10,gatewayFee:3,adjustments:-107.5,commitments:192,netAvailable:2.5};
    expect(await taxPayoutProjection(client(projection),'business','USD')).toEqual(projection);
  });
  it('fails closed on unreadable or malformed financial authority', async () => {
    for (const value of [null,{}, {affected:true}, {affected:true,gross:NaN}]) {
      await expect(taxPayoutProjection(client(value),'business','USD')).rejects.toThrow();
    }
    await expect(taxPayoutProjection(client({affected:false},{message:'denied'}),'business','USD')).rejects.toThrow();
    await expect(taxPayoutCurrencies(client(['usd']),'business')).rejects.toThrow();
  });
});
