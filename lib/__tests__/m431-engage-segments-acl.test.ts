/**
 * M431 + M432 — engage_segments privilege contract tests
 *
 * Section 1: Static migration SQL analysis (always runs in CI)
 *   - M432 contains correct GRANT/REVOKE
 *   - M431 creates table with RLS, has NO grant (the gap M432 fixes)
 *   - M432 verification block checks all 4 ops × 3 roles + RLS
 *
 * Section 2: Real PostgreSQL role CRUD + denial tests (requires TEST_DATABASE_URL)
 *   - Applies M431 + M432 to a disposable test schema
 *   - service_role: full CREATE → READ → UPDATE → DELETE cycle with valid FK fixtures
 *   - anon: SELECT/INSERT produce "permission denied" (not empty result)
 *   - authenticated: SELECT/INSERT produce "permission denied"
 *   - PUBLIC: no effective privilege via aclexplode grantee=0
 *   - RLS enabled catalog assertion
 *
 *   SAFETY: Tests refuse to run unless TEST_DATABASE_URL contains a known
 *   disposable marker. This prevents accidental execution against staging
 *   or production databases.
 *
 * Section 3: API route authorization contract (always runs in CI)
 *   - Routes use createServiceClient for direct table access
 *   - Routes enforce auth + capability + business ownership scoping
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

// ══════════════════════════════════════════════════════════
// Section 1: Static migration SQL analysis (always runs)
// ══════════════════════════════════════════════════════════

describe('M432 migration SQL analysis', () => {
  const m432Sql = readFileSync(join(MIGRATIONS_DIR, '432_engage_segments_acl.sql'), 'utf8');
  const m431Sql = readFileSync(join(MIGRATIONS_DIR, '431_engage_segments.sql'), 'utf8');

  it('M432 grants service_role SELECT, INSERT, UPDATE, DELETE', () => {
    expect(m432Sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.engage_segments TO service_role');
  });

  it('M432 revokes all from anon and authenticated', () => {
    expect(m432Sql).toContain('REVOKE ALL ON TABLE public.engage_segments FROM anon, authenticated');
  });

  it('M432 verification checks service_role all 4 ops', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(m432Sql).toContain(`has_table_privilege('service_role', 'public.engage_segments', '${op}')`);
    }
  });

  it('M432 verification denies anon all 4 ops', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(m432Sql).toContain(`has_table_privilege('anon', 'public.engage_segments', '${op}')`);
    }
  });

  it('M432 verification denies authenticated all 4 ops', () => {
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(m432Sql).toContain(`has_table_privilege('authenticated', 'public.engage_segments', '${op}')`);
    }
  });

  it('M432 verification checks RLS enabled', () => {
    expect(m432Sql).toContain("rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'engage_segments'");
  });

  it('M431 creates table with RLS enabled', () => {
    expect(m431Sql).toContain('CREATE TABLE public.engage_segments');
    expect(m431Sql).toContain('ALTER TABLE public.engage_segments ENABLE ROW LEVEL SECURITY');
  });

  it('M431 creates owner defense policy', () => {
    expect(m431Sql).toContain('CREATE POLICY engage_segments_owner_defense');
    expect(m431Sql).toContain('owner_id = auth.uid()');
  });

  it('M431 has NO GRANT statement (the gap M432 fixes)', () => {
    expect(m431Sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('M432 does not grant to PUBLIC', () => {
    expect(m432Sql).not.toMatch(/GRANT.*TO\s+PUBLIC/i);
  });

  it('M432 does not grant TRUNCATE or REFERENCES', () => {
    expect(m432Sql).not.toMatch(/GRANT.*TRUNCATE/i);
    expect(m432Sql).not.toMatch(/GRANT.*REFERENCES/i);
  });
});

// ══════════════════════════════════════════════════════════
// Section 2: Real PostgreSQL role CRUD + denial tests
// ══════════════════════════════════════════════════════════

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// SAFETY GUARD: Only run against explicitly disposable databases.
// Prevents accidental execution against staging/production.
const DISPOSABLE_MARKERS = ['localhost', '127.0.0.1', 'supabase_test', 'db.localhost', 'pooler.supabase.com:6543'];
const isDisposableDb = TEST_DB_URL
  ? DISPOSABLE_MARKERS.some(m => TEST_DB_URL.includes(m)) || TEST_DB_URL.includes('TEST_SAFE=true')
  : false;

const canRunDbTests = !!TEST_DB_URL && isDisposableDb;
const skipReason = !TEST_DB_URL
  ? 'TEST_DATABASE_URL not set'
  : !isDisposableDb
    ? 'TEST_DATABASE_URL does not contain a disposable marker — refusing to run destructive tests'
    : '';

describe.skipIf(!canRunDbTests)(`M431+M432 real PostgreSQL role tests${skipReason ? ` (skipped: ${skipReason})` : ''}`, () => {
  let pg: { Client: new (opts: { connectionString: string }) => PgClient };
  let client: PgClient;

  const TEST_BIZ_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TEST_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let insertedSegmentId: string | null = null;

  beforeAll(async () => {
    pg = await import('pg');
    client = new pg.Client({ connectionString: TEST_DB_URL! });
    await client.connect();

    // Verify connection is to a disposable database (double-check)
    const versionResult = await client.query('SELECT current_database() as db');
    const dbName = String(versionResult.rows[0].db);
    if (dbName === 'postgres' && !TEST_DB_URL!.includes('localhost') && !TEST_DB_URL!.includes('127.0.0.1')) {
      await client.end();
      throw new Error(`Refusing to run destructive tests against database "${dbName}" — does not appear disposable`);
    }

    // Create FK fixture targets
    await client.query(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              'm432-test@test.local', crypt('test', gen_salt('bf')), now(), now())
      ON CONFLICT (id) DO NOTHING
    `, [TEST_USER_ID]);

    await client.query(`
      INSERT INTO public.businesses (id, owner_id, name, slug, category, flow_type, country_code, status)
      VALUES ($1, $2, 'M432 Test Biz', 'm432-test-biz', 'shop', 'ordering', 'US', 'pending')
      ON CONFLICT (id) DO NOTHING
    `, [TEST_BIZ_ID, TEST_USER_ID]);

    // Apply M431 (table) + M432 (ACL) — fresh application
    await client.query('DROP TABLE IF EXISTS public.engage_segments CASCADE');
    const m431Sql = readFileSync(join(MIGRATIONS_DIR, '431_engage_segments.sql'), 'utf8');
    const m432Sql = readFileSync(join(MIGRATIONS_DIR, '432_engage_segments_acl.sql'), 'utf8');
    await client.query(m431Sql);
    await client.query(m432Sql);
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.query('RESET ROLE'); // Ensure we're back to superuser
        await client.query('DROP TABLE IF EXISTS public.engage_segments CASCADE');
        await client.query('DELETE FROM public.businesses WHERE id = $1', [TEST_BIZ_ID]);
        await client.query('DELETE FROM auth.users WHERE id = $1', [TEST_USER_ID]);
      } finally {
        await client.end();
      }
    }
  });

  // ── service_role full CRUD cycle ──

  it('service_role can INSERT with valid FK fixtures', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(`
      INSERT INTO public.engage_segments (business_id, name, expression, created_by)
      VALUES ($1, 'Test Segment', '{"type": "all"}', $2)
      RETURNING id
    `, [TEST_BIZ_ID, TEST_USER_ID]);
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    insertedSegmentId = result.rows[0].id as string;
  });

  it('service_role can SELECT the inserted row', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'SELECT id, name, business_id FROM public.engage_segments WHERE id = $1',
      [insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Test Segment');
  });

  it('service_role can UPDATE the inserted row', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'UPDATE public.engage_segments SET name = $1 WHERE id = $2 RETURNING name',
      ['Updated Segment', insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows[0].name).toBe('Updated Segment');
  });

  it('service_role can DELETE the inserted row', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'DELETE FROM public.engage_segments WHERE id = $1 RETURNING id',
      [insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    insertedSegmentId = null;
  });

  // ── anon denial (permission denied, NOT empty result) ──

  it('anon SELECT is denied with permission error', async () => {
    await client.query('SET ROLE anon');
    await expect(
      client.query('SELECT * FROM public.engage_segments LIMIT 1'),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  it('anon INSERT is denied with permission error', async () => {
    await client.query('SET ROLE anon');
    await expect(
      client.query(`INSERT INTO public.engage_segments (business_id, name, expression, created_by)
        VALUES ($1, 'anon-test', '{}', $2)`, [TEST_BIZ_ID, TEST_USER_ID]),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  // ── authenticated denial (permission denied, NOT RLS-filtered empty) ──

  it('authenticated SELECT is denied with permission error', async () => {
    await client.query('SET ROLE authenticated');
    await expect(
      client.query('SELECT * FROM public.engage_segments LIMIT 1'),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  it('authenticated INSERT is denied with permission error', async () => {
    await client.query('SET ROLE authenticated');
    await expect(
      client.query(`INSERT INTO public.engage_segments (business_id, name, expression, created_by)
        VALUES ($1, 'auth-test', '{}', $2)`, [TEST_BIZ_ID, TEST_USER_ID]),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  // ── Catalog assertions ──

  it('RLS is enabled on engage_segments', async () => {
    const result = await client.query(
      "SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'engage_segments'",
    );
    expect(result.rows[0].rowsecurity).toBe(true);
  });

  it('no PUBLIC (grantee=0) privilege exists on engage_segments', async () => {
    // Use aclexplode to correctly identify PUBLIC grants (grantee OID = 0)
    const result = await client.query(`
      SELECT count(*) as public_grants
      FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relname = 'engage_segments'
        AND c.relnamespace = 'public'::regnamespace
        AND a.grantee = 0
    `);
    expect(Number(result.rows[0].public_grants)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// Section 3: API route authorization contract (always runs)
// ══════════════════════════════════════════════════════════

describe('Engage segments API authorization contract', () => {
  const listRoute = readFileSync(join(process.cwd(), 'app/api/engage/segments/route.ts'), 'utf8');
  const detailRoute = readFileSync(join(process.cwd(), 'app/api/engage/segments/[id]/route.ts'), 'utf8');

  it('list route uses createServiceClient for table access', () => {
    expect(listRoute).toContain('createServiceClient');
    expect(listRoute).toContain("from('engage_segments')");
  });

  it('list route requires authentication via createClient', () => {
    expect(listRoute).toContain('createClient');
    expect(listRoute).toContain('auth.getUser');
  });

  it('list route scopes queries by business_id', () => {
    expect(listRoute).toContain("eq('business_id'");
  });

  it('detail route uses createServiceClient', () => {
    expect(detailRoute).toContain('createServiceClient');
    expect(detailRoute).toContain("from('engage_segments')");
  });

  it('detail route requires authentication', () => {
    expect(detailRoute).toContain('createClient');
    expect(detailRoute).toContain('auth.getUser');
  });

  it('detail route scopes by business_id', () => {
    expect(detailRoute).toContain("eq('business_id'");
  });
});
