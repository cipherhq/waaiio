/**
 * M431 + M432 — engage_segments privilege contract tests
 *
 * Section 1: Static migration analysis (always runs)
 *   - M432 contains correct GRANT/REVOKE statements
 *   - M431 creates table with RLS
 *   - M432 verification block checks all 4 ops for all 3 roles
 *
 * Section 2: Real PostgreSQL CRUD + role denial tests (requires TEST_DATABASE_URL)
 *   - Creates engage_segments table (M431) + applies ACL (M432)
 *   - service_role: full CRUD cycle with valid fixture FKs
 *   - anon: SELECT denied (permission denied, not empty result)
 *   - authenticated: SELECT denied (permission denied)
 *   - Cleanup: drops table after tests
 *
 * Section 3: API route authorization contract (always runs)
 *   - Routes use createServiceClient for direct table access
 *   - Routes enforce auth + capability + business ownership
 *   - Cross-tenant queries scoped by business_id
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

// ══════════════════════════════════════════════════════════
// Section 1: Static migration analysis
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

  it('M432 verification checks service_role SELECT', () => {
    expect(m432Sql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'SELECT')");
  });

  it('M432 verification checks service_role INSERT', () => {
    expect(m432Sql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'INSERT')");
  });

  it('M432 verification checks service_role UPDATE', () => {
    expect(m432Sql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'UPDATE')");
  });

  it('M432 verification checks service_role DELETE', () => {
    expect(m432Sql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'DELETE')");
  });

  it('M432 verification denies anon all 4 ops', () => {
    expect(m432Sql).toContain("has_table_privilege('anon', 'public.engage_segments', 'SELECT')");
    expect(m432Sql).toContain("has_table_privilege('anon', 'public.engage_segments', 'INSERT')");
    expect(m432Sql).toContain("has_table_privilege('anon', 'public.engage_segments', 'UPDATE')");
    expect(m432Sql).toContain("has_table_privilege('anon', 'public.engage_segments', 'DELETE')");
  });

  it('M432 verification denies authenticated all 4 ops', () => {
    expect(m432Sql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'SELECT')");
    expect(m432Sql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'INSERT')");
    expect(m432Sql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'UPDATE')");
    expect(m432Sql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'DELETE')");
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

  it('M431 does NOT contain any GRANT statement (gap that M432 fixes)', () => {
    expect(m431Sql).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('M432 does not grant to PUBLIC', () => {
    expect(m432Sql).not.toMatch(/GRANT.*TO\s+PUBLIC/i);
  });

  it('M432 does not grant TRUNCATE or REFERENCES', () => {
    expect(m432Sql).not.toContain('TRUNCATE');
    expect(m432Sql).not.toMatch(/GRANT.*REFERENCES/i);
  });
});

// ══════════════════════════════════════════════════════════
// Section 2: Real PostgreSQL CRUD + role denial tests
// ══════════════════════════════════════════════════════════

interface PgClient { connect(): Promise<void>; query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; end(): Promise<void>; }

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const hasTestDb = !!TEST_DB_URL;

describe.skipIf(!hasTestDb)('M431+M432 real PostgreSQL role tests', () => {
  let pg: { Client: new (opts: { connectionString: string }) => PgClient };
  let client: PgClient;

  const TEST_BIZ_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TEST_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let insertedSegmentId: string | null = null;

  beforeAll(async () => {
    // Dynamic import to avoid requiring pg when not testing against real DB
    pg = await import('pg');
    client = new pg.Client({ connectionString: TEST_DB_URL });
    await client.connect();

    // Create test fixtures (as postgres/superuser)
    // Ensure FK targets exist for engage_segments inserts
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

    // Apply M431 + M432 in a test schema context
    const m431Sql = readFileSync(join(MIGRATIONS_DIR, '431_engage_segments.sql'), 'utf8');
    const m432Sql = readFileSync(join(MIGRATIONS_DIR, '432_engage_segments_acl.sql'), 'utf8');

    // Drop table if exists from prior test run
    await client.query('DROP TABLE IF EXISTS public.engage_segments CASCADE');
    await client.query(m431Sql);
    await client.query(m432Sql);
  });

  afterAll(async () => {
    // Clean up test data and table
    if (client) {
      await client.query('DROP TABLE IF EXISTS public.engage_segments CASCADE');
      await client.query('DELETE FROM public.businesses WHERE id = $1', [TEST_BIZ_ID]);
      await client.query('DELETE FROM auth.users WHERE id = $1', [TEST_USER_ID]);
      await client.end();
    }
  });

  // ── service_role CRUD ──

  it('service_role can INSERT into engage_segments', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(`
      INSERT INTO public.engage_segments (business_id, name, expression, created_by)
      VALUES ($1, 'Test Segment', '{"type": "all"}', $2)
      RETURNING id
    `, [TEST_BIZ_ID, TEST_USER_ID]);
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    insertedSegmentId = result.rows[0].id;
  });

  it('service_role can SELECT from engage_segments', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'SELECT id, name, business_id FROM public.engage_segments WHERE id = $1',
      [insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Test Segment');
  });

  it('service_role can UPDATE engage_segments', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'UPDATE public.engage_segments SET name = $1 WHERE id = $2 RETURNING name',
      ['Updated Segment', insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows[0].name).toBe('Updated Segment');
  });

  it('service_role can DELETE from engage_segments', async () => {
    await client.query('SET ROLE service_role');
    const result = await client.query(
      'DELETE FROM public.engage_segments WHERE id = $1 RETURNING id',
      [insertedSegmentId],
    );
    await client.query('RESET ROLE');
    expect(result.rows).toHaveLength(1);
    insertedSegmentId = null;
  });

  // ── anon denial ──

  it('anon is denied SELECT on engage_segments (permission denied, not empty)', async () => {
    await client.query('SET ROLE anon');
    await expect(
      client.query('SELECT * FROM public.engage_segments LIMIT 1'),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  it('anon is denied INSERT on engage_segments', async () => {
    await client.query('SET ROLE anon');
    await expect(
      client.query(`INSERT INTO public.engage_segments (business_id, name, expression, created_by)
        VALUES ($1, 'anon-test', '{}', $2)`, [TEST_BIZ_ID, TEST_USER_ID]),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  // ── authenticated denial ──

  it('authenticated is denied SELECT on engage_segments (permission denied)', async () => {
    await client.query('SET ROLE authenticated');
    await expect(
      client.query('SELECT * FROM public.engage_segments LIMIT 1'),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  it('authenticated is denied INSERT on engage_segments', async () => {
    await client.query('SET ROLE authenticated');
    await expect(
      client.query(`INSERT INTO public.engage_segments (business_id, name, expression, created_by)
        VALUES ($1, 'auth-test', '{}', $2)`, [TEST_BIZ_ID, TEST_USER_ID]),
    ).rejects.toThrow(/permission denied/i);
    await client.query('RESET ROLE');
  });

  // ── RLS + privilege catalog ──

  it('RLS is enabled on engage_segments', async () => {
    const result = await client.query(
      "SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'engage_segments'",
    );
    expect(result.rows[0].rowsecurity).toBe(true);
  });

  it('no PUBLIC privilege on engage_segments', async () => {
    const result = await client.query(`
      SELECT relacl FROM pg_class WHERE relname = 'engage_segments' AND relnamespace = 'public'::regnamespace
    `);
    const acl = result.rows[0]?.relacl?.join(',') || '';
    expect(acl).not.toContain('='); // No entry starting with '=' means no PUBLIC grant
  });
});

// ══════════════════════════════════════════════════════════
// Section 3: API route authorization contract
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
