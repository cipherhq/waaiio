/**
 * M445 — RLS boundary tests for bot translation override tables.
 *
 * Verifies Row-Level Security on both tables created by migration 445:
 *   - bot_translation_platform_overrides (admin/service-role only)
 *   - bot_translation_overrides          (per-business, owner-read only)
 *
 * Assertions:
 *   1. anon cannot SELECT from either table
 *   2. authenticated cannot INSERT into either table
 *   3. authenticated cannot UPDATE either table
 *   4. authenticated cannot DELETE from either table
 *   5. owner can SELECT their own business rows from bot_translation_overrides
 *   6. owner cannot SELECT another business's rows from bot_translation_overrides
 *   7. service_role has full SELECT, INSERT, UPDATE, DELETE on both tables
 *
 * Requires TEST_DATABASE_URL (CI shard b).
 *
 * Local:
 *   docker run --rm -d --name waaiio-translation-pg -p 54320:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54320/postgres \
 *     npx vitest run lib/__tests__/translation-rls.pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return raw
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return (
        t !== '' &&
        !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT)\b/.test(t)
      );
    })
    .join('\n')
    .trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 15_000,
    }).trim();
  } catch (e: any) {
    return (e.stderr || e.stdout || '').toString().trim();
  }
}

// Deterministic UUIDs for test isolation
const BIZ_A = '45aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = '45bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER_A = '45cccccc-cccc-cccc-cccc-aaaaaaaaaaaa';
const OWNER_B = '45cccccc-cccc-cccc-cccc-bbbbbbbbbbbb';

describe.skipIf(!dbUrl)('M445: bot_translation_overrides RLS boundaries', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Create roles, auth schema, helper function, and minimal tables.
    // In CI these already exist (full migration set applied); CREATE IF NOT EXISTS
    // and DO $$ EXCEPTION WHEN duplicate_object $$ keep it idempotent.
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
        LANGUAGE sql STABLE
        AS $fn$ SELECT current_setting('app.current_user_id', true)::UUID; $fn$;

      -- Seed auth.users for FK constraints in CI (full schema has businesses.owner_id → auth.users.id)
      INSERT INTO auth.users (id) VALUES ('${OWNER_A}') ON CONFLICT DO NOTHING;
      INSERT INTO auth.users (id) VALUES ('${OWNER_B}') ON CONFLICT DO NOTHING;

      -- Minimal businesses table (in CI the full table exists; IF NOT EXISTS keeps it safe)
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY, owner_id UUID, name TEXT NOT NULL DEFAULT 'test');
      INSERT INTO businesses (id, owner_id, name) VALUES ('${BIZ_A}', '${OWNER_A}', 'Biz A') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, owner_id, name) VALUES ('${BIZ_B}', '${OWNER_B}', 'Biz B') ON CONFLICT DO NOTHING;

      -- ===== bot_translation_platform_overrides =====
      CREATE TABLE IF NOT EXISTS bot_translation_platform_overrides (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        lang       TEXT        NOT NULL
          CHECK (lang IN ('en','pcm','yo','ig','ha','tw','fr','es')),
        key        TEXT        NOT NULL,
        value      TEXT        NOT NULL
          CHECK (char_length(trim(value)) > 0)
          CHECK (char_length(value) <= 4096),
        updated_by UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (lang, key)
      );
      ALTER TABLE bot_translation_platform_overrides ENABLE ROW LEVEL SECURITY;

      -- ===== bot_translation_overrides =====
      CREATE TABLE IF NOT EXISTS bot_translation_overrides (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID        NOT NULL,
        lang        TEXT        NOT NULL
          CHECK (lang IN ('en','pcm','yo','ig','ha','tw','fr','es')),
        key         TEXT        NOT NULL,
        value       TEXT        NOT NULL
          CHECK (char_length(trim(value)) > 0)
          CHECK (char_length(value) <= 4096),
        updated_by  UUID,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (business_id, lang, key)
      );
      ALTER TABLE bot_translation_overrides ENABLE ROW LEVEL SECURITY;

      -- GRANTs (match migration 445 exactly)
      REVOKE ALL ON bot_translation_platform_overrides FROM PUBLIC, anon, authenticated;
      REVOKE ALL ON bot_translation_overrides           FROM PUBLIC, anon, authenticated;

      GRANT SELECT, INSERT, UPDATE, DELETE ON bot_translation_platform_overrides TO service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON bot_translation_overrides           TO service_role;

      GRANT SELECT ON bot_translation_overrides TO authenticated;

      -- RLS policy: owner can read their own business rows
      DROP POLICY IF EXISTS owners_read ON bot_translation_overrides;
      CREATE POLICY owners_read
        ON bot_translation_overrides
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM businesses b
            WHERE b.id = bot_translation_overrides.business_id
              AND b.owner_id = auth.uid()
          )
        );

      -- Seed data
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('en', 'greeting', 'Hello!')
        ON CONFLICT (lang, key) DO NOTHING;
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('yo', 'greeting', 'Bawo ni!')
        ON CONFLICT (lang, key) DO NOTHING;

      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'en', 'welcome', 'Welcome to A!')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_B}', 'en', 'welcome', 'Welcome to B!')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DROP TABLE IF EXISTS bot_translation_overrides CASCADE;
      DROP TABLE IF EXISTS bot_translation_platform_overrides CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
    `);
  });

  // ---------------------------------------------------------------
  // 1. anon cannot SELECT from either table
  // ---------------------------------------------------------------

  it('1a. anon cannot SELECT from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE anon;
      SELECT COUNT(*) FROM bot_translation_platform_overrides;
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  it('1b. anon cannot SELECT from bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE anon;
      SELECT COUNT(*) FROM bot_translation_overrides;
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  // ---------------------------------------------------------------
  // 2. authenticated cannot INSERT into either table
  // ---------------------------------------------------------------

  it('2a. authenticated cannot INSERT into bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('en', 'test_insert', 'should fail');
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  it('2b. authenticated cannot INSERT into bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'en', 'test_insert', 'should fail');
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  // ---------------------------------------------------------------
  // 3. authenticated cannot UPDATE either table
  // ---------------------------------------------------------------

  it('3a. authenticated cannot UPDATE bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      UPDATE bot_translation_platform_overrides SET value = 'hacked' WHERE lang = 'en';
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  it('3b. authenticated cannot UPDATE bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      UPDATE bot_translation_overrides SET value = 'hacked' WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  // ---------------------------------------------------------------
  // 4. authenticated cannot DELETE from either table
  // ---------------------------------------------------------------

  it('4a. authenticated cannot DELETE from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      DELETE FROM bot_translation_platform_overrides WHERE lang = 'en';
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  it('4b. authenticated cannot DELETE from bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      DELETE FROM bot_translation_overrides WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    expect(result).toMatch(/permission denied/i);
  });

  // ---------------------------------------------------------------
  // 5. Owner can SELECT their own business rows
  // ---------------------------------------------------------------

  it('5. owner can SELECT their own business rows from bot_translation_overrides', () => {
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      SELECT COUNT(*) FROM bot_translation_overrides WHERE business_id = '${BIZ_A}';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('1');
  });

  // ---------------------------------------------------------------
  // 6. Owner cannot SELECT another business's rows
  // ---------------------------------------------------------------

  it('6. owner cannot SELECT another business rows from bot_translation_overrides', () => {
    const count = psql(`
      SET ROLE authenticated;
      SET app.current_user_id = '${OWNER_A}';
      SELECT COUNT(*) FROM bot_translation_overrides WHERE business_id = '${BIZ_B}';
    `);
    psql(`RESET ROLE;`);
    expect(count).toBe('0');
  });

  // ---------------------------------------------------------------
  // 7. service_role has full access to both tables
  // ---------------------------------------------------------------

  it('7a. service_role can SELECT from bot_translation_platform_overrides', () => {
    const count = psql(`
      SET ROLE service_role;
      SELECT COUNT(*) FROM bot_translation_platform_overrides;
    `);
    psql(`RESET ROLE;`);
    expect(Number(count)).toBeGreaterThanOrEqual(2);
  });

  it('7b. service_role can INSERT into bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('fr', 'sr_test', 'Bonjour')
        ON CONFLICT (lang, key) DO NOTHING;
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('7c. service_role can UPDATE bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      UPDATE bot_translation_platform_overrides SET value = 'Bonjour!' WHERE lang = 'fr' AND key = 'sr_test';
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('7d. service_role can DELETE from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM bot_translation_platform_overrides WHERE lang = 'fr' AND key = 'sr_test';
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('7e. service_role can SELECT from bot_translation_overrides', () => {
    const count = psql(`
      SET ROLE service_role;
      SELECT COUNT(*) FROM bot_translation_overrides;
    `);
    psql(`RESET ROLE;`);
    expect(Number(count)).toBeGreaterThanOrEqual(2);
  });

  it('7f. service_role can INSERT into bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'yo', 'sr_test', 'Kaabo')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('7g. service_role can UPDATE bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      UPDATE bot_translation_overrides SET value = 'Kaabo!' WHERE business_id = '${BIZ_A}' AND lang = 'yo' AND key = 'sr_test';
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  it('7h. service_role can DELETE from bot_translation_overrides', () => {
    const result = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM bot_translation_overrides WHERE business_id = '${BIZ_A}' AND lang = 'yo' AND key = 'sr_test';
      SELECT 'ok';
    `);
    psql(`RESET ROLE;`);
    expect(result).toContain('ok');
  });

  // ---------------------------------------------------------------
  // Structural: RLS is enabled on both tables
  // ---------------------------------------------------------------

  it('RLS is enabled on bot_translation_platform_overrides', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'bot_translation_platform_overrides';`);
    expect(enabled).toBe('t');
  });

  it('RLS is enabled on bot_translation_overrides', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'bot_translation_overrides';`);
    expect(enabled).toBe('t');
  });
});
