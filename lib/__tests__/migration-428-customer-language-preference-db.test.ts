/**
 * Issue #524 / M428 — durable customer response-language preference.
 *
 * The source-contract checks run in the normal unit suite. Real PostgreSQL
 * proofs are intentionally opt-in because they replay M428 against a fully
 * migrated disposable database.
 *
 * RUN_DEPENDENCY_TESTS=1 \
 * TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *   npx vitest run lib/__tests__/migration-428-customer-language-preference-db.test.ts
 */
import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const migrationPath = resolve(
  'supabase/migrations/428_customer_preferred_response_language.sql',
);
const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = process.env.RUN_DEPENDENCY_TESTS === '1' && dbUrl.length > 0;

function psql(statement: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: statement,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

function psqlMayFail(statement: string): { ok: boolean; output: string } {
  try {
    return { ok: true, output: psql(statement) };
  } catch (error: unknown) {
    const failure = error as { stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      output: String(failure.stderr || failure.message || error),
    };
  }
}

function replayMigration(): void {
  execFileSync(
    'psql',
    [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath],
    { encoding: 'utf8', timeout: 30_000 },
  );
}

describe('M428 migration source contract', () => {
  it('exists at the canonical migration path', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('is additive, nullable, constrained, and preserves the M353 client ACL boundary', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const source = readFileSync(migrationPath, 'utf8');

    expect(source).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+preferred_response_language\b/i);
    expect(source).toMatch(/CHECK\s*\([^;]*preferred_response_language\s+IN\s*\(\s*'en'\s*,\s*'pcm'\s*,\s*'yo'\s*,\s*'ig'\s*,\s*'ha'\s*,\s*'tw'\s*,\s*'fr'\s*,\s*'es'\s*\)/i);
    expect(source).not.toMatch(/preferred_response_language[^;]*\bNOT\s+NULL\b/i);
    expect(source).not.toMatch(/preferred_response_language[^;]*\bDEFAULT\b/i);
    expect(source).not.toMatch(/UPDATE\s+(?:public\.)?profiles\s+SET\s+preferred_response_language\b/i);
    expect(source).toMatch(/REVOKE\s+UPDATE\s*\(\s*preferred_response_language\s*\)[^;]*FROM\s+(?:PUBLIC|authenticated|anon)/i);
    expect(source).toMatch(/GRANT\s+ALL[^;]*ON\s+TABLE\s+(?:public\.)?profiles\s+TO\s+service_role/i);
  });
});

describe.skipIf(!canRunDb)('M428 preferred response language (real PostgreSQL)', () => {
  const ownUser = '52400000-0000-4000-8000-000000000001';
  const otherUser = '52400000-0000-4000-8000-000000000002';

  beforeAll(() => {
    // M428 must be safe to replay during convergent environment repair.
    replayMigration();
    replayMigration();
  });

  it('defines a nullable column with no default and no backfill', () => {
    expect(psql(`
      SELECT is_nullable || '|' || COALESCE(column_default, '<null>')
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'profiles'
        AND column_name = 'preferred_response_language'
    `)).toBe('YES|<null>');

    expect(psql(`
      BEGIN;
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${ownUser}', 'm428-own@example.test', '{}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
      UPDATE public.profiles
      SET preferred_response_language = NULL
      WHERE id = '${ownUser}';
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${otherUser}', 'm428-other@example.test', '{}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
      SELECT preferred_response_language IS NULL
      FROM public.profiles WHERE id = '${otherUser}';
      ROLLBACK;
    `).split('\n').pop()).toBe('t');
  });

  it.each(['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es'])(
    'service_role can persist supported language %s',
    language => {
      expect(psql(`
        BEGIN;
        INSERT INTO auth.users (id, email, raw_app_meta_data)
        VALUES ('${ownUser}', 'm428-own@example.test', '{}')
        ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
        SET LOCAL ROLE service_role;
        UPDATE public.profiles
        SET preferred_response_language = '${language}'
        WHERE id = '${ownUser}';
        SELECT preferred_response_language
        FROM public.profiles WHERE id = '${ownUser}';
        ROLLBACK;
      `).split('\n').pop()).toBe(language);
    },
  );

  it('rejects unsupported language values', () => {
    const result = psqlMayFail(`
      BEGIN;
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${ownUser}', 'm428-own@example.test', '{}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
      SET LOCAL ROLE service_role;
      UPDATE public.profiles SET preferred_response_language = 'de'
      WHERE id = '${ownUser}';
      ROLLBACK;
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/check constraint|violates check/i);
  });

  it('allows service_role but denies authenticated and anon column UPDATE privilege', () => {
    expect(psql(`
      SELECT
        has_column_privilege('service_role', 'public.profiles', 'preferred_response_language', 'UPDATE'),
        has_column_privilege('authenticated', 'public.profiles', 'preferred_response_language', 'UPDATE'),
        has_column_privilege('anon', 'public.profiles', 'preferred_response_language', 'UPDATE')
    `)).toBe('t|f|f');
  });

  it.each(['authenticated', 'anon'])('%s cannot update the preference at runtime', role => {
    const result = psqlMayFail(`
      BEGIN;
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${ownUser}', 'm428-own@example.test', '{}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
      SELECT set_config('request.jwt.claim.sub', '${ownUser}', true);
      SELECT set_config('request.jwt.claims', '{"sub":"${ownUser}","role":"${role}"}', true);
      SET LOCAL ROLE ${role};
      UPDATE public.profiles SET preferred_response_language = 'yo'
      WHERE id = '${ownUser}';
      ROLLBACK;
    `);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/permission denied/i);
  });

  it('authenticated can read its own preference while RLS hides another profile', () => {
    expect(psql(`
      BEGIN;
      INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
        ('${ownUser}', 'm428-own@example.test', '{}'),
        ('${otherUser}', 'm428-other@example.test', '{}')
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
      UPDATE public.profiles SET preferred_response_language = 'ig' WHERE id = '${ownUser}';
      UPDATE public.profiles SET preferred_response_language = 'ha' WHERE id = '${otherUser}';
      SELECT set_config('request.jwt.claim.sub', '${ownUser}', true);
      SELECT set_config('request.jwt.claims', '{"sub":"${ownUser}","role":"authenticated"}', true);
      SET LOCAL ROLE authenticated;
      SELECT
        COUNT(*) FILTER (WHERE id = '${ownUser}') || '|' ||
        COUNT(*) FILTER (WHERE id = '${otherUser}') || '|' ||
        COALESCE(MAX(preferred_response_language) FILTER (WHERE id = '${ownUser}'), '<null>')
      FROM public.profiles
      WHERE id IN ('${ownUser}', '${otherUser}');
      ROLLBACK;
    `).split('\n').pop()).toBe('1|0|ig');
  });
});
