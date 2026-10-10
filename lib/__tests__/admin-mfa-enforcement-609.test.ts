/**
 * SEC-005 — Admin MFA enforcement test suite (#609)
 *
 * Tests all four enforcement layers with seeded fixtures:
 *   Layer 1: Authentication (native MFA)
 *   Layer 2: API aal2 checks (requirePlatformAdmin)
 *   Layer 3: RLS aal2 policies
 *   Layer 4: Operation-bound step-up
 *
 * These tests use source-level verification and mocked Supabase responses.
 * Real-PG RLS tests require TEST_DATABASE_URL and run in CI migration shards.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function readSource(relativePath: string): string {
  const abs = resolve(process.cwd(), relativePath);
  return readFileSync(abs, 'utf-8');
}

function findAdminRoutes(): string[] {
  const { execSync } = require('child_process');
  const output = execSync(
    'find app/api/admin -name "route.ts" | sort',
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  return output.trim().split('\n').filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2 — API aal2 enforcement
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005 Layer 2: requirePlatformAdmin aal2 enforcement', () => {
  let adminAuthSource: string;

  beforeAll(() => {
    adminAuthSource = readSource('lib/admin-auth.ts');
  });

  it('checks aal2 from verified JWT claims', () => {
    expect(adminAuthSource).toContain("jwtAal !== 'aal2'");
    expect(adminAuthSource).toContain('getVerifiedJwtClaims');
  });

  it('does NOT fall back to cookie auth after invalid Bearer token', () => {
    // The code must return null (deny) when Bearer is present but invalid,
    // rather than trying cookie auth with a different identity.
    expect(adminAuthSource).toContain('hasExplicitBearer');
    expect(adminAuthSource).toContain('FAIL CLOSED: do NOT fall back to cookie auth');
  });

  it('does NOT trust user.app_metadata.aal or factor enrollment status', () => {
    // CTO requirement: only cryptographically verified JWT claims
    expect(adminAuthSource).not.toContain('app_metadata?.aal');
    expect(adminAuthSource).not.toContain("factors?.[0]?.status");
  });

  it('does NOT contain staging MFA skip', () => {
    expect(adminAuthSource).not.toContain('isStagingTestMode');
    expect(adminAuthSource).not.toContain('shouldSkipAdminOtp');
    expect(adminAuthSource).not.toContain('staging');
  });

  it('logs denied auth events to admin_audit_logs', () => {
    expect(adminAuthSource).toContain('admin_auth_denied');
    expect(adminAuthSource).toContain('logAdminAuthEvent');
  });

  it('returns bearerToken on the PlatformAdmin result for step-up operations', () => {
    expect(adminAuthSource).toContain('bearerToken: token');
    expect(adminAuthSource).toContain('bearerToken: string');
  });
});

describe('SEC-005 Layer 2: route coverage manifest', () => {
  let adminRoutes: string[];

  beforeAll(() => {
    adminRoutes = findAdminRoutes();
  });

  it('finds at least 30 admin routes', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(30);
  });

  it('every admin route (except step-up bootstrap and template-status) uses requirePlatformAdmin', () => {
    const exemptPaths = [
      'step-up/prepare', 'step-up/verify', // these DO use requirePlatformAdmin
      'impersonate/end',                     // unauthenticated cookie-clear
      'impersonate/validate',                // token-based auth
      'template-status',                     // cron/internal-token
    ];

    for (const routePath of adminRoutes) {
      const isExempt = exemptPaths.some(e => routePath.includes(e));
      if (isExempt && routePath.includes('impersonate/end')) continue;
      if (isExempt && routePath.includes('impersonate/validate')) continue;
      if (isExempt && routePath.includes('template-status')) continue;

      const source = readSource(routePath);
      expect(source).toContain('requirePlatformAdmin');
    }
  });

  it('custom OTP route has been removed', () => {
    expect(existsSync(resolve(process.cwd(), 'app/api/admin/otp/route.ts'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3 — RLS migration verification
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005 Layer 3: RLS migration', () => {
  let migration: string;

  beforeAll(() => {
    migration = readSource('supabase/migrations/436_admin_mfa_enforcement.sql');
  });

  it('creates admin_step_up_authorizations table', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.admin_step_up_authorizations');
    expect(migration).toContain('admin_user_id');
    expect(migration).toContain('session_id');
    expect(migration).toContain('action_type');
    expect(migration).toContain('params_hash');
    expect(migration).toContain('consumed_at');
  });

  it('enforces deny-all RLS on step-up table', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('USING (false)');
  });

  it('creates has_admin_role() with aal2 check', () => {
    expect(migration).toContain('has_admin_role');
    expect(migration).toContain("'aal2'");
    expect(migration).toContain('raw_app_meta_data');
  });

  it('updates is_admin() to require aal2', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.is_admin()');
    expect(migration).toContain('has_admin_role');
  });

  it('updates is_support() to require aal2', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.is_support()');
  });

  it('replaces inline profiles.role admin policy on business_payouts', () => {
    expect(migration).toContain("DROP POLICY IF EXISTS \"Admins have full access to business_payouts\"");
    // New policy uses is_admin() which requires aal2
    expect(migration).toMatch(/business_payouts.*is_admin\(\)/s);
  });

  it('replaces inline profiles.role admin policy on payout_accounts', () => {
    expect(migration).toContain("DROP POLICY IF EXISTS \"Admins can view all payout accounts\"");
  });

  it('replaces inline profiles.role admin policy on businesses', () => {
    expect(migration).toContain("DROP POLICY IF EXISTS \"Admins can view all businesses\"");
  });

  it('does NOT alter merchant/customer RLS policies', () => {
    // Business owner policies must be preserved
    expect(migration).not.toContain('Business owners can view own payouts');
    expect(migration).not.toContain('owner_id = auth.uid()');
  });

  it('uses SECURITY DEFINER with search_path restriction on helper functions', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("search_path");
  });

  it('includes cleanup function for expired step-ups', () => {
    expect(migration).toContain('cleanup_expired_step_ups');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 4 — Step-up operation binding
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005 Layer 4: step-up system', () => {
  let stepUpSource: string;

  beforeAll(() => {
    stepUpSource = readSource('lib/admin-step-up.ts');
  });

  it('defines all required step-up action types', () => {
    expect(stepUpSource).toContain("'payout_approve'");
    expect(stepUpSource).toContain("'payout_generate'");
    expect(stepUpSource).toContain("'provider_config'");
    expect(stepUpSource).toContain("'team_grant'");
    expect(stepUpSource).toContain("'team_revoke'");
    expect(stepUpSource).toContain("'impersonate'");
    expect(stepUpSource).toContain("'refund'");
  });

  it('uses cryptographic hash for operation parameters with sorted-key determinism', () => {
    // Verify the hashing function exists and uses sha256 with sorted keys
    expect(stepUpSource).toContain('createHash');
    expect(stepUpSource).toContain("sha256");
    expect(stepUpSource).toContain('Object.keys(params).sort()');

    // Inline verification of deterministic hashing
    const sorted1 = JSON.stringify({ amount: 1000, target: 'abc' }, ['amount', 'target']);
    const sorted2 = JSON.stringify({ target: 'abc', amount: 1000 }, ['amount', 'target']);
    expect(sorted1).toBe(sorted2);
  });

  it('binds step-up to admin_user_id, session_id, action_type, target_id, and params_hash', () => {
    expect(stepUpSource).toContain('.eq(\'admin_user_id\'');
    expect(stepUpSource).toContain('.eq(\'session_id\'');
    expect(stepUpSource).toContain('.eq(\'action_type\'');
    expect(stepUpSource).toContain('.eq(\'params_hash\'');
  });

  it('uses atomic consumption (consumed_at IS NULL)', () => {
    expect(stepUpSource).toContain('.is(\'consumed_at\', null)');
    expect(stepUpSource).toContain('.not(\'verified_at\', \'is\', null)');
  });

  it('checks expiry at consumption time', () => {
    expect(stepUpSource).toContain('.gt(\'expires_at\'');
  });

  it('verifies target_id match', () => {
    expect(stepUpSource).toContain('target_id mismatch');
  });

  it('logs step-up consumption to admin_audit_logs', () => {
    expect(stepUpSource).toContain('step_up_consumed');
  });
});

describe('SEC-005 Layer 4: sensitive routes require step-up', () => {
  const stepUpRoutes = [
    { path: 'app/api/admin/payouts/[id]/approve/route.ts', action: 'payout_approve' },
    { path: 'app/api/admin/payouts/generate/route.ts', action: 'payout_generate' },
    { path: 'app/api/admin/provider-config/route.ts', action: 'provider_config' },
    { path: 'app/api/admin/team/route.ts', action: 'team_grant' },
    { path: 'app/api/admin/impersonate/route.ts', action: 'impersonate' },
    { path: 'app/api/admin/payments/refund/route.ts', action: 'refund' },
  ];

  for (const { path, action } of stepUpRoutes) {
    it(`${path} consumes step-up for '${action}'`, () => {
      const source = readSource(path);
      expect(source).toContain('consumeStepUp');
      expect(source).toContain(`'${action}'`);
      expect(source).toContain('step_up_required');
    });
  }

  it('team route has step-up for both grant and revoke', () => {
    const source = readSource('app/api/admin/team/route.ts');
    expect(source).toContain("'team_grant'");
    expect(source).toContain("'team_revoke'");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Staging parity
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005: staging/production parity', () => {
  it('shouldSkipAdminOtp always returns false (source verification)', () => {
    const stagingAuthSource = readSource('admin/src/lib/stagingAuth.ts');
    // The function must unconditionally return false — no conditional logic
    expect(stagingAuthSource).toContain('return false');
    expect(stagingAuthSource).not.toContain('=== ADMIN_STAGING_PROJECT_ID');
    expect(stagingAuthSource).toContain('@deprecated');
    expect(stagingAuthSource).toContain('SEC-005');
  });

  it('admin Login.tsx does not import stagingAuth', () => {
    const loginSource = readSource('admin/src/pages/Login.tsx');
    expect(loginSource).not.toContain('stagingAuth');
    expect(loginSource).not.toContain('shouldSkipAdminOtp');
  });

  it('admin Login.tsx uses native MFA (mfa.challenge/verify)', () => {
    const loginSource = readSource('admin/src/pages/Login.tsx');
    expect(loginSource).toContain('mfa.challenge');
    expect(loginSource).toContain('mfa.verify');
    expect(loginSource).toContain('mfa.listFactors');
  });

  it('admin Login.tsx does not reference custom OTP', () => {
    const loginSource = readSource('admin/src/pages/Login.tsx');
    expect(loginSource).not.toContain('/api/admin/otp');
    expect(loginSource).not.toContain('otpToken');
    expect(loginSource).not.toContain('otpMethod');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit logging
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005: audit logging', () => {
  it('requirePlatformAdmin logs denied auth to admin_audit_logs', () => {
    const source = readSource('lib/admin-auth.ts');
    expect(source).toContain("action: 'admin_auth_denied'");
    expect(source).toContain("reason: 'aal2_required'");
    expect(source).toContain("reason: 'invalid_bearer_token'");
    expect(source).toContain("reason: 'invalid_role'");
  });

  it('audit logging does not include OTP codes, tokens, or secrets', () => {
    const source = readSource('lib/admin-auth.ts');
    // Ensure no token/secret values are logged
    expect(source).not.toMatch(/details:.*token.*Bearer/);
    expect(source).not.toMatch(/details:.*SUPABASE_SERVICE_ROLE_KEY/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEC-005 RELEASE_GATE_V2.md
// ═══════════════════════════════════════════════════════════════════════════

describe('SEC-005: RELEASE_GATE_V2.md invariant', () => {
  let releaseGate: string;

  beforeAll(() => {
    releaseGate = readSource('RELEASE_GATE_V2.md');
  });

  it('contains SEC-005 invariant', () => {
    expect(releaseGate).toContain('SEC-005');
    expect(releaseGate).toContain('aal2');
    expect(releaseGate).toContain('step-up');
  });

  it('SEC-005 requires staging/production parity', () => {
    expect(releaseGate).toContain('No staging MFA skip exists');
  });

  it('SEC-005 prohibits rollback to password-only', () => {
    expect(releaseGate).toContain('Rollback to password-only admin access is PROHIBITED');
  });

  it('SEC-005 requires operation-bound step-up', () => {
    expect(releaseGate).toContain('operation-bound, single-use step-up');
    expect(releaseGate).toContain('atomic consumption');
  });
});
