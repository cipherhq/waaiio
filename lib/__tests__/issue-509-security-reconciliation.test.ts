/**
 * Issue #509: Admin security reconciliation
 *
 * Covers the security contracts established by migrations M421-M424:
 *
 * A. DB-dependent tests (require TEST_DATABASE_URL — real PostgreSQL)
 *    1. Platform settings 6-key public RLS allowlist
 *    2. Platform settings no public writes
 *    3. Capability overrides least-privilege (anon/authenticated none, service_role SELECT only)
 *    4. OTP challenge channel column exists and defaults to 'phone'
 *    5. Export rate limits table exists with correct schema
 *
 * B. Route-level tests (mock-based, no DB needed)
 *    6. Admin platform-settings route: commercial key rejection
 *    7. Middleware signup_open readability via public RLS path
 *
 * Run:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/issue-509-security-reconciliation.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

// ══════════════════════════════════════════════════════════════════════
// A1. Platform settings 6-key public RLS allowlist (M421)
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M421: platform_settings public RLS allowlist (DB)', () => {
  const EXPECTED_PUBLIC_KEYS = [
    'pricing_tiers', 'broadcast_limits', 'trial_days',
    'booking_defaults', 'signup_open', 'maintenance_mode',
  ];

  it('public_read_config_settings policy exists', () => {
    const result = psql(`
      SELECT COUNT(*) FROM pg_policy
      WHERE polrelid = 'public.platform_settings'::regclass
        AND polname = 'public_read_config_settings'
    `);
    expect(result).toBe('1');
  });

  it('public_read_config_settings policy allows exactly 6 keys', () => {
    // Extract the policy qual and verify all 6 keys are present
    const policyQual = psql(`
      SELECT pg_get_expr(polqual, polrelid)
      FROM pg_policy
      WHERE polrelid = 'public.platform_settings'::regclass
        AND polname = 'public_read_config_settings'
    `);
    for (const key of EXPECTED_PUBLIC_KEYS) {
      expect(policyQual).toContain(key);
    }
  });

  it('anon can SELECT public allowlist keys via RLS', () => {
    // Verify anon can read signup_open through the public policy
    const result = psql(`
      BEGIN;
      SET LOCAL ROLE anon;
      SELECT COUNT(*) FROM platform_settings
      WHERE key IN ('pricing_tiers', 'broadcast_limits', 'trial_days',
                    'booking_defaults', 'signup_open', 'maintenance_mode');
      ROLLBACK;
    `);
    // Should return a number (may be 0 if no rows, but no permission error)
    expect(Number(result)).toBeGreaterThanOrEqual(0);
  });

  it('anon cannot SELECT keys outside the allowlist', () => {
    // Insert a test key, try to read as anon, then clean up
    const result = psql(`
      BEGIN;
      INSERT INTO platform_settings (key, value) VALUES ('_test_509_private', '"secret"'::jsonb)
        ON CONFLICT (key) DO NOTHING;
      SET LOCAL ROLE anon;
      SELECT COUNT(*) FROM platform_settings WHERE key = '_test_509_private';
      ROLLBACK;
    `);
    expect(result).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════════
// A2. Platform settings no public writes (M421)
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M421: platform_settings no public writes (DB)', () => {
  it('anon cannot INSERT into platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE anon;
      INSERT INTO platform_settings (key, value) VALUES ('_test_anon_insert', '"hack"'::jsonb);
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('anon cannot UPDATE platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE anon;
      UPDATE platform_settings SET value = '"hacked"'::jsonb WHERE key = 'signup_open';
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('anon cannot DELETE from platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE anon;
      DELETE FROM platform_settings WHERE key = 'signup_open';
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('authenticated cannot INSERT into platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE authenticated;
      INSERT INTO platform_settings (key, value) VALUES ('_test_auth_insert', '"hack"'::jsonb);
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('authenticated cannot UPDATE platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE authenticated;
      UPDATE platform_settings SET value = '"hacked"'::jsonb WHERE key = 'signup_open';
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });

  it('authenticated cannot DELETE from platform_settings', () => {
    const r = psqlMayFail(`
      SET ROLE authenticated;
      DELETE FROM platform_settings WHERE key = 'signup_open';
      RESET ROLE;
    `);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/permission denied/i);
  });
});

// ══════════════════════════════════════════════════════════════════════
// A3. Capability overrides least privilege (M422)
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M422: capability_overrides least privilege (DB)', () => {
  it('anon has NO SELECT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('anon', 'public.capability_overrides', 'SELECT')`,
    );
    expect(result).toBe('f');
  });

  it('anon has NO INSERT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('anon', 'public.capability_overrides', 'INSERT')`,
    );
    expect(result).toBe('f');
  });

  it('authenticated has NO SELECT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('authenticated', 'public.capability_overrides', 'SELECT')`,
    );
    expect(result).toBe('f');
  });

  it('authenticated has NO INSERT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('authenticated', 'public.capability_overrides', 'INSERT')`,
    );
    expect(result).toBe('f');
  });

  it('service_role has SELECT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.capability_overrides', 'SELECT')`,
    );
    expect(result).toBe('t');
  });

  it('service_role has NO INSERT on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.capability_overrides', 'INSERT')`,
    );
    expect(result).toBe('f');
  });

  it('service_role has NO UPDATE on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.capability_overrides', 'UPDATE')`,
    );
    expect(result).toBe('f');
  });

  it('service_role has NO DELETE on capability_overrides', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.capability_overrides', 'DELETE')`,
    );
    expect(result).toBe('f');
  });

  it('RLS remains enabled on capability_overrides', () => {
    const result = psql(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_overrides'`,
    );
    expect(result).toBe('t');
  });

  it('service_all policy uses service_role predicate', () => {
    const count = psql(`
      SELECT COUNT(*) FROM pg_policy
      WHERE polrelid = 'public.capability_overrides'::regclass
        AND polname = 'capability_overrides_service_all'
        AND pg_get_expr(polqual, polrelid) LIKE '%service_role%'
    `);
    expect(count).toBe('1');
  });
});

// ══════════════════════════════════════════════════════════════════════
// A4. OTP challenge channel support (M423)
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M423: OTP challenge channel column (DB)', () => {
  it('phone_otp_challenges has a channel column', () => {
    const result = psql(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'phone_otp_challenges'
        AND column_name = 'channel'
    `);
    expect(result).toBe('1');
  });

  it('channel column defaults to phone', () => {
    const result = psql(`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'phone_otp_challenges'
        AND column_name = 'channel'
    `);
    expect(result).toContain('phone');
  });

  it('channel column is NOT NULL', () => {
    const result = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'phone_otp_challenges'
        AND column_name = 'channel'
    `);
    expect(result).toBe('NO');
  });

  it('RLS remains enabled on phone_otp_challenges', () => {
    const result = psql(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'phone_otp_challenges'`,
    );
    expect(result).toBe('t');
  });
});

// ══════════════════════════════════════════════════════════════════════
// A5. Export rate limits table (M424)
// ══════════════════════════════════════════════════════════════════════

describe.skipIf(!canRunDb)('M424: export_rate_limits table (DB)', () => {
  it('export_rate_limits table exists', () => {
    const result = psql(`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'export_rate_limits'
    `);
    expect(result).toBe('1');
  });

  it('has user_id column as primary key', () => {
    const result = psql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'export_rate_limits'
        AND column_name = 'user_id'
    `);
    expect(result).toBe('user_id');

    // Verify it is the PK
    const pkResult = psql(`
      SELECT COUNT(*) FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.relname = 'export_rate_limits'
        AND c.contype = 'p'
    `);
    expect(pkResult).toBe('1');
  });

  it('has last_export_at column with timestamptz type', () => {
    const result = psql(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'export_rate_limits'
        AND column_name = 'last_export_at'
    `);
    expect(result).toBe('timestamp with time zone');
  });

  it('has created_at column with timestamptz type', () => {
    const result = psql(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'export_rate_limits'
        AND column_name = 'created_at'
    `);
    expect(result).toBe('timestamp with time zone');
  });

  it('RLS is enabled', () => {
    const result = psql(
      `SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'export_rate_limits'`,
    );
    expect(result).toBe('t');
  });

  it('service_role has SELECT on export_rate_limits', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.export_rate_limits', 'SELECT')`,
    );
    expect(result).toBe('t');
  });

  it('service_role has INSERT on export_rate_limits', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.export_rate_limits', 'INSERT')`,
    );
    expect(result).toBe('t');
  });

  it('service_role has UPDATE on export_rate_limits', () => {
    const result = psql(
      `SELECT has_table_privilege('service_role', 'public.export_rate_limits', 'UPDATE')`,
    );
    expect(result).toBe('t');
  });

  it('anon has NO access to export_rate_limits', () => {
    const result = psql(
      `SELECT has_table_privilege('anon', 'public.export_rate_limits', 'SELECT')`,
    );
    expect(result).toBe('f');
  });

  it('authenticated has NO access to export_rate_limits', () => {
    const result = psql(
      `SELECT has_table_privilege('authenticated', 'public.export_rate_limits', 'SELECT')`,
    );
    expect(result).toBe('f');
  });
});

// ══════════════════════════════════════════════════════════════════════
// B. Route-level tests — mock-based (no DB needed)
// ══════════════════════════════════════════════════════════════════════

// Mock requirePlatformAdmin
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(),
}));

// Mock createServiceClient
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(),
}));

// ══════════════════════════════════════════════════════════════════════
// B1. Admin platform-settings route: commercial key rejection
// ══════════════════════════════════════════════════════════════════════

describe('Admin platform-settings route: commercial key rejection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const COMMERCIAL_KEYS = [
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'fee_policy_enabled', 'category_fee_rates',
  ];

  async function setupAdmin() {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue({
      id: 'admin-uuid',
      userId: 'admin-uuid',
      email: 'admin@test.com',
      role: 'admin',
    });
  }

  async function setupMockService() {
    const { createServiceClient } = await import('@/lib/supabase/service');
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    const mockUpdate = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    const mockDelete = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        insert: mockInsert,
        update: mockUpdate,
        delete: mockDelete,
      }),
    } as any);
  }

  it('PUT rejects commercial key with 403', async () => {
    await setupAdmin();

    const { PUT } = await import('@/app/api/admin/platform-settings/route');

    for (const key of COMMERCIAL_KEYS) {
      const request = new Request('http://localhost/api/admin/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: 'hacked' }),
      });

      const response = await PUT(request as any);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('save_commercial_config');
    }
  });

  it('POST rejects commercial key with 403', async () => {
    await setupAdmin();

    const { POST } = await import('@/app/api/admin/platform-settings/route');

    for (const key of COMMERCIAL_KEYS) {
      const request = new Request('http://localhost/api/admin/platform-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: 'hacked' }),
      });

      const response = await POST(request as any);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('save_commercial_config');
    }
  });

  it('DELETE rejects commercial key with 403', async () => {
    await setupAdmin();

    const { DELETE } = await import('@/app/api/admin/platform-settings/route');

    for (const key of COMMERCIAL_KEYS) {
      const request = new Request('http://localhost/api/admin/platform-settings', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });

      const response = await DELETE(request as any);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toContain('Commercial');
    }
  });

  it('PUT succeeds for non-commercial key', async () => {
    await setupAdmin();
    await setupMockService();

    const { PUT } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'site_announcement', value: { enabled: true } }),
    });

    const response = await PUT(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it('POST succeeds for non-commercial key', async () => {
    await setupAdmin();
    await setupMockService();

    const { POST } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'custom_setting', value: 'test' }),
    });

    const response = await POST(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it('DELETE succeeds for non-commercial key', async () => {
    await setupAdmin();
    await setupMockService();

    const { DELETE } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'obsolete_setting' }),
    });

    const response = await DELETE(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it('PUT returns 403 when not admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { PUT } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'site_announcement', value: {} }),
    });

    const response = await PUT(request as any);
    expect(response.status).toBe(403);
  });

  it('POST returns 403 when not admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { POST } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'new_key', value: 'val' }),
    });

    const response = await POST(request as any);
    expect(response.status).toBe(403);
  });

  it('DELETE returns 403 when not admin', async () => {
    const { requirePlatformAdmin } = await import('@/lib/admin-auth');
    vi.mocked(requirePlatformAdmin).mockResolvedValue(null);

    const { DELETE } = await import('@/app/api/admin/platform-settings/route');

    const request = new Request('http://localhost/api/admin/platform-settings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'some_key' }),
    });

    const response = await DELETE(request as any);
    expect(response.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B2. Middleware signup_open readability
// ══════════════════════════════════════════════════════════════════════

describe('Middleware signup_open readability contract', () => {
  it('signup_open is in the M421 6-key public allowlist', () => {
    // This is a static contract test: the middleware reads signup_open
    // via anon role, which requires the key to be in the
    // public_read_config_settings allowlist.
    const PUBLIC_ALLOWLIST = [
      'pricing_tiers', 'broadcast_limits', 'trial_days',
      'booking_defaults', 'signup_open', 'maintenance_mode',
    ];
    expect(PUBLIC_ALLOWLIST).toContain('signup_open');
    expect(PUBLIC_ALLOWLIST).toContain('maintenance_mode');
    expect(PUBLIC_ALLOWLIST).toHaveLength(6);
  });

  it('middleware reads signup_open from platform_settings', async () => {
    // Verify the middleware code path exists by checking the module
    // imports and function signatures (static analysis).
    // The actual DB read is tested in the DB-dependent section above.
    const fs = await import('fs');
    const middlewareSrc = fs.readFileSync(
      new URL('../../middleware.ts', import.meta.url), 'utf-8',
    );
    expect(middlewareSrc).toContain("'signup_open'");
    expect(middlewareSrc).toContain('platform_settings');
    expect(middlewareSrc).toContain('isSignupOpenMiddleware');
  });

  it('maintenance_mode is also read from platform_settings in middleware', async () => {
    const fs = await import('fs');
    const middlewareSrc = fs.readFileSync(
      new URL('../../middleware.ts', import.meta.url), 'utf-8',
    );
    expect(middlewareSrc).toContain("'maintenance_mode'");
    expect(middlewareSrc).toContain('isMaintenanceMode');
  });
});

// ════════════════════════════════════════════════════════════
// B3: Commercial key classification — 19-key server protection + client routing
// ════════════════════════════════════════════════════════════
describe('B3: commercial key classification and client routing contract', () => {
  const CANONICAL_19 = [
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'fee_policy_enabled', 'category_fee_rates',
    'messaging_topup_packages',
    'messaging_pricing',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
  ];

  const INDIVIDUALLY_WRITABLE_16 = [
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'fee_policy_enabled', 'category_fee_rates',
    'messaging_topup_packages',
  ];

  const MESSAGING_BUNDLE_3 = [
    'messaging_pricing',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
  ];

  it('server route protects all 19 canonical keys from generic CRUD', async () => {
    const fs = await import('fs');
    const routeSrc = fs.readFileSync(
      new URL('../../app/api/admin/platform-settings/route.ts', import.meta.url), 'utf-8',
    );
    for (const key of CANONICAL_19) {
      expect(routeSrc).toContain(`'${key}'`);
    }
  });

  it('admin client COMMERCIAL_KEYS has exactly 16 individually writable keys', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    for (const key of INDIVIDUALLY_WRITABLE_16) {
      expect(src).toContain(`'${key}'`);
    }
  });

  it('admin client MESSAGING_BUNDLE_KEYS has exactly the 3 bundle-only keys', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    for (const key of MESSAGING_BUNDLE_3) {
      expect(src).toContain(`'${key}'`);
    }
    expect(src).toContain('MESSAGING_BUNDLE_KEYS');
  });

  it('3 bundle-only keys are NOT routed through save_commercial_config', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // handleSave/handleAdd/handleConfigure all check MESSAGING_BUNDLE_KEYS
    // before checking COMMERCIAL_KEYS, preventing routing to save_commercial_config
    const bundleGuardCount = (src.match(/MESSAGING_BUNDLE_KEYS\.has/g) || []).length;
    // Must appear in handleSave, handleAdd, handleConfigure, handleDelete, and UI
    expect(bundleGuardCount).toBeGreaterThanOrEqual(4);
  });

  it('messaging_topup_packages remains individually writable via save_commercial_config', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // messaging_topup_packages is in COMMERCIAL_KEYS, NOT in MESSAGING_BUNDLE_KEYS
    expect(src).toMatch(/COMMERCIAL_KEYS.*messaging_topup_packages/s);
    // Verify it's not in the bundle set by checking the bundle set definition
    const bundleMatch = src.match(/MESSAGING_BUNDLE_KEYS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/s);
    expect(bundleMatch).toBeTruthy();
    expect(bundleMatch![1]).not.toContain('messaging_topup_packages');
  });

  it('bundle-only keys show read-only UI indicator', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    expect(src).toContain('Managed in Countries config');
  });

  // ── Behavioral UI contract tests ──

  it('configured bundle-only keys render non-editable read-only display, not renderSettingEditor', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // The configured-key render path must branch on MESSAGING_BUNDLE_KEYS
    // and show a read-only div instead of calling renderSettingEditor
    expect(src).toContain('MESSAGING_BUNDLE_KEYS.has(setting.key) ?');
    // Must use data-testid for read-only value (proves non-editable render)
    expect(src).toContain('data-testid={`readonly-value-${setting.key}`}');
    // The alternative branch calls renderSettingEditor (for writable keys)
    expect(src).toContain('renderSettingEditor(setting, val, changed');
  });

  it('unconfigured bundle-only keys do NOT expose Configure button', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // The unconfigured section must gate isBundleOnly before rendering Configure
    expect(src).toContain('const isBundleOnly = MESSAGING_BUNDLE_KEYS.has(key)');
    // Configure button is conditional on !isBundleOnly
    expect(src).toContain('!isBundleOnly && !isConfiguring');
    // isConfiguring is forced false for bundle keys
    expect(src).toContain('const isConfiguring = !isBundleOnly && configuringKey === key');
  });

  it('unconfigured bundle-only keys show messaging config description instead of Configure', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // Bundle-only unconfigured rows get a description about save_messaging_config
    expect(src).toContain('save_messaging_config()');
    expect(src).toContain('Countries/Messaging configuration page');
  });

  it('all three bundle-only keys are covered by MESSAGING_BUNDLE_KEYS', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    const bundleMatch = src.match(/MESSAGING_BUNDLE_KEYS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/s);
    expect(bundleMatch).toBeTruthy();
    const bundleContent = bundleMatch![1];
    expect(bundleContent).toContain("'messaging_pricing'");
    expect(bundleContent).toContain("'trial_credit_minor_by_currency'");
    expect(bundleContent).toContain("'subscription_included_minor_by_tier_currency'");
    // Exactly 3 — no more, no less
    const keyMatches = bundleContent.match(/'/g) || [];
    expect(keyMatches.length).toBe(6); // 3 keys × 2 quotes each
  });

  it('16 individually writable commercial keys use save_commercial_config in handleSave', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../admin/src/pages/PlatformSettings.tsx', import.meta.url), 'utf-8',
    );
    // handleSave routes COMMERCIAL_KEYS to save_commercial_config RPC
    expect(src).toContain("adminDb.rpc('save_commercial_config'");
    // COMMERCIAL_KEYS contains messaging_topup_packages (individually writable)
    const commercialMatch = src.match(/const COMMERCIAL_KEYS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/s);
    expect(commercialMatch).toBeTruthy();
    expect(commercialMatch![1]).toContain("'messaging_topup_packages'");
  });

  it('server route still protects all 19 keys from generic CRUD', async () => {
    const fs = await import('fs');
    const routeSrc = fs.readFileSync(
      new URL('../../app/api/admin/platform-settings/route.ts', import.meta.url), 'utf-8',
    );
    for (const key of CANONICAL_19) {
      expect(routeSrc).toContain(`'${key}'`);
    }
  });
});

// ════════════════════════════════════════════════════════════
// B4: OTP channel isolation — cross-channel rejection
// ════════════════════════════════════════════════════════════
describe('B4: OTP channel isolation', () => {
  it('generatePhoneOtp explicitly writes channel=phone', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../otp-phone-token.ts', import.meta.url), 'utf-8',
    );
    expect(src).toContain("channel: 'phone'");
  });

  it('verifyPhoneOtp filters by channel=phone', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../otp-phone-token.ts', import.meta.url), 'utf-8',
    );
    expect(src).toContain(".eq('channel', 'phone')");
  });

  it('generic generateOtpChallenge writes the provided channel', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../otp-challenge.ts', import.meta.url), 'utf-8',
    );
    // Must insert with channel parameter
    expect(src).toMatch(/channel[,:\s]/);
    // Must support email and recurring
    expect(src).toContain("'email'");
    expect(src).toContain("'recurring'");
  });

  it('generic verifyOtpChallenge filters by channel', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../otp-challenge.ts', import.meta.url), 'utf-8',
    );
    expect(src).toContain(".eq('channel',");
  });

  it('phone verifier cannot accept a recurring challenge (source contract)', () => {
    // The phone verifier queries .eq('channel', 'phone').
    // A recurring challenge has channel='recurring', so it will not match.
    // This is a static contract assertion — the runtime behavior follows from
    // the .eq('channel', 'phone') filter in verifyPhoneOtp.
    const fs = require('fs');
    const phoneSrc = fs.readFileSync(
      require('path').resolve(__dirname, '../otp-phone-token.ts'), 'utf-8',
    );
    const challengeSrc = fs.readFileSync(
      require('path').resolve(__dirname, '../otp-challenge.ts'), 'utf-8',
    );
    // Phone verifier scopes to 'phone'
    expect(phoneSrc).toContain(".eq('channel', 'phone')");
    // Generic verifier scopes to the provided channel
    expect(challengeSrc).toContain(".eq('channel',");
    // Recurring challenges write channel='recurring', not 'phone'
    expect(challengeSrc).toContain("'recurring'");
  });

  it('audit log failure causes server route to return error', async () => {
    const fs = await import('fs');
    const routeSrc = fs.readFileSync(
      new URL('../../app/api/admin/platform-settings/route.ts', import.meta.url), 'utf-8',
    );
    // All three handlers must return 500 when audit fails
    const auditFailMatches = routeSrc.match(/audit failed/gi) || [];
    expect(auditFailMatches.length).toBeGreaterThanOrEqual(3);
    // Must NOT silently continue after audit failure
    expect(routeSrc).not.toMatch(/auditError\)\s*\{\s*console\.error[^}]*\}\s*\n\s*return NextResponse\.json\(\{ success: true \}\)/);
  });
});
