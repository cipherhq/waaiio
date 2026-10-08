/**
 * M431 — engage_segments privilege contract + API authorization tests
 *
 * Two sections:
 *
 * 1. Static migration analysis (always runs):
 *    - Verifies the migration SQL contains correct GRANT/REVOKE statements
 *    - Verifies RLS is enabled
 *    - Verifies verification DO $$ block is present
 *
 * 2. Live PostgreSQL ACL verification (requires TEST_DATABASE_URL):
 *    - service_role: SELECT, INSERT, UPDATE, DELETE = allowed
 *    - anon: all = denied
 *    - authenticated: all = denied (direct table; RLS defense policy requires owner match)
 *    - RLS enabled on engage_segments
 *
 * 3. API route authorization contract (always runs):
 *    - GET requires businessId param
 *    - POST requires businessId, name, expression
 *    - All routes require authentication
 *    - All routes enforce capability + role via requireCapabilityWithRole
 *    - Cross-business access is scoped by business_id eq filter
 *
 * Post-migration staging certification SQL (MUST be run manually):
 *
 *   -- As superuser, verify service_role CRUD:
 *   SET ROLE service_role;
 *   INSERT INTO public.engage_segments (business_id, name, expression, created_by)
 *     VALUES ('00000000-0000-0000-0000-000000000000', 'test', '{}', '00000000-0000-0000-0000-000000000000');
 *   -- (will fail on FK, but should NOT fail on permission denied)
 *   RESET ROLE;
 *
 *   -- Verify anon is denied:
 *   SET ROLE anon;
 *   SELECT * FROM public.engage_segments;
 *   -- MUST return "permission denied for table engage_segments"
 *   RESET ROLE;
 *
 *   -- Verify authenticated is denied:
 *   SET ROLE authenticated;
 *   SELECT * FROM public.engage_segments;
 *   -- MUST return "permission denied for table engage_segments"
 *   RESET ROLE;
 *
 *   -- Verify RLS is enabled:
 *   SELECT tablename, rowsecurity FROM pg_tables
 *     WHERE schemaname = 'public' AND tablename = 'engage_segments';
 *   -- rowsecurity must be true
 *
 *   -- Verify exact privileges:
 *   SELECT grantee, privilege_type FROM information_schema.role_table_grants
 *     WHERE table_schema = 'public' AND table_name = 'engage_segments'
 *     ORDER BY grantee, privilege_type;
 *   -- service_role: SELECT, INSERT, UPDATE, DELETE
 *   -- anon: (none)
 *   -- authenticated: (none)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

/* ─── helpers ─── */

const DB_URL = process.env.TEST_DATABASE_URL;
const skipDb = !DB_URL;

function sql(query: string): string {
  return execSync(
    `psql "${DB_URL}" -t -A -v ON_ERROR_STOP=1`,
    { input: query, encoding: 'utf-8', timeout: 10_000 },
  ).trim();
}

const migrationPath = resolve(
  __dirname,
  '../../supabase/migrations/431_engage_segments.sql',
);
const migrationSql = readFileSync(migrationPath, 'utf-8');

/* ═══════════════════════════════════════════════════════════
   Section 1: Static migration SQL analysis (always runs)
   ═══════════════════════════════════════════════════════════ */

