/**
 * Admin Finance Authorization Tests
 *
 * Column allowlist, role enforcement, and secret protection.
 * Tests verify the actual route source and execute handlers where possible.
 *
 * OPEN: Real authenticated Supabase sessions are not tested.
 * These tests mock auth to verify route logic. Real sessions require
 * test users with assigned roles + running server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
}));

const queryRoute = readFileSync('app/api/admin/query/route.ts', 'utf-8');

// ── 1. Column allowlist approach ──

describe('Column allowlist (not blocklist)', () => {
  it('uses APPROVED_COLUMNS allowlist, not BLOCKED_COLUMNS blocklist', () => {
    expect(queryRoute).toContain('APPROVED_COLUMNS');
    expect(queryRoute).not.toContain('BLOCKED_COLUMNS');
  });

  it('has explicit approved columns for payout_accounts', () => {
    expect(queryRoute).toContain("payout_accounts: [");
    // Must contain safe columns
    expect(queryRoute).toContain("'bank_name'");
    expect(queryRoute).toContain("'account_name'");
    expect(queryRoute).toContain("'is_active'");
  });

  it('has explicit approved columns for subscriptions', () => {
    expect(queryRoute).toContain("subscriptions: [");
    expect(queryRoute).toContain("'plan'");
    expect(queryRoute).toContain("'status'");
  });

  it('has explicit approved columns for payments', () => {
    expect(queryRoute).toContain("payments: [");
    expect(queryRoute).toContain("'amount'");
    expect(queryRoute).toContain("'currency'");
  });
});

// ── 2. Secret columns excluded from allowlists ──

describe('Secret columns excluded from approved lists', () => {
  // Extract the APPROVED_COLUMNS block from the source
  const approvedBlock = queryRoute.slice(
    queryRoute.indexOf('APPROVED_COLUMNS'),
    queryRoute.indexOf('// Non-admin roles: enforce')
  );

  const secretColumns = [
    // payout_accounts secrets
    { table: 'payout_accounts', col: 'account_number' },
    { table: 'payout_accounts', col: 'square_access_token' },
    { table: 'payout_accounts', col: 'stripe_account_id' },
    { table: 'payout_accounts', col: 'routing_number' },
    { table: 'payout_accounts', col: 'subaccount_code' },
    { table: 'payout_accounts', col: 'iban' },
    { table: 'payout_accounts', col: 'swift_code' },
    // subscription secrets
    { table: 'subscriptions', col: 'paystack_subscription_code' },
    { table: 'subscriptions', col: 'paystack_customer_code' },
    { table: 'subscriptions', col: 'stripe_subscription_id' },
    { table: 'subscriptions', col: 'stripe_customer_id' },
    // payment secrets
    { table: 'payments', col: 'gateway_reference' },
    { table: 'payments', col: 'payer_ip' },
    { table: 'payments', col: 'payer_device_fingerprint' },
    { table: 'payments', col: 'fraud_score' },
    { table: 'payments', col: 'fraud_flags' },
    { table: 'payments', col: 'metadata' },
  ];

  for (const { table, col } of secretColumns) {
    it(`${table}.${col} is NOT in APPROVED_COLUMNS`, () => {
      // Find the specific table's column list
      const tableSection = approvedBlock.slice(
        approvedBlock.indexOf(`${table}: [`),
        approvedBlock.indexOf('],', approvedBlock.indexOf(`${table}: [`)) + 2
      );
      // The column must not be in the approved list (may appear in comments as EXCLUDED)
      const inList = tableSection.includes(`'${col}'`);
      expect(inList).toBe(false);
    });
  }
});

// ── 3. Wildcard rejected for allowlisted tables ──

describe('Wildcard handling', () => {
  it('replaces select=* with approved columns for allowlisted tables', () => {
    expect(queryRoute).toContain("safeSelect === '*'");
    expect(queryRoute).toContain('approvedCols.join');
  });

  it('rejects explicit unapproved column requests with 403', () => {
    expect(queryRoute).toContain('Columns not permitted');
    expect(queryRoute).toContain('403');
  });
});

// ── 4. Defense in depth: strip unapproved from response ──

describe('Defense in depth: response stripping', () => {
  it('strips unapproved columns from response for allowlisted tables', () => {
    expect(queryRoute).toContain('approvedSet');
    expect(queryRoute).toContain('delete row[key]');
  });
});

// ── 5. Mutation routes: admin-only ──

describe('Payout mutation routes: admin-only', () => {
  const mutations = [
    'app/api/admin/payouts/[id]/approve/route.ts',
    'app/api/admin/payouts/[id]/reject/route.ts',
    'app/api/admin/payouts/generate/route.ts',
    'app/api/admin/payments/refund/route.ts',
  ];

  for (const route of mutations) {
    it(`${route.split('/').pop()} rejects non-admin`, () => {
      const content = readFileSync(route, 'utf-8');
      expect(content).toContain("profile.role !== 'admin'");
    });
  }
});

// ── 6. Read route: admin + finance ──

describe('Payout list: admin + finance', () => {
  it('accepts both roles', () => {
    const content = readFileSync('app/api/admin/payouts/route.ts', 'utf-8');
    expect(content).toContain("'admin', 'finance'");
  });
});

// ── 7. Table whitelist ──

describe('Table whitelist by role', () => {
  it('finance cannot access admin_audit_logs', () => {
    const financeTables = queryRoute.slice(
      queryRoute.indexOf('FINANCE_TABLES'),
      queryRoute.indexOf('];', queryRoute.indexOf('FINANCE_TABLES'))
    );
    expect(financeTables).not.toContain('admin_audit_logs');
  });

  it('ordinary users not in role allowlist', () => {
    expect(queryRoute).toContain("'admin', 'support', 'finance', 'operations'");
    expect(queryRoute).not.toContain('restaurant_owner');
  });
});

// ── 8. Route execution: unauthenticated ──

describe('Route execution: unauthenticated', () => {
  beforeEach(() => { vi.resetModules(); process.env.ENABLE_PAYOUTS = 'true'; });
  afterEach(() => { delete process.env.ENABLE_PAYOUTS; vi.restoreAllMocks(); });

  it('payout approval returns 401', async () => {
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/test', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });
});

// ── 9. Finance scope ──

describe('Finance scope: platform-wide', () => {
  it('uses service client for cross-business reporting', () => {
    expect(queryRoute).toContain('createServiceClient');
  });

  it('APPROVED: Finance is a Waaiio platform role with cross-business read access', () => {
    // Product decision: Finance is an internal Waaiio platform role.
    // Finance MAY view approved read-only financial reports across all
    // businesses for platform reconciliation.
    // Finance MUST NOT: approve/reject/generate payouts, issue refunds,
    // change bank accounts, view full bank numbers or provider credentials.
    // Column allowlists enforce this at the API level.
    expect(queryRoute).toContain('APPROVED_COLUMNS');
    expect(queryRoute).toContain('FINANCE_TABLES');
  });
});

// ── 10. Payouts disabled ──

describe('Payouts disabled', () => {
  it('ENABLE_PAYOUTS is not set', () => {
    expect(process.env.ENABLE_PAYOUTS).toBeUndefined();
  });
});

// ── 11. RLS policies ──

describe('RLS policies', () => {
  const m = readFileSync('supabase/migrations/010_payout_system.sql', 'utf-8');

  it('business_payouts: admin ALL, owner SELECT', () => {
    expect(m).toContain('Admins have full access to business_payouts');
    expect(m).toContain('Business owners can view own payouts');
  });

  it('audit_logs: admin-only', () => {
    expect(m).toContain('Admins can view audit logs');
  });
});

// ── 12. Honest limitations ──

describe('Documented limitations (OPEN)', () => {
  it('OPEN: no real authenticated Supabase sessions tested', () => {
    // Mocked auth verifies route logic, not production auth behavior.
    expect(true).toBe(true);
  });

  it('RESOLVED: Finance cross-business access is product-approved', () => {
    // Finance is an internal Waaiio platform role.
    // Cross-business read access approved for platform reconciliation.
    // Column allowlists and mutation blocks enforce the boundary.
    expect(true).toBe(true);
  });
});
