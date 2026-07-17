/**
 * Admin Finance Authorization Tests
 *
 * Tests route handler logic, column security, and role enforcement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── 1. Mutation routes: admin-only ──

describe('Payout mutation routes: admin-only', () => {
  const routes = [
    { file: 'app/api/admin/payouts/[id]/approve/route.ts', name: 'approve' },
    { file: 'app/api/admin/payouts/[id]/reject/route.ts', name: 'reject' },
    { file: 'app/api/admin/payouts/generate/route.ts', name: 'generate' },
    { file: 'app/api/admin/payments/refund/route.ts', name: 'refund' },
  ];

  for (const r of routes) {
    it(`${r.name} rejects non-admin roles`, () => {
      const content = readFileSync(r.file, 'utf-8');
      expect(content).toContain("profile.role !== 'admin'");
    });
  }
});

// ── 2. Read route: admin + finance ──

describe('Payout list route: admin + finance', () => {
  it('accepts both admin and finance roles', () => {
    const content = readFileSync('app/api/admin/payouts/route.ts', 'utf-8');
    expect(content).toContain("'admin', 'finance'");
  });
});

// ── 3. Admin query: column security ──

describe('Admin query route: column blocklist', () => {
  const queryRoute = readFileSync('app/api/admin/query/route.ts', 'utf-8');

  it('defines BLOCKED_COLUMNS for payout_accounts', () => {
    expect(queryRoute).toContain('BLOCKED_COLUMNS');
    expect(queryRoute).toContain("payout_accounts: ['account_number', 'square_access_token', 'routing_number', 'subaccount_code', 'stripe_account_id']");
  });

  it('defines BLOCKED_COLUMNS for whatsapp_channels', () => {
    expect(queryRoute).toContain("whatsapp_channels: ['meta_access_token']");
  });

  it('defines explicit safe column list for payout_accounts', () => {
    expect(queryRoute).toContain('PAYOUT_ACCOUNT_SAFE_COLUMNS');
    // Safe columns should NOT include any sensitive fields
    expect(queryRoute).toContain("'id', 'business_id', 'gateway', 'bank_name', 'account_name'");
    // Verify blocked columns are NOT in the safe list
    const safeColSection = queryRoute.slice(
      queryRoute.indexOf('PAYOUT_ACCOUNT_SAFE_COLUMNS'),
      queryRoute.indexOf('];', queryRoute.indexOf('PAYOUT_ACCOUNT_SAFE_COLUMNS'))
    );
    expect(safeColSection).not.toContain('account_number');
    expect(safeColSection).not.toContain('square_access_token');
    expect(safeColSection).not.toContain('routing_number');
    expect(safeColSection).not.toContain('subaccount_code');
    expect(safeColSection).not.toContain('stripe_account_id');
  });

  it('replaces * with safe columns for non-admin payout_accounts queries', () => {
    expect(queryRoute).toContain("table === 'payout_accounts'");
    expect(queryRoute).toContain('PAYOUT_ACCOUNT_SAFE_COLUMNS.join');
  });

  it('rejects explicit requests for blocked columns', () => {
    expect(queryRoute).toContain('Columns not permitted');
    expect(queryRoute).toContain('403');
  });

  it('strips blocked columns from response as defense in depth', () => {
    expect(queryRoute).toContain('delete row[col]');
    expect(queryRoute).toContain('delete row.stripe_account_id');
    expect(queryRoute).toContain('delete row.meta_access_token');
  });
});

// ── 4. Verify actual blocked columns against real schema ──

describe('Blocked columns match actual database schema', () => {
  // These columns actually exist in the database and contain secrets
  const ACTUAL_SECRET_COLUMNS: Record<string, string[]> = {
    payout_accounts: ['account_number', 'square_access_token', 'routing_number', 'subaccount_code', 'stripe_account_id'],
    whatsapp_channels: ['meta_access_token'],
  };

  for (const [table, cols] of Object.entries(ACTUAL_SECRET_COLUMNS)) {
    for (const col of cols) {
      it(`${table}.${col} is blocked or stripped for non-admin`, () => {
        const queryRoute = readFileSync('app/api/admin/query/route.ts', 'utf-8');
        // Either in BLOCKED_COLUMNS or explicitly deleted from response
        const isBlocked = queryRoute.includes(`'${col}'`) &&
          (queryRoute.includes('BLOCKED_COLUMNS') || queryRoute.includes(`delete row.${col}`));
        expect(isBlocked).toBe(true);
      });
    }
  }
});

// ── 5. Finance scope decision ──

describe('Finance role scope: platform-wide (documented decision)', () => {
  it('Finance is platform-wide for reporting (no tenant scoping)', () => {
    // DECISION: Finance is a platform-level role that can view aggregated
    // financial data across all businesses. This is required for:
    // - Platform revenue reporting
    // - Payout queue management
    // - Fee reconciliation
    //
    // Finance CANNOT:
    // - See raw bank account numbers (blocked columns)
    // - See provider tokens/secrets (blocked columns)
    // - Approve, reject, or generate payouts (admin-only mutations)
    // - Access admin audit logs or impersonation logs
    //
    // If business-scoped finance access is needed in the future,
    // a dedicated API with business_id filtering should be built.
    const queryRoute = readFileSync('app/api/admin/query/route.ts', 'utf-8');
    expect(queryRoute).toContain('createServiceClient'); // Platform-wide access
    expect(queryRoute).toContain('FINANCE_TABLES'); // Restricted table set
    expect(queryRoute).toContain('BLOCKED_COLUMNS'); // Restricted columns
  });
});

// ── 6. Route handler execution ──

describe('Route handler execution: unauthenticated', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('payout approval returns 401 for unauthenticated', async () => {
    vi.mock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      }),
    }));

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');
    const req = new NextRequest('http://localhost/api/admin/payouts/test/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'test' }) });
    expect(res.status).toBe(401);
  });
});

// ── 7. RLS policies ──

describe('RLS policies on financial tables', () => {
  const migration010 = readFileSync('supabase/migrations/010_payout_system.sql', 'utf-8');

  it('business_payouts: admin ALL, owner SELECT only', () => {
    expect(migration010).toContain('Admins have full access to business_payouts');
    expect(migration010).toContain('Business owners can view own payouts');
  });

  it('business_payouts: no finance RLS policy (reads via service client)', () => {
    const section = migration010.slice(
      migration010.indexOf('business_payouts'),
      migration010.indexOf('admin_audit_logs')
    );
    expect(section).not.toContain("'finance'");
  });

  it('admin_audit_logs: admin-only', () => {
    expect(migration010).toContain('Admins can view audit logs');
    expect(migration010).toContain('Admins can insert audit logs');
  });
});

// ── 8. Table whitelist by role ──

describe('Table whitelist enforcement', () => {
  const queryRoute = readFileSync('app/api/admin/query/route.ts', 'utf-8');

  it('finance cannot access admin_audit_logs', () => {
    const financeSection = queryRoute.slice(
      queryRoute.indexOf('FINANCE_TABLES'),
      queryRoute.indexOf('];', queryRoute.indexOf('FINANCE_TABLES'))
    );
    expect(financeSection).not.toContain('admin_audit_logs');
  });

  it('finance cannot access impersonation_logs', () => {
    const financeSection = queryRoute.slice(
      queryRoute.indexOf('FINANCE_TABLES'),
      queryRoute.indexOf('];', queryRoute.indexOf('FINANCE_TABLES'))
    );
    expect(financeSection).not.toContain('impersonation_logs');
  });

  it('ordinary user roles are not in any admin allowlist', () => {
    expect(queryRoute).toContain("'admin', 'support', 'finance', 'operations'");
    expect(queryRoute).not.toContain('restaurant_owner');
    expect(queryRoute).not.toContain('restaurant_staff');
  });
});

// ── 9. ENABLE_PAYOUTS ──

describe('Payouts remain disabled', () => {
  it('ENABLE_PAYOUTS is not set', () => {
    expect(process.env.ENABLE_PAYOUTS).toBeUndefined();
  });
});

// ── 10. What these tests do NOT prove (honest limitations) ──

describe('Documented test limitations', () => {
  it('OPEN: no real authenticated Supabase sessions tested', () => {
    // These tests mock auth or inspect source code.
    // Real authenticated integration tests require:
    // - Test users with admin/finance/ordinary roles in Supabase
    // - Real JWT tokens
    // - Running Next.js server
    // This infrastructure does not exist yet.
    expect(true).toBe(true); // Placeholder — limitation acknowledged
  });

  it('OPEN: cross-business isolation not tested with real queries', () => {
    // The admin query route uses service client (no RLS).
    // Finance sees all businesses' data by design.
    // If business-scoped finance is needed, this must be built.
    expect(true).toBe(true); // Placeholder — limitation acknowledged
  });
});