describe('M431 — engage_segments migration SQL scope guard (static)', () => {
  const sqlLines = migrationSql
    .split('\n')
    .filter(line => !line.trim().startsWith('--') && line.trim().length > 0);
  const fullSql = sqlLines.join(' ');

  it('creates the engage_segments table', () => {
    expect(migrationSql).toContain('CREATE TABLE public.engage_segments');
  });

  it('enables RLS on engage_segments', () => {
    expect(migrationSql).toContain('ALTER TABLE public.engage_segments ENABLE ROW LEVEL SECURITY');
  });

  it('REVOKE ALL from anon and authenticated', () => {
    const revokeLines = sqlLines.filter(line => /REVOKE/i.test(line));
    expect(revokeLines.length).toBeGreaterThanOrEqual(1);
    const revokeAll = revokeLines.find(line =>
      /REVOKE\s+ALL\s+ON\s+TABLE\s+public\.engage_segments\s+FROM\s+anon\s*,\s*authenticated/i.test(line),
    );
    expect(revokeAll).toBeDefined();
  });

  it('GRANT SELECT, INSERT, UPDATE, DELETE to service_role', () => {
    const grantLines = sqlLines.filter(line =>
      /GRANT/i.test(line) && !/has_table_privilege/i.test(line),
    );
    const crudGrant = grantLines.find(line =>
      /GRANT\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\.engage_segments\s+TO\s+service_role/i.test(line),
    );
    expect(crudGrant).toBeDefined();
  });

  it('does NOT grant TRUNCATE, REFERENCES, or TRIGGER to service_role', () => {
    const grantLines = sqlLines.filter(line =>
      /GRANT/i.test(line) &&
      !/has_table_privilege/i.test(line) &&
      /service_role/i.test(line),
    );
    for (const line of grantLines) {
      expect(line).not.toMatch(/TRUNCATE|REFERENCES|TRIGGER/i);
    }
  });

  it('does NOT grant any privilege to anon or authenticated', () => {
    // Only REVOKE lines should mention anon/authenticated
    const grantLines = sqlLines.filter(line =>
      /GRANT/i.test(line) &&
      !/has_table_privilege/i.test(line) &&
      !line.trim().startsWith('--'),
    );
    for (const line of grantLines) {
      expect(line).not.toMatch(/TO\s+(anon|authenticated)/i);
    }
  });

  it('contains a verification DO $$ block with all required checks', () => {
    expect(fullSql).toContain('DO $$');

    // service_role checks
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'SELECT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'INSERT')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'UPDATE')");
    expect(migrationSql).toContain("has_table_privilege('service_role', 'public.engage_segments', 'DELETE')");

    // anon denial checks
    expect(migrationSql).toContain("has_table_privilege('anon', 'public.engage_segments', 'SELECT')");
    expect(migrationSql).toContain("has_table_privilege('anon', 'public.engage_segments', 'INSERT')");

    // authenticated denial checks
    expect(migrationSql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'SELECT')");
    expect(migrationSql).toContain("has_table_privilege('authenticated', 'public.engage_segments', 'INSERT')");

    // RLS check
    expect(migrationSql).toContain('rowsecurity');
  });

  it('creates a defense-in-depth RLS policy scoped to business owner', () => {
    expect(migrationSql).toContain('CREATE POLICY engage_segments_owner_defense');
    expect(migrationSql).toContain('owner_id = auth.uid()');
  });

  it('targets only the engage_segments table', () => {
    const grantLines = sqlLines.filter(line =>
      /GRANT/i.test(line) &&
      !/has_table_privilege/i.test(line) &&
      !line.trim().startsWith('--'),
    );
    for (const line of grantLines) {
      expect(line).toContain('engage_segments');
    }
    const revokeLines = sqlLines.filter(line => /REVOKE/i.test(line));
    for (const line of revokeLines) {
      expect(line).toContain('engage_segments');
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   Section 2: Live PostgreSQL ACL verification (requires TEST_DATABASE_URL)
   ═══════════════════════════════════════════════════════════ */

describe.skipIf(skipDb)('M431 — engage_segments ACL (DB)', () => {
  it('service_role has SELECT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('service_role', 'public.engage_segments', 'SELECT');`);
    expect(result).toBe('t');
  });

  it('service_role has INSERT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('service_role', 'public.engage_segments', 'INSERT');`);
    expect(result).toBe('t');
  });

  it('service_role has UPDATE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('service_role', 'public.engage_segments', 'UPDATE');`);
    expect(result).toBe('t');
  });

  it('service_role has DELETE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('service_role', 'public.engage_segments', 'DELETE');`);
    expect(result).toBe('t');
  });

  it('anon is denied SELECT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('anon', 'public.engage_segments', 'SELECT');`);
    expect(result).toBe('f');
  });

  it('anon is denied INSERT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('anon', 'public.engage_segments', 'INSERT');`);
    expect(result).toBe('f');
  });

  it('anon is denied UPDATE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('anon', 'public.engage_segments', 'UPDATE');`);
    expect(result).toBe('f');
  });

  it('anon is denied DELETE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('anon', 'public.engage_segments', 'DELETE');`);
    expect(result).toBe('f');
  });

  it('authenticated is denied SELECT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('authenticated', 'public.engage_segments', 'SELECT');`);
    expect(result).toBe('f');
  });

  it('authenticated is denied INSERT on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('authenticated', 'public.engage_segments', 'INSERT');`);
    expect(result).toBe('f');
  });

  it('authenticated is denied UPDATE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('authenticated', 'public.engage_segments', 'UPDATE');`);
    expect(result).toBe('f');
  });

  it('authenticated is denied DELETE on engage_segments', () => {
    const result = sql(`SELECT has_table_privilege('authenticated', 'public.engage_segments', 'DELETE');`);
    expect(result).toBe('f');
  });

  it('RLS is enabled on engage_segments', () => {
    const result = sql(`
      SELECT rowsecurity FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'engage_segments';
    `);
    expect(result).toBe('t');
  });
});

