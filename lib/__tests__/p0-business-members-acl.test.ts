/**
 * P0 SECURITY: business_members authorization containment tests
 *
 * Verifies migration 433 closes the self-membership vulnerability:
 *   - Revokes INSERT/UPDATE/DELETE from authenticated + anon
 *   - Replaces FOR ALL policy with SELECT-only for authenticated
 *   - Service role retains full access for API routes
 *
 * Evidence tiers:
 *   A. Static migration SQL structure checks (always run)
 *   B. Migration 099 vulnerability characterization — regression anchor (always run)
 *   C. Code-path authority audit — all writes must use service_role (always run)
 *   D. Downstream policy dependency audit (always run)
 *   E. Migration ordering and compatibility (always run)
 *   F. Executable PostgreSQL authorization tests (require TEST_DATABASE_URL)
 *      — Self-insertion denied, privilege escalation denied, self-delete denied,
 *        downstream chat access denied, legitimate service_role operations succeed
 *
 * Section F requires TEST_DATABASE_URL pointing to a CI-provisioned ephemeral
 * Postgres (see .github/workflows/ci.yml security-acl-tests job).
 * SAFETY: Tests refuse to run if business_members already exists.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const MIGRATION_433 = readFileSync(
  'supabase/migrations/433_p0_business_members_acl_containment.sql',
  'utf-8',
);

const MIGRATION_099 = readFileSync(
  'supabase/migrations/099_business_members.sql',
  'utf-8',
);

// ═══════════════════════════════════════════════════════════════
// A. Static migration SQL structure checks
// ═══════════════════════════════════════════════════════════════
describe('P0: Migration 433 — static SQL structure', () => {
  it('revokes INSERT, UPDATE, DELETE from authenticated on business_members', () => {
    expect(MIGRATION_433).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.business_members\s+FROM\s+authenticated/i,
    );
  });

  it('revokes INSERT, UPDATE, DELETE from anon on business_members', () => {
    expect(MIGRATION_433).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.business_members\s+FROM\s+anon/i,
    );
  });

  it('drops the overly permissive business_members_manage policy', () => {
    expect(MIGRATION_433).toMatch(
      /DROP\s+POLICY\s+IF\s+EXISTS\s+business_members_manage\s+ON\s+business_members/i,
    );
  });

  it('creates a SELECT-only replacement policy for authenticated', () => {
    expect(MIGRATION_433).toMatch(
      /CREATE\s+POLICY\s+business_members_select\s+ON\s+business_members\s+FOR\s+SELECT\s+TO\s+authenticated/i,
    );
  });

  it('replacement policy preserves owner and self-membership SELECT access', () => {
    expect(MIGRATION_433).toMatch(/businesses.*WHERE.*owner_id\s*=\s*auth\.uid\(\)/);
    expect(MIGRATION_433).toMatch(/user_id\s*=\s*auth\.uid\(\)/);
  });

  it('new policy is FOR SELECT only, not FOR ALL/INSERT/UPDATE/DELETE', () => {
    const policyStart = MIGRATION_433.indexOf('CREATE POLICY business_members_select');
    const policyEnd = MIGRATION_433.indexOf(';', policyStart);
    const policyStmt = MIGRATION_433.slice(policyStart, policyEnd);
    expect(policyStmt).toContain('FOR SELECT');
    expect(policyStmt).not.toMatch(/FOR\s+(ALL|INSERT|UPDATE|DELETE)/i);
  });

  it('does NOT modify the service_role policy', () => {
    expect(MIGRATION_433).not.toMatch(/DROP\s+POLICY.*business_members_service/i);
  });

  it('includes fail-closed verification assertions in migration SQL', () => {
    expect(MIGRATION_433).toContain("has_table_privilege('authenticated', 'public.business_members', 'INSERT')");
    expect(MIGRATION_433).toContain("has_table_privilege('service_role', 'public.business_members', 'INSERT')");
    expect(MIGRATION_433).toContain("policyname = 'business_members_manage'");
    expect(MIGRATION_433).toContain("policyname = 'business_members_select'");
  });
});

// ═══════════════════════════════════════════════════════════════
// B. Migration 099 vulnerability characterization (regression anchor)
// ═══════════════════════════════════════════════════════════════
describe('P0: Migration 099 — vulnerability characterization', () => {
  it('original policy is FOR ALL (not SELECT-only)', () => {
    expect(MIGRATION_099).toMatch(
      /CREATE\s+POLICY\s+business_members_manage\s+ON\s+business_members\s+FOR\s+ALL/i,
    );
  });

  it('original policy uses OR user_id = auth.uid() — the self-insertion vector', () => {
    const policyStart = MIGRATION_099.indexOf('CREATE POLICY business_members_manage');
    const policyEnd = MIGRATION_099.indexOf(');', policyStart);
    const policyDef = MIGRATION_099.slice(policyStart, policyEnd);
    expect(policyDef).toMatch(/OR\s+user_id\s*=\s*auth\.uid\(\)/);
  });

  it('original policy has no explicit WITH CHECK clause', () => {
    const policyStart = MIGRATION_099.indexOf('CREATE POLICY business_members_manage');
    const policyEnd = MIGRATION_099.indexOf(');', policyStart);
    const policyDef = MIGRATION_099.slice(policyStart, policyEnd);
    expect(policyDef.toUpperCase()).not.toContain('WITH CHECK');
  });
});

// ═══════════════════════════════════════════════════════════════
// C. Code-path authority audit — all writes must use service_role
// ═══════════════════════════════════════════════════════════════
describe('P0: business_members write authority audit', () => {
  function collectTsFiles(dir: string, base: string): string[] {
    const files: string[] = [];
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.next', '__tests__', '.git', '.claude', 'graphify-out'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { files.push(...collectTsFiles(full, base)); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
        files.push(relative(base, full));
      }
    } catch { /* skip */ }
    return files;
  }

  it('no browser/SSR client writes to business_members (all writes use service_role)', () => {
    const root = process.cwd();
    const dirs = ['app', 'lib', 'components'];
    const allFiles = dirs.flatMap(d => collectTsFiles(join(root, d), root));
    const violations: string[] = [];

    for (const file of allFiles) {
      const code = readFileSync(join(root, file), 'utf-8');
      const lines = code.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        if (
          line.includes("'business_members'") &&
          (line.includes('.insert') || line.includes('.update') || line.includes('.delete') || line.includes('.upsert'))
        ) {
          const contextStart = Math.max(0, i - 20);
          const context = lines.slice(contextStart, i + 1).join('\n');

          const usesService =
            context.includes('createServiceClient') ||
            context.includes('service.from') ||
            context.includes('supabase = createServiceClient');

          if (!usesService) {
            violations.push(`${file}:${i + 1}: non-service write to business_members: ${line.trim()}`);
          }
        }
      }
    }

    expect(
      violations,
      `Client-side writes to business_members found:\n${violations.join('\n')}`,
    ).toHaveLength(0);
  });

  it('team API routes use service client for all business_members operations', () => {
    const teamRoute = readFileSync('app/api/team/route.ts', 'utf-8');
    const acceptRoute = readFileSync('app/api/team/accept/route.ts', 'utf-8');

    expect(teamRoute).toContain("import { createServiceClient } from '@/lib/supabase/service'");
    expect(acceptRoute).toContain("import { createServiceClient } from '@/lib/supabase/service'");

    const teamInserts = teamRoute.match(/\.from\('business_members'\)\.(insert|update|delete)/g);
    expect(teamInserts).not.toBeNull();
    expect(teamInserts!.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// D. Downstream policy dependency audit
// ═══════════════════════════════════════════════════════════════
describe('P0: downstream policy dependency audit', () => {
  it('migration 168 chat policies require status = active (not just any membership)', () => {
    const m168 = readFileSync(
      'supabase/migrations/168_multi_agent_chat.sql',
      'utf-8',
    );

    expect(m168).toMatch(/team_members_view_conversations[\s\S]*?status\s*=\s*'active'/);
    expect(m168).toMatch(/team_members_view_messages[\s\S]*?status\s*=\s*'active'/);
    expect(m168).toMatch(/team_members_send_messages[\s\S]*?status\s*=\s*'active'/);
  });

  it('promo policies (321) reference business_members for SELECT only', () => {
    const m321 = readFileSync(
      'supabase/migrations/321_promotions_schema.sql',
      'utf-8',
    );

    const promoMemberPolicies = m321.match(
      /CREATE\s+POLICY\s+\w+\s+ON\s+\w+\s+FOR\s+\w+[\s\S]*?business_members[\s\S]*?;/g,
    );

    if (promoMemberPolicies) {
      for (const policy of promoMemberPolicies) {
        expect(policy).toMatch(/FOR\s+SELECT/i);
      }
    }
  });

  it('check_business_role function is SECURITY DEFINER (server-side only)', () => {
    expect(MIGRATION_099).toMatch(
      /check_business_role[\s\S]*?SECURITY\s+DEFINER/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// E. Migration ordering and compatibility
// ═══════════════════════════════════════════════════════════════
describe('P0: migration ordering and dependencies', () => {
  it('M433 comes after M099 (table), M168 (chat policies), M415 (service_role grants)', () => {
    const migrations = readdirSync('supabase/migrations').sort();
    const m099idx = migrations.findIndex(m => m.startsWith('099'));
    const m168idx = migrations.findIndex(m => m.startsWith('168'));
    const m415idx = migrations.findIndex(m => m.startsWith('415'));
    const m433idx = migrations.findIndex(m => m.startsWith('433'));

    expect(m099idx).toBeGreaterThanOrEqual(0);
    expect(m168idx).toBeGreaterThanOrEqual(0);
    expect(m415idx).toBeGreaterThanOrEqual(0);
    expect(m433idx).toBeGreaterThanOrEqual(0);
    expect(m433idx).toBeGreaterThan(m099idx);
    expect(m433idx).toBeGreaterThan(m168idx);
    expect(m433idx).toBeGreaterThan(m415idx);
  });

  it('M433 does not collide with M432 (engage_segments_acl, PR #581)', () => {
    const migrations = readdirSync('supabase/migrations').filter(m => m.startsWith('433'));
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toBe('433_p0_business_members_acl_containment.sql');
  });
});

// ═══════════════════════════════════════════════════════════════
// F. Executable PostgreSQL authorization tests
//    Require TEST_DATABASE_URL → CI security-acl-tests job
// ═══════════════════════════════════════════════════════════════

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('P0: Executable PG authorization — business_members containment', () => {
  let pg: { Client: new (opts: { connectionString: string }) => PgClient };
  let client: PgClient;

  // Test identities
  const OWNER_ID = '11111111-1111-1111-1111-111111111111';
  const ATTACKER_ID = '22222222-2222-2222-2222-222222222222';
  const BUSINESS_ID = '33333333-3333-3333-3333-333333333333';

  beforeAll(async () => {
    pg = await import('pg');
    client = new pg.Client({ connectionString: TEST_DB_URL! });
    await client.connect();

    // SAFETY: Refuse to operate on a database that already has business_members
    const existing = await client.query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'business_members'",
    );
    if (existing.rows.length > 0) {
      await client.end();
      throw new Error(
        'business_members already exists — refusing to run. ' +
        'These tests require a clean disposable database (CI security-acl-tests job).',
      );
    }

    // Create fixture users
    await client.query(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      VALUES
        ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'owner@test.local', crypt('test', gen_salt('bf')), now(), now()),
        ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'attacker@test.local', crypt('test', gen_salt('bf')), now(), now())
      ON CONFLICT (id) DO NOTHING
    `, [OWNER_ID, ATTACKER_ID]);

    // Create fixture business owned by OWNER_ID
    await client.query(`
      INSERT INTO public.businesses (id, owner_id, name, slug, category, flow_type, country_code, status)
      VALUES ($1, $2, 'Target Business', 'target-biz', 'shop', 'ordering', 'US', 'active')
      ON CONFLICT (id) DO NOTHING
    `, [BUSINESS_ID, OWNER_ID]);

    // Create minimal chat tables for downstream cascade tests
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.chat_conversations (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        customer_phone text NOT NULL,
        last_message_at timestamptz DEFAULT now(),
        created_at timestamptz DEFAULT now() NOT NULL,
        UNIQUE(business_id, customer_phone)
      );
      ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
      GRANT SELECT ON public.chat_conversations TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO service_role;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.chat_messages (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        customer_phone text NOT NULL,
        direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        message_text text NOT NULL,
        is_read boolean DEFAULT false NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL
      );
      ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT ON public.chat_messages TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_messages TO service_role;
    `);

    // Insert test chat data via superuser (no RLS)
    await client.query(`
      INSERT INTO chat_conversations (business_id, customer_phone) VALUES ($1, '+1234567890')
      ON CONFLICT DO NOTHING
    `, [BUSINESS_ID]);
    await client.query(`
      INSERT INTO chat_messages (business_id, customer_phone, direction, message_text)
      VALUES ($1, '+1234567890', 'inbound', 'Test message')
    `, [BUSINESS_ID]);

    // Apply M099: creates business_members with the VULNERABLE policy
    // Note: on production, ALTER DEFAULT PRIVILEGES grants full DML to authenticated.
    // We replicate that here so the vulnerability test is faithful.
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_members TO authenticated;
      GRANT SELECT ON public.business_members TO anon;
    `);

    const m099Sql = readFileSync(join(process.cwd(), 'supabase/migrations/099_business_members.sql'), 'utf8');
    await client.query(m099Sql);

    // Grant DML to authenticated (matching production default privileges)
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_members TO authenticated;
    `);

    // Apply M168 chat team member policies
    // (Minimal: just the 3 policies, not the full migration)
    await client.query(`
      CREATE POLICY team_members_view_conversations ON chat_conversations FOR SELECT
        USING (
          business_id IN (
            SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
          )
        );
    `);
    await client.query(`
      CREATE POLICY team_members_view_messages ON chat_messages FOR SELECT
        USING (
          business_id IN (
            SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
          )
        );
    `);
    await client.query(`
      CREATE POLICY team_members_send_messages ON chat_messages FOR INSERT
        WITH CHECK (
          direction = 'outbound' AND
          business_id IN (
            SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
          )
        );
    `);
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.query('RESET ROLE');
        // Clean up only what we created
        await client.query('DROP POLICY IF EXISTS team_members_send_messages ON chat_messages');
        await client.query('DROP POLICY IF EXISTS team_members_view_messages ON chat_messages');
        await client.query('DROP POLICY IF EXISTS team_members_view_conversations ON chat_conversations');
        await client.query('DROP TABLE IF EXISTS public.chat_messages');
        await client.query('DROP TABLE IF EXISTS public.chat_conversations');
        await client.query('DROP POLICY IF EXISTS business_members_select ON business_members');
        await client.query('DROP POLICY IF EXISTS business_members_manage ON business_members');
        await client.query('DROP POLICY IF EXISTS business_members_service ON business_members');
        await client.query('DROP FUNCTION IF EXISTS public.check_business_role(uuid, uuid, business_role[])');
        await client.query('DROP TABLE IF EXISTS public.business_members');
        await client.query('DROP TYPE IF EXISTS public.business_role');
        await client.query('DELETE FROM public.businesses WHERE id = $1', [BUSINESS_ID]);
        await client.query('DELETE FROM auth.users WHERE id IN ($1, $2)', [OWNER_ID, ATTACKER_ID]);
      } finally {
        await client.end();
      }
    }
  });

  // ── Pre-fix: prove the vulnerability exists (M099 only) ──

  it('PRE-FIX: authenticated can self-insert into any business (proves vulnerability)', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    // This is the attack: insert self as active member of a business we don't own
    const result = await client.query(`
      INSERT INTO business_members (business_id, user_id, email, role, status)
      VALUES ($1, $2, 'attacker@evil.com', 'admin', 'active')
      RETURNING id
    `, [BUSINESS_ID, ATTACKER_ID]);

    expect(result.rows).toHaveLength(1);

    await client.query('RESET ROLE');
    // Clean up the attack row before applying fix
    await client.query('DELETE FROM business_members WHERE user_id = $1', [ATTACKER_ID]);
  });

  // ── Apply M433 fix ──

  it('M433 migration applies cleanly', async () => {
    await client.query('RESET ROLE');
    const m433Sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/433_p0_business_members_acl_containment.sql'),
      'utf8',
    );
    // The migration includes DO $$ blocks with RAISE EXCEPTION on failure
    await expect(client.query(m433Sql)).resolves.not.toThrow();
  });

  // ── Post-fix: self-insertion denied ──

  it('POST-FIX: authenticated INSERT denied with permission error (self-membership blocked)', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    await expect(
      client.query(`
        INSERT INTO business_members (business_id, user_id, email, role, status)
        VALUES ($1, $2, 'attacker@evil.com', 'staff', 'active')
      `, [BUSINESS_ID, ATTACKER_ID]),
    ).rejects.toThrow(/permission denied/i);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: privilege escalation denied ──

  it('POST-FIX: authenticated UPDATE denied (cannot escalate role)', async () => {
    // First, create a legitimate member via superuser
    await client.query(`
      INSERT INTO business_members (business_id, user_id, email, role, status)
      VALUES ($1, $2, 'legit@test.local', 'staff', 'active')
      ON CONFLICT (business_id, email) DO NOTHING
    `, [BUSINESS_ID, ATTACKER_ID]);

    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    await expect(
      client.query(`UPDATE business_members SET role = 'owner' WHERE user_id = $1`, [ATTACKER_ID]),
    ).rejects.toThrow(/permission denied/i);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: self-delete denied ──

  it('POST-FIX: authenticated DELETE denied (cannot cover tracks)', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    await expect(
      client.query(`DELETE FROM business_members WHERE user_id = $1`, [ATTACKER_ID]),
    ).rejects.toThrow(/permission denied/i);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: authenticated SELECT still works for own membership ──

  it('POST-FIX: authenticated can SELECT own membership row', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    const result = await client.query(
      `SELECT id, role, status FROM business_members WHERE user_id = $1`,
      [ATTACKER_ID],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].role).toBe('staff');

    await client.query('RESET ROLE');
  });

  // ── Post-fix: owner can SELECT all members of owned business ──

  it('POST-FIX: owner can SELECT all members of their business', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${OWNER_ID}'`);
    await client.query('SET ROLE authenticated');

    const result = await client.query(
      `SELECT id, email, role FROM business_members WHERE business_id = $1`,
      [BUSINESS_ID],
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: non-owner/non-member cannot SELECT other business members ──

  it('POST-FIX: unrelated user cannot SELECT members of non-owned business', async () => {
    // Create a third user who is neither owner nor member
    const OUTSIDER_ID = '44444444-4444-4444-4444-444444444444';
    await client.query('RESET ROLE');
    await client.query(`
      INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
      VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'outsider@test.local', crypt('test', gen_salt('bf')), now(), now())
      ON CONFLICT (id) DO NOTHING
    `, [OUTSIDER_ID]);

    await client.query(`SET LOCAL request.jwt.claim.sub = '${OUTSIDER_ID}'`);
    await client.query('SET ROLE authenticated');

    const result = await client.query(
      `SELECT id FROM business_members WHERE business_id = $1`,
      [BUSINESS_ID],
    );

    expect(result.rows).toHaveLength(0); // RLS blocks — empty, not error

    await client.query('RESET ROLE');
    await client.query('DELETE FROM auth.users WHERE id = $1', [OUTSIDER_ID]);
  });

  // ── Post-fix: downstream chat access denied without legitimate membership ──

  it('POST-FIX: non-member cannot read chat_conversations via team membership policy', async () => {
    // Remove the attacker's membership
    await client.query('RESET ROLE');
    await client.query('DELETE FROM business_members WHERE user_id = $1', [ATTACKER_ID]);

    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    const result = await client.query(
      `SELECT id FROM chat_conversations WHERE business_id = $1`,
      [BUSINESS_ID],
    );

    expect(result.rows).toHaveLength(0); // No membership → no access

    await client.query('RESET ROLE');
  });

  it('POST-FIX: non-member cannot read chat_messages via team membership policy', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    const result = await client.query(
      `SELECT id FROM chat_messages WHERE business_id = $1`,
      [BUSINESS_ID],
    );

    expect(result.rows).toHaveLength(0);

    await client.query('RESET ROLE');
  });

  it('POST-FIX: non-member cannot insert outbound chat_messages', async () => {
    await client.query(`SET LOCAL request.jwt.claim.sub = '${ATTACKER_ID}'`);
    await client.query('SET ROLE authenticated');

    await expect(
      client.query(`
        INSERT INTO chat_messages (business_id, customer_phone, direction, message_text)
        VALUES ($1, '+1234567890', 'outbound', 'Forged message')
      `, [BUSINESS_ID]),
    ).rejects.toThrow(/row-level security|new row violates/i);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: service_role retains full access (legitimate operations) ──

  it('POST-FIX: service_role can INSERT (team invitation)', async () => {
    await client.query('SET ROLE service_role');

    const result = await client.query(`
      INSERT INTO business_members (business_id, email, role, status, invited_by, invite_token)
      VALUES ($1, 'invited@test.local', 'staff', 'invited', $2, 'test-token-123')
      RETURNING id
    `, [BUSINESS_ID, OWNER_ID]);

    expect(result.rows).toHaveLength(1);

    await client.query('RESET ROLE');
  });

  it('POST-FIX: service_role can UPDATE (accept invitation)', async () => {
    await client.query('SET ROLE service_role');

    const result = await client.query(`
      UPDATE business_members
      SET user_id = $1, status = 'active', joined_at = now(), invite_token = NULL
      WHERE email = 'invited@test.local' AND business_id = $2
      RETURNING status
    `, [ATTACKER_ID, BUSINESS_ID]);

    expect(result.rows[0].status).toBe('active');

    await client.query('RESET ROLE');
  });

  it('POST-FIX: service_role can UPDATE role (role change)', async () => {
    await client.query('SET ROLE service_role');

    const result = await client.query(`
      UPDATE business_members SET role = 'admin'
      WHERE user_id = $1 AND business_id = $2
      RETURNING role
    `, [ATTACKER_ID, BUSINESS_ID]);

    expect(result.rows[0].role).toBe('admin');

    await client.query('RESET ROLE');
  });

  it('POST-FIX: service_role can DELETE (remove member)', async () => {
    await client.query('SET ROLE service_role');

    const result = await client.query(`
      DELETE FROM business_members
      WHERE user_id = $1 AND business_id = $2
      RETURNING id
    `, [ATTACKER_ID, BUSINESS_ID]);

    expect(result.rows).toHaveLength(1);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: anon has no access ──

  it('POST-FIX: anon INSERT denied', async () => {
    await client.query('SET ROLE anon');

    await expect(
      client.query(`
        INSERT INTO business_members (business_id, user_id, email, role, status)
        VALUES ($1, $2, 'anon@evil.com', 'staff', 'active')
      `, [BUSINESS_ID, ATTACKER_ID]),
    ).rejects.toThrow(/permission denied/i);

    await client.query('RESET ROLE');
  });

  // ── Post-fix: catalog verification ──

  it('POST-FIX: catalog confirms business_members_manage policy no longer exists', async () => {
    const result = await client.query(`
      SELECT policyname, cmd FROM pg_policies
      WHERE tablename = 'business_members' AND policyname = 'business_members_manage'
    `);
    expect(result.rows).toHaveLength(0);
  });

  it('POST-FIX: catalog confirms business_members_select is SELECT-only', async () => {
    const result = await client.query(`
      SELECT cmd FROM pg_policies
      WHERE tablename = 'business_members' AND policyname = 'business_members_select'
    `);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].cmd).toBe('SELECT');
  });

  it('POST-FIX: RLS is enabled on business_members', async () => {
    const result = await client.query(`
      SELECT rowsecurity FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'business_members'
    `);
    expect(result.rows[0].rowsecurity).toBe(true);
  });
});
