/** Pure SQL/TS parity, executed only against an explicitly supplied disposable test DB. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { calculateTaxQuote, parseTaxPercent, validateTaxSnapshot, type MerchantTaxConfig, type TaxInputLine } from '../calculation';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw new Error('TEST_DATABASE_URL required for tax SQL parity');
if (url) {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) {
    throw new Error('Tax SQL parity requires a disposable loopback test database');
  }
}
const suite = url ? describe : describe.skip;
const base: MerchantTaxConfig = { enabled: true, label: 'VAT', rateBps: 750, priceMode: 'exclusive' };
const item = (id: string, unitAmount: number, quantity = 1): TaxInputLine => ({ id, description: 'Product', unitAmount, quantity });
let db: Client;

async function sqlQuote(config: unknown, lines: unknown, discount = 0, currency = 'USD') {
  return (await db.query('SELECT public.calculate_merchant_tax_quote_980($1::jsonb,$2,$3::jsonb,$4::bigint) AS quote',
    [JSON.stringify(config), currency, JSON.stringify(lines), discount])).rows[0].quote;
}

suite('SQL merchant tax calculator parity', () => {
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    // This file owns only its two pure functions in the disposable database.
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
    DROP FUNCTION IF EXISTS public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint);
    DROP FUNCTION IF EXISTS public.validate_merchant_tax_rule_980(jsonb);
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;`);
    await db.query(readFileSync('supabase/migrations/530_merchant_tax_calculator.sql', 'utf8'));
  });
  afterAll(async () => { await db?.end(); });

  it.each(['USD', 'GBP', 'CAD', 'NGN'])('matches mixed treatments, discount and delivery in %s', async currency => {
    const lines: TaxInputLine[] = [item('normal', 1999, 3),
      { ...item('inclusive', 777), tax: { treatment: 'override', rule: { label: 'Included tax', rateBps: 2000, priceMode: 'inclusive' } } },
      { ...item('zero', 123), tax: { treatment: 'override', rule: { label: 'Zero rated', rateBps: 0, priceMode: 'exclusive' } } },
      { ...item('exempt', 555), tax: { treatment: 'exempt' } },
      { ...item('delivery', 300), discountEligible: false, tax: { treatment: 'exempt' } }];
    expect(await sqlQuote(base, lines, 333, currency)).toEqual(calculateTaxQuote(base, currency, lines, 333));
  });
  it('matches deterministic largest-remainder ties and zero eligible amounts', async () => {
    for (const [lines, discount] of [[['a','b','c'].map(id => item(id, 1)), 1], [[item('zero', 0)], 0]] as [TaxInputLine[], number][]) {
      expect(await sqlQuote(base, lines, discount)).toEqual(calculateTaxQuote(base, 'USD', lines, discount));
    }
  });
  it('matches tax disabled even with overrides', async () => {
    const config = { ...base, enabled: false };
    const lines: TaxInputLine[] = [{ ...item('a', 123), tax: { treatment: 'override', rule: { label: 'Other', rateBps: 9999, priceMode: 'inclusive' } } }];
    expect(await sqlQuote(config, lines)).toEqual(calculateTaxQuote(config, 'USD', lines));
  });
  it.each(['exclusive','inclusive'] as const)('preserves a merchant-entered 8.875 percent %s rate',async priceMode=>{
    const config={...base,rateBps:parseTaxPercent('8.875'),priceMode};
    expect(config.rateBps).toBe(887.5);
    const lines=[item('a',10000)];
    const result=calculateTaxQuote(config,'USD',lines);
    expect(await sqlQuote(config,lines)).toEqual(result);
    expect(result.taxAmount).toBe(priceMode==='exclusive'?888:815);
    validateTaxSnapshot(result);
    expect(()=>parseTaxPercent('8.87501')).toThrow();
    await expect(sqlQuote({...config,rateBps:887.501},lines)).rejects.toThrow();
  });
  it('matches UTF-16 emoji label and description boundaries',async()=>{
    const config={...base,label:'😀'.repeat(30)};
    const lines=[{...item('a',100),description:'😀'.repeat(250)}];
    expect(await sqlQuote(config,lines)).toEqual(calculateTaxQuote(config,'USD',lines));
    for(const [c,l] of [[{...config,label:config.label+'x'},lines],[config,[{...lines[0],description:lines[0].description+'x'}]]] as [MerchantTaxConfig,TaxInputLine[]][]){
      expect(()=>calculateTaxQuote(c,'USD',l)).toThrow();
      await expect(sqlQuote(c,l)).rejects.toThrow();
    }
  });
  it('keeps direct volume discounts on their own lines, then allocates basket discounts', async () => {
    const lines: TaxInputLine[] = [{ ...item('taxed', 1000), lineDiscountAmount: 500 },
      { ...item('exempt', 1000), tax: { treatment: 'exempt' } }];
    expect(await sqlQuote(base, lines, 300)).toEqual(calculateTaxQuote(base, 'USD', lines, 300));
    expect(await sqlQuote(base, [{ ...item('fully discounted', 100), lineDiscountAmount: 100 }])).toEqual(
      calculateTaxQuote(base, 'USD', [{ ...item('fully discounted', 100), lineDiscountAmount: 100 }]));
    await expect(sqlQuote(base, [{ ...item('a', 100), lineDiscountAmount: 101 }])).rejects.toThrow();
  });
  it('preserves exact rounding near safe integer limits without decimal-division drift', async () => {
    const config = { ...base, priceMode: 'inclusive' as const, rateBps: 3333 };
    const lines = [item('a', 4503599627370489), item('b', 4503599627370489)];
    expect(await sqlQuote(config, lines, 9007199254740977)).toEqual(calculateTaxQuote(config, 'USD', lines, 9007199254740977));
    expect(await sqlQuote(config, [item('max', Number.MAX_SAFE_INTEGER)])).toEqual(calculateTaxQuote(config, 'USD', [item('max', Number.MAX_SAFE_INTEGER)]));
  });
  it('matches UTF-16 label limits and JavaScript whitespace trimming', async () => {
    const config = { ...base, label: '\u00a0\tVAT\n\u3000' };
    expect(await sqlQuote(config, [item('a', 10)])).toEqual(calculateTaxQuote(config, 'USD', [item('a', 10)]));
    await expect(sqlQuote({ ...base, label: '😀'.repeat(31) }, [item('a', 10)])).rejects.toThrow();
  });
  it('matches a seeded range of inclusive/exclusive rates and basket discounts', async () => {
    for (let i = 0; i < 60; i++) {
      const config = { ...base, rateBps: (i * 173) % 10001, priceMode: i % 2 ? 'inclusive' as const : 'exclusive' as const };
      const lines = [item('a', i * 91, 3), item('b', i * 13 + 1, 2)];
      expect(await sqlQuote(config, lines, i)).toEqual(calculateTaxQuote(config, 'USD', lines, i));
    }
  });
  it.each([
    { name: 'negative amount', lines: [item('a', -1)] },
    { name: 'fractional amount', lines: [item('a', 1.1)] },
    { name: 'zero quantity', lines: [item('a', 1, 0)] },
    { name: 'overflow', lines: [item('a', Number.MAX_SAFE_INTEGER, 2)] },
    { name: 'duplicate identifiers', lines: [item('a', 1), item('a', 1)] },
    { name: 'empty basket', lines: [] },
    { name: 'missing override', lines: [{ ...item('a', 1), tax: { treatment: 'override' } }] },
    { name: 'non-string id', lines: [{ ...item('a', 1), id: 1 }] },
  ])('rejects $name in both implementations', async ({ lines }) => {
    expect(() => calculateTaxQuote(base, 'USD', lines as TaxInputLine[])).toThrow();
    await expect(sqlQuote(base, lines)).rejects.toThrow();
  });
  it('rejects bad configuration, discount and currency', async () => {
    for (const config of [{ ...base, enabled: 'true' }, { ...base, rateBps: 10001 }, { ...base, rateBps: 1.111 }, { ...base, label: '' }, { ...base, priceMode: 'wrong' }]) {
      expect(() => calculateTaxQuote(config as MerchantTaxConfig, 'USD', [item('a', 1)])).toThrow();
      await expect(sqlQuote(config, [item('a', 1)])).rejects.toThrow();
    }
    await expect(sqlQuote(base, [item('a', 1)], 2)).rejects.toThrow();
    await expect(sqlQuote(base, [item('a', 1)], -1)).rejects.toThrow();
    await expect(sqlQuote(base, [item('a', 1)], 0, 'usd')).rejects.toThrow();
  });
  it('allows only the service role and preserves immutable/invoker attributes', async () => {
    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await expect(sqlQuote(base, [item('a', 1)])).rejects.toThrow(/permission denied/);
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    expect(await sqlQuote(base, [item('a', 100)])).toEqual(calculateTaxQuote(base, 'USD', [item('a', 100)]));
    await db.query('RESET ROLE');
    const { rows } = await db.query(`SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid='public.calculate_merchant_tax_quote_980(jsonb,text,jsonb,bigint)'::regprocedure`);
    expect(rows[0]).toEqual({ prosecdef: false, provolatile: 'i', proconfig: ['search_path=pg_catalog'] });
  });
});
