/**
 * M509 — restaurant "table" keyword is whole-word only. Real PostgreSQL proof
 * (disposable local database, created and dropped by this file).
 *
 * Seeds bot_keywords with the real 041 restaurant rows, applies 164 and then
 * 509 from disk (twice — idempotent), reads the rows back from PostgreSQL and
 * runs them through the real keyword-service matcher:
 *   - "vegetable soup" no longer starts a table reservation
 *   - "table for 4" (and "tables") still does
 *   - only the seeded category 'table' rows change; dine-in, business-scope
 *     and other categories' rows are untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { matchUnifiedKeyword } from '@/lib/bot/keyword-service';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M509 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m041 = readFileSync('supabase/migrations/041_unified_bot_keywords.sql', 'utf8');
const m164 = readFileSync('supabase/migrations/164_fix_keyword_routing.sql', 'utf8');
const m509 = readFileSync('supabase/migrations/509_table_keyword_whole_word.sql', 'utf8');
/** The exact 041 "-- Restaurant" seed statement */
const restaurantSeed = /-- Restaurant\n(INSERT INTO bot_keywords[\s\S]*?;)\n/.exec(m041)![1];
const database = `m509_${randomUUID().replaceAll('-', '')}`;
const BIZ = '00000000-0000-4000-a509-000000000001';

suite('M509 whole-word table keyword (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const rows = async () => (await client.query(
    `SELECT id::text, keyword, match_type, action_type, payload, priority, scope, category, business_id::text, NULL::text AS campaign_id, description
       FROM public.bot_keywords WHERE is_active ORDER BY priority DESC, keyword`,
  )).rows;
  const restaurantKeywords = async () => (await rows()).filter(r => r.scope === 'category' && r.category === 'restaurant');

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    // Final-state bot_keywords shape (040 + 041 + 203), constraints included
    await client.query(`
      CREATE TABLE public.bot_keywords (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID,
        keyword TEXT NOT NULL,
        match_type VARCHAR(10) NOT NULL DEFAULT 'contains',
        action_type VARCHAR(20) NOT NULL,
        payload TEXT NOT NULL,
        is_active BOOLEAN DEFAULT true,
        priority INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(),
        scope VARCHAR(10) NOT NULL DEFAULT 'business' CHECK (scope IN ('system', 'category', 'business')),
        category VARCHAR(40),
        description TEXT,
        campaign_id UUID,
        CONSTRAINT bot_keywords_match_type_check CHECK (match_type IN ('exact', 'contains', 'starts_with', 'regex')),
        CONSTRAINT bot_keywords_action_type_check CHECK (action_type IN ('reply', 'start_flow', 'start_capability', 'url', 'navigate_step', 'acknowledge', 'show_menu', 'campaign_reply')),
        CONSTRAINT category_has_category CHECK ((scope = 'category' AND category IS NOT NULL) OR scope != 'category'),
        CONSTRAINT business_has_business CHECK ((scope = 'business' AND business_id IS NOT NULL) OR scope != 'business')
      );`);
    await client.query(restaurantSeed);
    await client.query(m164);
    // Rows the migration must leave alone
    await client.query(`
      INSERT INTO public.bot_keywords (keyword, match_type, action_type, payload, priority, scope, category, business_id, description) VALUES
        ('table', 'contains', 'reply', '{"message":"merchant"}', 90, 'business', NULL, $1, 'merchant own keyword'),
        ('table', 'contains', 'start_capability', '{"capability":"scheduling"}', 55, 'category', 'salon', NULL, 'other category'),
        ('vegetable', 'contains', 'reply', '{"message":"veg"}', 10, 'category', 'restaurant', NULL, 'unrelated contains row');`, [BIZ]);
  });

  afterAll(async () => {
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('before 509: the seeded substring row matches "vegetable soup" (the defect)', async () => {
    const before = (await restaurantKeywords()).filter(r => r.description !== 'unrelated contains row');
    const table = before.find(r => r.keyword === 'table')!;
    expect(table).toMatchObject({ match_type: 'contains', payload: '{"capability":"table_reservation"}' });
    expect(matchUnifiedKeyword('vegetable soup', before as never)?.keyword).toBe('table');
  });

  it('applies 509 (self-check passes) and is idempotent', async () => {
    await client.query(m509);
    await client.query(m509);
    const table = (await restaurantKeywords()).filter(r => r.payload === '{"capability":"table_reservation"}');
    expect(table.map(r => [r.keyword, r.match_type]).sort()).toEqual([['\\btables?\\b', 'regex'], ['dine-in', 'contains']]);
  });

  it('after 509: "vegetable" no longer matches, "table for 4" still does', async () => {
    const kws = (await restaurantKeywords()).filter(r => r.description !== 'unrelated contains row');
    expect(matchUnifiedKeyword('vegetable soup', kws as never)).toBeNull();
    expect(matchUnifiedKeyword('comfortable seats', kws as never)).toBeNull();
    expect(JSON.parse(matchUnifiedKeyword('table for 4', kws as never)!.payload)).toEqual({ capability: 'table_reservation' });
    expect(JSON.parse(matchUnifiedKeyword('Any tables tonight?', kws as never)!.payload)).toEqual({ capability: 'table_reservation' });
    expect(matchUnifiedKeyword('we want to dine-in', kws as never)!.keyword).toBe('dine-in');
  });

  it('leaves business-scope, other-category and unrelated rows unchanged', async () => {
    const all = await rows();
    expect(all.find(r => r.scope === 'business')).toMatchObject({ keyword: 'table', match_type: 'contains' });
    expect(all.find(r => r.category === 'salon')).toMatchObject({ keyword: 'table', match_type: 'contains' });
    expect(all.find(r => r.keyword === 'vegetable')).toMatchObject({ match_type: 'contains' });
    expect(all.filter(r => r.match_type === 'regex')).toHaveLength(1);
  });

  it('self-check fails if a whole-word row is not regex', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO public.bot_keywords (keyword, match_type, action_type, payload, priority, scope, category)
        VALUES (E'\\\\btables?\\\\b', 'contains', 'start_capability', '{"capability":"table_reservation"}', 55, 'category', 'bar')`);
      await expect(client.query(m509)).rejects.toThrow(/509 SELF-CHECK FAILED/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