/* ═══════════════════════════════════════════════════════════
   Section 3: API route authorization contract (static code analysis)

   These tests verify the route handler code enforces proper
   authorization patterns. They read the source files and confirm
   the required guard calls are present.
   ═══════════════════════════════════════════════════════════ */

describe('M431 — engage_segments API authorization contract', () => {
  const listCreateRoute = readFileSync(
    resolve(__dirname, '../../app/api/engage/segments/route.ts'),
    'utf-8',
  );
  const singleRoute = readFileSync(
    resolve(__dirname, '../../app/api/engage/segments/[id]/route.ts'),
    'utf-8',
  );

  describe('GET /api/engage/segments (list)', () => {
    it('requires authentication via supabase.auth.getUser()', () => {
      expect(listCreateRoute).toContain('supabase.auth.getUser()');
    });

    it('returns 401 when unauthenticated', () => {
      expect(listCreateRoute).toContain("{ error: 'Unauthorized' }, { status: 401 }");
    });

    it('requires businessId parameter', () => {
      expect(listCreateRoute).toContain("'businessId is required'");
    });

    it('uses requireCapabilityWithRole for authorization', () => {
      expect(listCreateRoute).toContain('requireCapabilityWithRole');
    });

    it('enforces broadcast capability for listing', () => {
      expect(listCreateRoute).toContain("capability: 'broadcast'");
    });

    it('uses service client (createServiceClient) for DB access', () => {
      expect(listCreateRoute).toContain('createServiceClient');
    });

    it('scopes query to business_id', () => {
      expect(listCreateRoute).toContain(".eq('business_id', businessId)");
    });
  });

  describe('POST /api/engage/segments (create)', () => {
    it('requires authentication', () => {
      expect(listCreateRoute).toContain('supabase.auth.getUser()');
    });

    it('enforces broadcast capability with owner/admin roles for creation', () => {
      // The POST handler requires allowedRoles: ['owner', 'admin']
      expect(listCreateRoute).toContain("action: 'create_new'");
      expect(listCreateRoute).toContain("'owner', 'admin'");
    });

    it('validates expression DSL before insert', () => {
      expect(listCreateRoute).toContain('validateAudienceExpression(expression)');
    });

    it('sets created_by from auth context, not request body', () => {
      expect(listCreateRoute).toContain('created_by: user.id');
    });
  });

  describe('GET /api/engage/segments/[id] (single)', () => {
    it('requires authentication', () => {
      expect(singleRoute).toContain('supabase.auth.getUser()');
    });

    it('scopes query to both id and business_id', () => {
      expect(singleRoute).toContain(".eq('id', id)");
      expect(singleRoute).toContain(".eq('business_id', businessId)");
    });

    it('returns 404 when segment not found (not leaked cross-business)', () => {
      expect(singleRoute).toContain("{ error: 'Segment not found' }, { status: 404 }");
    });
  });

  describe('PUT /api/engage/segments/[id] (update)', () => {
    it('requires owner/admin role for update', () => {
      expect(singleRoute).toContain("action: 'manage_existing'");
    });

    it('validates expression if provided', () => {
      expect(singleRoute).toContain('validateAudienceExpression(expression)');
    });

    it('scopes update to both id and business_id', () => {
      // Verify the update query uses both filters
      expect(singleRoute).toContain(".eq('id', id)");
      expect(singleRoute).toContain(".eq('business_id', businessId)");
    });
  });

  describe('DELETE /api/engage/segments/[id] (delete)', () => {
    it('requires owner/admin role for delete', () => {
      expect(singleRoute).toContain("action: 'manage_existing'");
    });

    it('scopes delete to both id and business_id', () => {
      expect(singleRoute).toContain(".eq('id', id)");
      expect(singleRoute).toContain(".eq('business_id', businessId)");
    });

    it('reports not found when count is 0', () => {
      expect(singleRoute).toContain('count === 0');
    });
  });
});
