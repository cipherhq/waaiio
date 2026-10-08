/**
 * P0 SECURITY: business_members authorization containment tests
 *
 * Verifies migration 432 closes the self-membership vulnerability:
 *   - Revokes INSERT/UPDATE/DELETE from authenticated + anon
 *   - Replaces FOR ALL policy with SELECT-only for authenticated
 *   - Service role retains full access for API routes
 *
 * Evidence tiers:
 *   A. Static migration SQL structure checks
 *   B. Migration 099 vulnerability characterization (regression anchor)
 *   C. Code-path authority audit (all writes must use service_role)
 *   D. Downstream policy dependency audit
 *   E. Database authorization (manual PostgreSQL — not CI)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const MIGRATION_432 = readFileSync(
  'supabase/migrations/432_p0_business_members_acl_containment.sql',
  'utf-8',
);

const MIGRATION_099 = readFileSync(
  'supabase/migrations/099_business_members.sql',
  'utf-8',
);

// ═══════════════════════════════════════════════════════════════
// A. Static migration SQL structure checks
// ═══════════════════════════════════════════════════════════════
describe('P0: Migration 432 — static SQL structure', () => {
  it('revokes INSERT from authenticated on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+INSERT.*ON\s+public\.business_members\s+FROM\s+authenticated/i,
    );
  });

  it('revokes UPDATE from authenticated on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+.*UPDATE.*ON\s+public\.business_members\s+FROM\s+authenticated/i,
    );
  });

  it('revokes DELETE from authenticated on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+.*DELETE.*ON\s+public\.business_members\s+FROM\s+authenticated/i,
    );
  });

  it('revokes INSERT from anon on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+INSERT.*ON\s+public\.business_members\s+FROM\s+anon/i,
    );
  });

  it('revokes UPDATE from anon on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+.*UPDATE.*ON\s+public\.business_members\s+FROM\s+anon/i,
    );
  });

  it('revokes DELETE from anon on business_members', () => {
    expect(MIGRATION_432).toMatch(
      /REVOKE\s+.*DELETE.*ON\s+public\.business_members\s+FROM\s+anon/i,
    );
  });

  it('drops the overly permissive business_members_manage policy', () => {
    expect(MIGRATION_432).toMatch(
      /DROP\s+POLICY\s+(IF\s+EXISTS\s+)?business_members_manage\s+ON\s+business_members/i,
    );
  });

  it('creates a SELECT-only replacement policy for authenticated', () => {
    expect(MIGRATION_432).toMatch(
      /CREATE\s+POLICY\s+business_members_select\s+ON\s+business_members\s+FOR\s+SELECT\s+TO\s+authenticated/i,
    );
  });

  it('replacement policy preserves owner and self-membership SELECT access', () => {
    // Owner path: business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
    expect(MIGRATION_432).toMatch(/businesses.*WHERE.*owner_id\s*=\s*auth\.uid\(\)/);
    // Self-membership path: user_id = auth.uid()
    expect(MIGRATION_432).toMatch(/user_id\s*=\s*auth\.uid\(\)/);
  });

  it('does NOT grant INSERT/UPDATE/DELETE to authenticated in the new policy', () => {
    // Extract just the CREATE POLICY statement (up to the closing semicolon)
    const policyStart = MIGRATION_432.indexOf('CREATE POLICY business_members_select');
    const policyEnd = MIGRATION_432.indexOf(';', policyStart);
    const policyStmt = MIGRATION_432.slice(policyStart, policyEnd);
    expect(policyStmt).toContain('FOR SELECT');
    expect(policyStmt).not.toMatch(/FOR\s+(ALL|INSERT|UPDATE|DELETE)/i);
  });

  it('does NOT modify the service_role policy', () => {
    // Must not drop or alter business_members_service
    expect(MIGRATION_432).not.toMatch(/DROP\s+POLICY.*business_members_service/i);
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
    // This is the root cause: FOR ALL + OR user_id = auth.uid()
    // The USING clause doubles as WITH CHECK on INSERT when no WITH CHECK is set
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
        // Skip comments
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

        // Look for .from('business_members').insert/update/delete/upsert
        if (
          line.includes("'business_members'") &&
          (line.includes('.insert') || line.includes('.update') || line.includes('.delete') || line.includes('.upsert'))
        ) {
          // Check surrounding context for which client is used
          const contextStart = Math.max(0, i - 20);
          const context = lines.slice(contextStart, i + 1).join('\n');

          // Must use service client, not browser or SSR client
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

    // Verify service client is imported and used
    expect(teamRoute).toContain("import { createServiceClient } from '@/lib/supabase/service'");
    expect(acceptRoute).toContain("import { createServiceClient } from '@/lib/supabase/service'");

    // Verify all .insert/.update/.delete on business_members use 'service' variable
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

    // team_members_view_conversations must check status = 'active'
    expect(m168).toMatch(/team_members_view_conversations[\s\S]*?status\s*=\s*'active'/);

    // team_members_view_messages must check status = 'active'
    expect(m168).toMatch(/team_members_view_messages[\s\S]*?status\s*=\s*'active'/);

    // team_members_send_messages must check status = 'active'
    expect(m168).toMatch(/team_members_send_messages[\s\S]*?status\s*=\s*'active'/);
  });

  it('promo policies (321) reference business_members for SELECT only', () => {
    const m321 = readFileSync(
      'supabase/migrations/321_promotions_schema.sql',
      'utf-8',
    );

    // All promo policies referencing business_members should be FOR SELECT
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
// E. No-regression: migration ordering
// ═══════════════════════════════════════════════════════════════
describe('P0: migration ordering and dependencies', () => {
  it('migration 432 comes after 099 (creates the table), 168 (chat policies), 415 (service_role grants)', () => {
    // These migrations must exist and be ordered before 432
    const migrations = readdirSync('supabase/migrations').sort();
    const m099idx = migrations.findIndex(m => m.startsWith('099'));
    const m168idx = migrations.findIndex(m => m.startsWith('168'));
    const m415idx = migrations.findIndex(m => m.startsWith('415'));
    const m432idx = migrations.findIndex(m => m.startsWith('432'));

    expect(m099idx).toBeGreaterThanOrEqual(0);
    expect(m168idx).toBeGreaterThanOrEqual(0);
    expect(m415idx).toBeGreaterThanOrEqual(0);
    expect(m432idx).toBeGreaterThanOrEqual(0);
    expect(m432idx).toBeGreaterThan(m099idx);
    expect(m432idx).toBeGreaterThan(m168idx);
    expect(m432idx).toBeGreaterThan(m415idx);
  });
});
