/**
 * Owner decision 2026-11-04: a merchant's own "table" keyword still wins over the
 * built-in category keyword, with or without M509 applied.
 *   - before M509 the category row is 'table' / contains  (shadowed by identical text)
 *   - after  M509 the category row is '\btables?\b' / regex (shadowed because the
 *     regex matches the merchant's keyword as a whole)
 * Exercised through the real loadUnifiedKeywords + matchUnifiedKeyword.
 */
import { describe, expect, it } from 'vitest';
import { loadUnifiedKeywords, matchUnifiedKeyword } from '@/lib/bot/keyword-service';

type Kw = { keyword: string; match_type: string; action_type: string; payload: string; priority: number };
let seq = 0;

/** Fresh category/business ids per call so the module caches never leak between cases. */
function db(category: Kw[], business: Kw[]) {
  seq += 1;
  const cat = `cat_${seq}`, biz = `biz_${seq}`;
  const row = (scope: string, k: Kw, i: number) => ({
    id: `${scope}-${i}`, scope, category: scope === 'category' ? cat : null, business_id: scope === 'business' ? biz : null,
    campaign_id: null, description: null, ...k,
  });
  const supabase = {
    from: () => {
      const filters: Record<string, unknown> = {};
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { filters[c] = v; return q; };
      q.order = async () => {
        const data = filters.scope === 'category' ? category.map((k, i) => row('category', k, i))
          : filters.scope === 'business' ? business.map((k, i) => row('business', k, i)) : [];
        return { data, error: null };
      };
      return q;
    },
  };
  return { supabase: supabase as never, cat, biz };
}

const TABLE_RESERVATION = '{"capability":"table_reservation"}';
const PRE_M509: Kw = { keyword: 'table', match_type: 'contains', action_type: 'start_capability', payload: TABLE_RESERVATION, priority: 55 };
const POST_M509: Kw = { keyword: '\\btables?\\b', match_type: 'regex', action_type: 'start_capability', payload: TABLE_RESERVATION, priority: 55 };
const MERCHANT_TABLE: Kw = { keyword: 'table', match_type: 'contains', action_type: 'reply', payload: '{"message":"Call us to book"}', priority: 10 };

describe('merchant "table" keyword beats the built-in one', () => {
  it.each([['without M509', PRE_M509], ['with M509', POST_M509]])('%s', async (_label, categoryRow) => {
    const { supabase, cat, biz } = db([categoryRow], [MERCHANT_TABLE]);
    const kws = await loadUnifiedKeywords(supabase, biz, cat);
    expect(kws.filter(k => k.scope === 'category')).toHaveLength(0);
    expect(matchUnifiedKeyword('table for 4', kws)).toMatchObject({ scope: 'business', action_type: 'reply' });
  });

  it.each([['without M509', PRE_M509], ['with M509', POST_M509]])('%s, no merchant keyword: the built-in one routes to Tables & Sections', async (_label, categoryRow) => {
    const { supabase, cat, biz } = db([categoryRow], []);
    const kws = await loadUnifiedKeywords(supabase, biz, cat);
    expect(matchUnifiedKeyword('table for 4', kws)).toMatchObject({ scope: 'category', payload: TABLE_RESERVATION });
  });

  it('a merchant "tables" keyword also overrides the M509 regex', async () => {
    const { supabase, cat, biz } = db([POST_M509], [{ ...MERCHANT_TABLE, keyword: 'Tables' }]);
    const kws = await loadUnifiedKeywords(supabase, biz, cat);
    expect(kws.filter(k => k.scope === 'category')).toHaveLength(0);
  });

  it('an unrelated or longer merchant keyword does not hide the built-in one', async () => {
    const merchant = [{ ...MERCHANT_TABLE, keyword: 'table tennis' }, { ...MERCHANT_TABLE, keyword: 'vegetable' }];
    const { supabase, cat, biz } = db([POST_M509], merchant);
    const kws = await loadUnifiedKeywords(supabase, biz, cat);
    expect(kws.filter(k => k.scope === 'category').map(k => k.keyword)).toEqual(['\\btables?\\b']);
    expect(matchUnifiedKeyword('table for 4', kws)).toMatchObject({ scope: 'category', payload: TABLE_RESERVATION });
  });

  it('other category rows are unaffected by the regex rule', async () => {
    const delivery: Kw = { keyword: 'delivery', match_type: 'contains', action_type: 'start_capability', payload: '{"capability":"ordering"}', priority: 60 };
    const { supabase, cat, biz } = db([delivery, POST_M509], [MERCHANT_TABLE]);
    const kws = await loadUnifiedKeywords(supabase, biz, cat);
    expect(kws.filter(k => k.scope === 'category').map(k => k.keyword)).toEqual(['delivery']);
  });
});
