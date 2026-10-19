/**
 * Migration 447: search_businesses_fuzzy — Real PostgreSQL tests
 *
 * Runs against a disposable Postgres instance (TEST_DATABASE_URL).
 * Fails (not skips) when REQUIRE_PG_TESTS=true and TEST_DATABASE_URL is missing.
 *
 * Creates its own minimal schema, applies migration 447 from disk,
 * then tests eligibility filters, permission ACLs, location scoping,
 * and similarity thresholds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB && process.env.REQUIRE_PG_TESTS === 'true') {
  throw new Error('TEST_DATABASE_URL is required — cannot skip DB tests (REQUIRE_PG_TESTS=true)');
}

function sql(query: string): string {
  if (!TEST_DB) throw new Error('TEST_DATABASE_URL not set');
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A 2>&1`,
      { encoding: 'utf-8', timeout: 15000, input: query },
    ).trim();
  } catch (err: any) {
    const output = ((err.stdout || '') + (err.stderr || '')).trim();
    return `ERROR: ${output}`;
  }
}

const describeDb = !TEST_DB ? describe.skip : describe;

const OWNER_ID  = '00000000-0000-0000-0000-000000447010';
const BIZ_ACTIVE    = '00000000-0000-0000-0000-000000447001';
const BIZ_INACTIVE  = '00000000-0000-0000-0000-000000447002';
const BIZ_NO_BOT    = '00000000-0000-0000-0000-000000447003';
const BIZ_OPT_OUT   = '00000000-0000-0000-0000-000000447004';
const BIZ_HIDDEN    = '00000000-0000-0000-0000-000000447005';
const BIZ_ABUJA     = '00000000-0000-0000-0000-000000447006';

describeDb('Migration 447: search_businesses_fuzzy', () => {
  beforeAll(() => {
    // ── Minimal schema ──
    sql(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
    `);

    sql(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_app_meta_data JSONB DEFAULT '{}'
      );
    `);

    // pg_trgm is required for similarity()
    sql(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // Minimal businesses table — CREATE TABLE IF NOT EXISTS for fresh DBs
    sql(`
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID,
        name VARCHAR(200) NOT NULL DEFAULT 'Test',
        slug VARCHAR(200),
        category VARCHAR(50) DEFAULT 'restaurant',
        city VARCHAR(50),
        state VARCHAR(100),
        country_code VARCHAR(2) DEFAULT 'NG',
        status VARCHAR(20) DEFAULT 'active',
        bot_code VARCHAR(30),
        discovery_enabled BOOLEAN DEFAULT true,
        messaging_suspended BOOLEAN NOT NULL DEFAULT false
      );
    `);

    // If the table already existed (CI template), ensure every column is present.
    // Types match the real production schema from migrations 001/002/003/079/239/363.
    sql(`
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS owner_id UUID;
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS name VARCHAR(200) NOT NULL DEFAULT 'Test';
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS slug VARCHAR(200);
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'restaurant';
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS city VARCHAR(50);
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS state VARCHAR(100);
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS country_code VARCHAR(2) DEFAULT 'NG';
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS bot_code VARCHAR(30);
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS discovery_enabled BOOLEAN DEFAULT true;
      ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS messaging_suspended BOOLEAN NOT NULL DEFAULT false;
    `);

    sql(`
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role;
      GRANT SELECT ON public.businesses TO authenticated;
      GRANT SELECT ON auth.users TO service_role;
    `);

    // ── Negative control: function must NOT exist before migration ──
    const preCheck = sql(`
      SELECT COUNT(*) FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'search_businesses_fuzzy';
    `);
    expect(preCheck).toBe('0');

    // Calling the function before migration must fail with "does not exist"
    const preCall = sql(`SELECT * FROM search_businesses_fuzzy('test', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(preCall).toMatch(/does not exist/i);

    // ── Apply migration 447 from disk ──
    const migrationSql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/447_directory_fuzzy_search.sql'),
      'utf-8',
    );
    const result = sql(migrationSql);
    if (result.includes('FAIL')) {
      throw new Error(`Migration 447 self-check failed: ${result}`);
    }

    // ── Seed test data (assert each INSERT succeeds) ──
    const seedUser = sql(`INSERT INTO auth.users (id) VALUES ('${OWNER_ID}') ON CONFLICT DO NOTHING;`);
    expect(seedUser).not.toContain('ERROR');

    const seedActive = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, state, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_ACTIVE}', '${OWNER_ID}', 'Fuzzy Salon Lagos', 'fuzzy-salon-447', 'salon', 'Lagos', 'Lagos', 'NG', 'active', 'FZSL', true, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy Salon Lagos', status = 'active', bot_code = 'FZSL', discovery_enabled = true, messaging_suspended = false;`);
    expect(seedActive).not.toContain('ERROR');

    const seedInactive = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_INACTIVE}', '${OWNER_ID}', 'Fuzzy Barber Inactive', 'fuzzy-barber-447', 'barber', 'Lagos', 'NG', 'pending', 'FZBI', true, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy Barber Inactive', status = 'pending';`);
    expect(seedInactive).not.toContain('ERROR');

    const seedNoBot = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_NO_BOT}', '${OWNER_ID}', 'Fuzzy NoBotCode', 'fuzzy-nobot-447', 'salon', 'Lagos', 'NG', 'active', NULL, true, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy NoBotCode', bot_code = NULL;`);
    expect(seedNoBot).not.toContain('ERROR');

    const seedOptOut = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_OPT_OUT}', '${OWNER_ID}', 'Fuzzy OptOut Salon', 'fuzzy-optout-447', 'salon', 'Lagos', 'NG', 'active', 'FZOO', false, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy OptOut Salon', discovery_enabled = false;`);
    expect(seedOptOut).not.toContain('ERROR');

    const seedHidden = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_HIDDEN}', '${OWNER_ID}', 'Fuzzy Hidden Biz', 'fuzzy-hidden-447', 'salon', 'Lagos', 'NG', 'active', 'FZHD', true, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy Hidden Biz', status = 'active', discovery_enabled = true;`);
    expect(seedHidden).not.toContain('ERROR');

    const seedAbuja = sql(`INSERT INTO businesses (id, owner_id, name, slug, category, city, state, country_code, status, bot_code, discovery_enabled, messaging_suspended)
         VALUES ('${BIZ_ABUJA}', '${OWNER_ID}', 'Fuzzy Salon Abuja', 'fuzzy-salon-abuja-447', 'salon', 'Abuja', 'FCT', 'NG', 'active', 'FZSA', true, false)
         ON CONFLICT (id) DO UPDATE SET name = 'Fuzzy Salon Abuja', city = 'Abuja', status = 'active', bot_code = 'FZSA', discovery_enabled = true;`);
    expect(seedAbuja).not.toContain('ERROR');
  });

  afterAll(() => {
    sql(`DELETE FROM businesses WHERE id IN ('${BIZ_ACTIVE}','${BIZ_INACTIVE}','${BIZ_NO_BOT}','${BIZ_OPT_OUT}','${BIZ_HIDDEN}','${BIZ_ABUJA}');`);
    sql(`DELETE FROM auth.users WHERE id = '${OWNER_ID}';`);
  });

  // ════════════════════════════════════════════════════════
  // A. Permission tests
  // ════════════════════════════════════════════════════════

  it('EXECUTE denied to authenticated role', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT current_user;
      SELECT * FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY[]::uuid[], NULL, NULL);
      ROLLBACK;
    `);
    expect(result).toContain('authenticated');
    expect(result).toMatch(/permission denied/i);
  });

  it('EXECUTE denied to anon role', () => {
    const result = sql(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT current_user;
      SELECT * FROM search_businesses_fuzzy('test', NULL, 10, ARRAY[]::uuid[], NULL, NULL);
      ROLLBACK;
    `);
    expect(result).toContain('anon');
    expect(result).toMatch(/permission denied/i);
  });

  // ════════════════════════════════════════════════════════
  // B. Eligibility filters
  // ════════════════════════════════════════════════════════

  it('returns eligible business by name similarity', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Salon Lagos', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    expect(result).toContain('Fuzzy Salon Lagos');
  });

  it('returns match_score as a numeric value (proves return structure)', () => {
    const result = sql(`SELECT name, match_score FROM search_businesses_fuzzy('Fuzzy Salon Lagos', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    expect(result).toContain('Fuzzy Salon Lagos');
    // match_score should be a number between 0 and 1 — psql outputs it as e.g. "0.65"
    const lines = result.split('\n');
    const scoreLine = lines.find(l => l.includes('Fuzzy Salon Lagos'));
    expect(scoreLine).toBeDefined();
    // psql -A uses | as delimiter, so: "Fuzzy Salon Lagos|0.65..."
    const score = parseFloat(scoreLine!.split('|').pop()!);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('excludes inactive businesses', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    // Positive control: an eligible business IS returned
    expect(result).toContain('Fuzzy Salon Lagos');
    // Negative: inactive business excluded
    expect(result).not.toContain('Fuzzy Barber Inactive');
  });

  it('excludes businesses with no bot_code', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    // Positive control: an eligible business IS returned
    expect(result).toContain('Fuzzy Salon Lagos');
    // Negative: no-bot-code business excluded
    expect(result).not.toContain('NoBotCode');
  });

  it('excludes discovery_enabled=false businesses', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    // Positive control: an eligible business IS returned
    expect(result).toContain('Fuzzy Salon Lagos');
    // Negative: opted-out business excluded
    expect(result).not.toContain('OptOut');
  });

  it('excludes hidden businesses via p_hidden_ids', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy', NULL, 10, ARRAY['${BIZ_HIDDEN}']::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    // Positive control: an eligible business IS returned
    expect(result).toContain('Fuzzy Salon Lagos');
    // Negative: hidden business excluded
    expect(result).not.toContain('Fuzzy Hidden');
  });

  it('respects country filter', () => {
    const result = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Salon Lagos', 'GH', 10, ARRAY[]::uuid[], NULL, NULL);`);
    expect(result).not.toContain('ERROR');
    // Wrong country returns nothing — no NG business in GH
    expect(result).not.toContain('Fuzzy Salon');
  });

  // ════════════════════════════════════════════════════════
  // C. Location scoping
  // ════════════════════════════════════════════════════════

  it('p_city filters to matching city only', () => {
    const lagosResult = sql(`SELECT name FROM search_businesses_fuzzy('Fuzzy Salon', NULL, 10, ARRAY[]::uuid[], 'Lagos', NULL);`);
    expect(lagosResult).not.toContain('ERROR');
    expect(lagosResult).toContain('Fuzzy Salon Lagos');
    expect(lagosResult).not.toContain('Fuzzy Salon Abuja');
  });
});
