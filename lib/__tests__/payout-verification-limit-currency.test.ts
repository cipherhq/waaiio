import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ limit: 100, payouts: [] as Array<{ net_amount: number; currency: string | null }>, error: null as unknown }));
vi.mock('@/lib/constants', () => ({ getVerificationTiers: () => ({ basic: { limit: m.limit } }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {}, getCountry: () => ({ currency_code: 'NGN' }) }));
import { checkVerificationLimit } from '../payouts/verification-limit';
function db() {
  return { from: (table: string) => {
    const q: any = { select: () => q, eq: () => q, in: () => q, gte: () => q, neq: () => q,
      single: async () => ({ data: { verification_level: 'basic', country_code: 'NG' }, error: null }),
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: m.payouts, error: m.error }).then(ok) };
    if (table !== 'businesses' && table !== 'business_payouts') throw new Error('unexpected table');
    return q;
  } } as any;
}
beforeEach(() => { m.limit = 100; m.payouts = []; m.error = null; });
describe('finite payout tier denomination and unavailable evidence', () => {
  it('retains same-currency usage and requested amount', async () => {
    m.payouts = [{ net_amount: 95, currency: 'NGN' }];
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'NGN')).allowed).toBe(false);
  });
  it('rejects a foreign-currency request against a local-currency finite limit', async () => {
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'USD')).allowed).toBe(false);
  });
  it.each(['USD', null])('rejects %s historical usage instead of summing unlike units', async currency => {
    m.payouts = [{ net_amount: 1, currency }];
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'NGN')).allowed).toBe(false);
  });
  it('rejects usage query failure rather than resetting usage to zero', async () => {
    m.error = { message: 'synthetic failure' };
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'NGN')).allowed).toBe(false);
  });
  it('allows same-currency usage below the finite limit', async () => {
    m.payouts = [{ net_amount: 10, currency: 'NGN' }];
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'NGN')).allowed).toBe(true);
  });
  it('denies missing authoritative request currency', async () => {
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout')).allowed).toBe(false);
  });
  it('denies non-finite historical amounts', async () => {
    m.payouts = [{ net_amount: NaN, currency: 'NGN' }];
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'NGN')).allowed).toBe(false);
  });
  it('preserves explicitly unlimited tiers without inventing FX conversion', async () => {
    m.limit = 999_999_999;
    expect((await checkVerificationLimit(db(), 'fixture', 1000, 'payout', 'USD')).allowed).toBe(true);
  });
});
