/**
 * M445 — RLS boundary tests for bot translation override tables.
 *
 * Runs against a disposable PG in CI (P0 security ACL job).
 * The full migration set is already applied; we only seed fixture rows
 * and clean them up. We never DROP shared tables (businesses, auth.users).
 *
 * Each role switch uses BEGIN; SET LOCAL ROLE …; …; ROLLBACK so the
 * session role resets automatically, even on error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

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
        !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|NOTICE|BEGIN|ROLLBACK|COMMIT)\b/i.test(t)
      );
    })
    .join('\n')
    .trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 15_000,
    }).trim();
  } catch (e: any) {
    return (e.stderr || e.stdout || '').toString().trim();
  }
}

// Distinct fixture UUIDs — prefixed with 45 to avoid collision with other tests
const BIZ_A = '45aa0001-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = '45bb0001-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OWNER_A = '45cc0001-cccc-cccc-cccc-aaaaaaaaaaaa';
const OWNER_B = '45cc0001-cccc-cccc-cccc-bbbbbbbbbbbb';

describe.skipIf(!dbUrl)('M445: bot_translation_overrides RLS boundaries', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // 0. Ensure columns used by the test and migration 445 exist on the
    //    minimal CI template tables. These are idempotent ADD COLUMN IF NOT EXISTS.
    psql(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS country_code TEXT;
    `);

    // 1. Apply migration 445 from disk (idempotent — IF NOT EXISTS / ON CONFLICT)
    const migrationPath = join(__dirname, '../../supabase/migrations/445_bot_translation_overrides.sql');
    const migrationSql = readFileSync(migrationPath, 'utf-8');
    psql(migrationSql);

    // 2. Seed fixture users and businesses — assert each insert succeeds.
    const seedResult = psqlMayFail(`
      INSERT INTO auth.users (id) VALUES ('${OWNER_A}') ON CONFLICT DO NOTHING;
      INSERT INTO auth.users (id) VALUES ('${OWNER_B}') ON CONFLICT DO NOTHING;

      INSERT INTO businesses (id, owner_id, name, slug, category, country_code, status)
        VALUES ('${BIZ_A}', '${OWNER_A}', 'RLS Test A', 'rls-test-a', 'shop', 'NG', 'active')
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO businesses (id, owner_id, name, slug, category, country_code, status)
        VALUES ('${BIZ_B}', '${OWNER_B}', 'RLS Test B', 'rls-test-b', 'shop', 'NG', 'active')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('en', 'rls_test_plat', 'Hello!')
        ON CONFLICT (lang, key) DO NOTHING;

      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'en', 'rls_test_biz', 'Welcome to A!')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_B}', 'en', 'rls_test_biz', 'Welcome to B!')
        ON CONFLICT (business_id, lang, key) DO NOTHING;

      SELECT 'seed_ok';
    `);
    // Assert no ERROR in seed output
    expect(seedResult).not.toMatch(/ERROR/i);
    expect(seedResult).toContain('seed_ok');
  });

  afterAll(() => {
    if (!dbUrl) return;
    // Clean up only our fixture rows — never DROP shared tables
    psql(`
      DELETE FROM bot_translation_overrides WHERE key = 'rls_test_biz';
      DELETE FROM bot_translation_platform_overrides WHERE key IN ('rls_test_plat', 'rls_sr_test');
      DELETE FROM businesses WHERE id IN ('${BIZ_A}', '${BIZ_B}');
      DELETE FROM auth.users WHERE id IN ('${OWNER_A}', '${OWNER_B}');
    `);
  });

  // ── 1. anon cannot SELECT ─────────────────────────────────────

  it('1a. anon cannot SELECT from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT COUNT(*) FROM bot_translation_platform_overrides;
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_platform_overrides/i);
  });

  it('1b. anon cannot SELECT from bot_translation_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT COUNT(*) FROM bot_translation_overrides;
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_overrides/i);
  });

  // ── 2. authenticated cannot INSERT ────────────────────────────

  it('2a. authenticated cannot INSERT into bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('en', 'rls_hack', 'nope');
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_platform_overrides/i);
  });

  it('2b. authenticated cannot INSERT into bot_translation_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'en', 'rls_hack', 'nope');
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_overrides/i);
  });

  // ── 3. authenticated cannot UPDATE ────────────────────────────

  it('3a. authenticated cannot UPDATE bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      UPDATE bot_translation_platform_overrides SET value = 'hacked' WHERE key = 'rls_test_plat';
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_platform_overrides/i);
  });

  it('3b. authenticated cannot UPDATE bot_translation_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      UPDATE bot_translation_overrides SET value = 'hacked' WHERE business_id = '${BIZ_A}';
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_overrides/i);
  });

  // ── 4. authenticated cannot DELETE ────────────────────────────

  it('4a. authenticated cannot DELETE from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      DELETE FROM bot_translation_platform_overrides WHERE key = 'rls_test_plat';
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_platform_overrides/i);
  });

  it('4b. authenticated cannot DELETE from bot_translation_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      DELETE FROM bot_translation_overrides WHERE business_id = '${BIZ_A}';
      ROLLBACK;
    `);
    expect(result).toMatch(/permission denied for table bot_translation_overrides/i);
  });

  // ── 5. Owner can SELECT own rows ──────────────────────────────

  it('5. owner can SELECT their own business rows from bot_translation_overrides', () => {
    const count = psql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      SELECT COUNT(*) FROM bot_translation_overrides WHERE business_id = '${BIZ_A}';
      ROLLBACK;
    `);
    expect(count).toBe('1');
  });

  // ── 6. Owner cannot SELECT other business rows ────────────────

  it('6. owner cannot SELECT another business rows from bot_translation_overrides', () => {
    const count = psql(`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OWNER_A}';
      SELECT COUNT(*) FROM bot_translation_overrides WHERE business_id = '${BIZ_B}';
      ROLLBACK;
    `);
    expect(count).toBe('0');
  });

  // ── 7. service_role full access ───────────────────────────────

  it('7a. service_role can SELECT from bot_translation_platform_overrides', () => {
    const count = psql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT COUNT(*) FROM bot_translation_platform_overrides WHERE key = 'rls_test_plat';
      ROLLBACK;
    `);
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  it('7b. service_role can INSERT into bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO bot_translation_platform_overrides (lang, key, value)
        VALUES ('fr', 'rls_sr_test', 'Bonjour')
        ON CONFLICT (lang, key) DO NOTHING;
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
  });

  it('7c. service_role can UPDATE bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE bot_translation_platform_overrides SET value = 'Bonjour!' WHERE lang = 'fr' AND key = 'rls_sr_test';
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
  });

  it('7d. service_role can DELETE from bot_translation_platform_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      DELETE FROM bot_translation_platform_overrides WHERE lang = 'fr' AND key = 'rls_sr_test';
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
  });

  it('7e. service_role can SELECT from bot_translation_overrides', () => {
    const count = psql(`
      BEGIN;
      SET LOCAL ROLE service_role;
      SELECT COUNT(*) FROM bot_translation_overrides WHERE key = 'rls_test_biz';
      ROLLBACK;
    `);
    expect(Number(count)).toBeGreaterThanOrEqual(2);
  });

  it('7f. service_role can INSERT into bot_translation_overrides', () => {
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'yo', 'rls_sr_test', 'Kaabo')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
    // Clean up
    psql(`DELETE FROM bot_translation_overrides WHERE key = 'rls_sr_test';`);
  });

  it('7g. service_role can UPDATE bot_translation_overrides', () => {
    // Insert first, then update
    psql(`
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'yo', 'rls_sr_upd', 'Before')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
    `);
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      UPDATE bot_translation_overrides SET value = 'After' WHERE business_id = '${BIZ_A}' AND key = 'rls_sr_upd';
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
    psql(`DELETE FROM bot_translation_overrides WHERE key = 'rls_sr_upd';`);
  });

  it('7h. service_role can DELETE from bot_translation_overrides', () => {
    psql(`
      INSERT INTO bot_translation_overrides (business_id, lang, key, value)
        VALUES ('${BIZ_A}', 'yo', 'rls_sr_del', 'ToDelete')
        ON CONFLICT (business_id, lang, key) DO NOTHING;
    `);
    const result = psqlMayFail(`
      BEGIN;
      SET LOCAL ROLE service_role;
      DELETE FROM bot_translation_overrides WHERE business_id = '${BIZ_A}' AND key = 'rls_sr_del';
      SELECT 'ok';
      COMMIT;
    `);
    expect(result).not.toMatch(/ERROR/i);
    expect(result).toContain('ok');
  });

  // ── Structural ────────────────────────────────────────────────

  it('RLS is enabled on bot_translation_platform_overrides', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'bot_translation_platform_overrides';`);
    expect(enabled).toBe('t');
  });

  it('RLS is enabled on bot_translation_overrides', () => {
    const enabled = psql(`SELECT rowsecurity FROM pg_tables WHERE tablename = 'bot_translation_overrides';`);
    expect(enabled).toBe('t');
  });
});
