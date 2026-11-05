/**
 * M466 -> M468 real PostgreSQL contract: preserve legacy records and allow
 * only one nonterminal payout per (business, period, currency).
 * CI executes this against a fresh disposable database with zero skips.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const URL = process.env.TEST_DATABASE_URL;
if (!URL && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('M468 requires TEST_DATABASE_URL');
const suite = URL ? describe : describe.skip;
const B = '00000000-0000-0000-0000-000000468001';
const P = '2026-10-01', E = '2026-10-07';
let db: Client;
async function client() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  return c;
}
const insert = async (currency: string | null, status = 'pending', biz = B) =>
  db.query('INSERT INTO public.business_payouts (business_id,period_start,period_end,status,currency) VALUES ($1,$2,$3,$4,$5)', [biz,P,E,status,currency]);

suite('M468 currency-aware payout uniqueness — real PostgreSQL', () => {
  beforeAll(async () => {
    db = await client();
    await db.query(`CREATE TABLE public.business_payouts (
      id BIGSERIAL PRIMARY KEY, business_id UUID NOT NULL,
      period_start DATE NOT NULL, period_end DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE public.payout_adjustments (id BIGSERIAL PRIMARY KEY);`);
    await db.query(readFileSync(resolve('supabase/migrations/159_payout_dedup_constraint.sql'), 'utf8'));
    await db.query(readFileSync(resolve('supabase/migrations/466_payout_currency_authority.sql'), 'utf8'));
    await db.query(readFileSync(resolve('supabase/migrations/468_payout_dedup_currency_authority.sql'), 'utf8'));
  });
  beforeEach(async () => { await db.query('DELETE FROM public.business_payouts'); });
  afterAll(async () => { if (db) await db.end(); });

  it('allows distinct known currencies for same merchant and period', async () => {
    await insert('USD'); await insert('NGN');
    const r = await db.query('SELECT currency FROM business_payouts ORDER BY currency');
    expect(r.rows.map(x => x.currency)).toEqual(['NGN','USD']);
  });
  it('blocks duplicate payouts within the same currency', async () => {
    await insert('USD');
    await expect(insert('USD')).rejects.toMatchObject({ code: '23505' });
  });
  it('enforces one legacy NULL-currency record per business and period', async () => {
    await insert(null);
    await expect(insert(null)).rejects.toMatchObject({ code: '23505' });
  });
  it('preserves historical rejected/failed-status exclusion', async () => {
    await insert('USD','rejected'); await insert('USD','failed'); await insert('USD','pending');
    const r = await db.query('SELECT COUNT(*)::int AS n FROM business_payouts');
    expect(r.rows[0].n).toBe(3);
  });
  it('enforces concurrent duplicate generation, one winner only', async () => {
    const a = await client(), b = await client();
    try {
      const q = 'INSERT INTO public.business_payouts (business_id,period_start,period_end,status,currency) VALUES ($1,$2,$3,$4,$5)';
      const rs = await Promise.allSettled([a.query(q,[B,P,E,'pending','CAD']),b.query(q,[B,P,E,'pending','CAD'])]);
      expect(rs.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      expect(rs.filter(x => x.status === 'rejected')).toHaveLength(1);
      const r = await db.query("SELECT count(*)::int n FROM business_payouts WHERE currency='CAD'");
      expect(r.rows[0].n).toBe(1);
    } finally { await a.end(); await b.end(); }
  });
  it('replaying M468 remains idempotent', async () => {
    await db.query(readFileSync(resolve('supabase/migrations/468_payout_dedup_currency_authority.sql'), 'utf8'));
    await insert('GBP');
    await expect(insert('GBP')).rejects.toMatchObject({ code: '23505' });
  });
});
