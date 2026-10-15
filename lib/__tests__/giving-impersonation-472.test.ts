/**
 * #472 — Giving page impersonation read-only guard + API 403 quality
 *
 * Tests:
 * - API: owner create succeeds, unauth → 401, non-owner → 403 with message
 * - API: recurring/tier/service-type guards still work
 * - DashboardProvider: isImpersonating reaches context
 * - Giving page: write controls disabled during impersonation
 * - Giving page: normal owner flow unchanged
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';

// ══════════════════════════════════════════════════════════════
// 1. API route tests (mocked Supabase)
// ══════════════════════════════════════════════════════════════

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [] }),
}));

vi.mock('@/lib/capabilities/policy', () => ({
  getEffectiveCapabilities: vi.fn().mockReturnValue({
    effective: [],
    selected: [],
    paused: [],
    blocked: [],
    disabled: [],
  }),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialCredit: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/services/payload-builders', () => ({
  buildGivingServicePayload: vi.fn().mockReturnValue({
    business_id: 'biz-1',
    name: 'Tithe',
    service_type: 'giving',
    price: 0,
    price_is_variable: true,
    billing_type: 'one_time',
    recurring_interval: null,
  }),
}));

const OWNER_ID = 'owner-user-111';
const ADMIN_ID = 'admin-user-222';
const BIZ_ID = 'biz-aaa-bbb';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest(new URL('http://localhost:3000/api/giving/save'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupOwner() {
  mockGetUser.mockResolvedValue({ data: { user: { id: OWNER_ID } } });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: BIZ_ID,
                owner_id: OWNER_ID,
                recurring_enabled: false,
                subscription_tier: 'free',
                trial_ends_at: null,
                capability_overrides: [],
              },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'services') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            }),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
      };
    }
    return {};
  });
}

function setupAdmin() {
  mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({
              data: {
                id: BIZ_ID,
                owner_id: OWNER_ID, // admin does NOT own this business
                recurring_enabled: false,
                subscription_tier: 'free',
                trial_ends_at: null,
                capability_overrides: [],
              },
              error: null,
            }),
          }),
        }),
      };
    }
    return {};
  });
}

function setupUnauthenticated() {
  mockGetUser.mockResolvedValue({ data: { user: null } });
}

const VALID_PAYLOAD = {
  businessId: BIZ_ID,
  name: 'Tithe',
  description: 'Weekly tithe',
  fixedAmount: false,
  price: 0,
  isRecurring: false,
  interval: 'monthly',
};

describe('POST /api/giving/save', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function postGiving(body: Record<string, unknown>) {
    const { POST } = await import('@/app/api/giving/save/route');
    return POST(makeRequest(body));
  }

  it('owner creates one-time giving category → 200', async () => {
    setupOwner();
    const res = await postGiving(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('unauthenticated → 401', async () => {
    setupUnauthenticated();
    const res = await postGiving(VALID_PAYLOAD);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.reason).toBe('unauthorized');
  });

  it('non-owner/admin → 403 with message field', async () => {
    setupAdmin();
    const res = await postGiving(VALID_PAYLOAD);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe('unauthorized');
    expect(json.message).toBe('You do not have write access to this business.');
  });

  it('403 response includes success: false', async () => {
    setupAdmin();
    const res = await postGiving(VALID_PAYLOAD);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('missing required fields → 400', async () => {
    setupOwner();
    const res = await postGiving({ businessId: BIZ_ID });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('missing_required_fields');
  });

  it('recurring requested with recurring_enabled=false → 400', async () => {
    setupOwner();
    const res = await postGiving({ ...VALID_PAYLOAD, isRecurring: true });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('recurring_not_enabled');
    expect(json.message).toContain('Recurring Payments');
  });

  it('owner can update existing giving service', async () => {
    setupOwner();
    // Override services mock for update path
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: BIZ_ID, owner_id: OWNER_ID, recurring_enabled: false,
                  subscription_tier: 'free', trial_ends_at: null, capability_overrides: [],
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'services') {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    select: () => ({
                      maybeSingle: () => Promise.resolve({ data: { id: 'svc-1' }, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const res = await postGiving({ ...VALID_PAYLOAD, serviceId: 'svc-1' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  it('update on non-giving service → 404', async () => {
    setupOwner();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: BIZ_ID, owner_id: OWNER_ID, recurring_enabled: false,
                  subscription_tier: 'free', trial_ends_at: null, capability_overrides: [],
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'services') {
        return {
          update: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    select: () => ({
                      maybeSingle: () => Promise.resolve({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {};
    });

    const res = await postGiving({ ...VALID_PAYLOAD, serviceId: 'wrong-svc' });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.reason).toBe('service_not_found');
  });
});

// ══════════════════════════════════════════════════════════════
// 2. DashboardProvider isImpersonating context
// ══════════════════════════════════════════════════════════════

describe('DashboardProvider isImpersonating', () => {
  it('exposes isImpersonating in the context type', () => {
    const src = readFileSync(join(process.cwd(), 'components/dashboard/DashboardProvider.tsx'), 'utf-8');
    // Context type includes isImpersonating
    expect(src).toMatch(/interface DashboardContextType[\s\S]*?isImpersonating:\s*boolean/);
    // Provider accepts isImpersonating prop
    expect(src).toMatch(/isImpersonating\s*[=?:]/);
    // Value is passed to context
    expect(src).toContain('isImpersonating');
  });

  it('defaults isImpersonating to false', () => {
    const src = readFileSync(join(process.cwd(), 'components/dashboard/DashboardProvider.tsx'), 'utf-8');
    expect(src).toMatch(/isImpersonating\s*=\s*false/);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Dashboard layout passes isImpersonating
// ══════════════════════════════════════════════════════════════

describe('Dashboard layout impersonation plumbing', () => {
  const src = readFileSync(join(process.cwd(), 'app/dashboard/layout.tsx'), 'utf-8');

  it('passes isImpersonating to DashboardProvider in impersonation path', () => {
    // The impersonation branch should pass isImpersonating (or isImpersonating={true})
    expect(src).toMatch(/DashboardProvider[^>]*isImpersonating/);
  });

  it('normal (non-impersonation) path does NOT set isImpersonating', () => {
    // The normal path's DashboardProvider should not have isImpersonating={true}
    // It may omit it entirely (defaults to false) or set it to false
    // Find the normal-path DashboardProvider — it's the one with allBusinesses prop
    const normalProviderMatch = src.match(/DashboardProvider[^>]*allBusinesses/);
    expect(normalProviderMatch).toBeTruthy();
    // The normal path provider should not have isImpersonating (it defaults to false)
    const normalLine = normalProviderMatch![0];
    expect(normalLine).not.toContain('isImpersonating');
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Giving page impersonation guards
// ══════════════════════════════════════════════════════════════

describe('Giving page impersonation UI guards', () => {
  const src = readFileSync(join(process.cwd(), 'app/dashboard/giving/page.tsx'), 'utf-8');

  it('imports useDashboard for impersonation state', () => {
    expect(src).toMatch(/useDashboard/);
  });

  it('reads isImpersonating from dashboard context', () => {
    expect(src).toMatch(/isImpersonating.*useDashboard|useDashboard[\s\S]*?isImpersonating/);
  });

  it('shows read-only banner when impersonating', () => {
    expect(src).toContain('admin impersonation');
    expect(src).toContain('Sign in as the business owner');
  });

  it('disables save button when impersonating', () => {
    expect(src).toMatch(/disabled=\{[^}]*isImpersonating/);
  });

  it('hides Add Giving Category button when impersonating', () => {
    // The list view Add button is wrapped in {!isImpersonating && ...}
    expect(src).toMatch(/!isImpersonating[\s\S]*?Add Giving Category/);
  });

  it('hides toggle/edit/delete controls when impersonating', () => {
    // The control buttons are wrapped in {!isImpersonating && ...}
    expect(src).toMatch(/!isImpersonating[\s\S]*?handleToggleActive/);
    expect(src).toMatch(/!isImpersonating[\s\S]*?handleEdit/);
    expect(src).toMatch(/!isImpersonating[\s\S]*?handleDelete/);
  });

  it('preserves normal owner flow — controls visible without impersonation guard fallback', () => {
    // The controls exist and are only hidden by the isImpersonating condition
    // (not removed entirely)
    expect(src).toContain('handleToggleActive');
    expect(src).toContain('handleEdit');
    expect(src).toContain('handleDelete');
    expect(src).toContain('handleSave');
  });
});

// ══════════════════════════════════════════════════════════════
// 5. API 403 response quality
// ══════════════════════════════════════════════════════════════

describe('Giving API 403 response quality', () => {
  it('403 response includes message field in route source', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/giving/save/route.ts'), 'utf-8');
    // The 403 for unauthorized should include a message
    expect(src).toMatch(/reason:\s*'unauthorized'[\s\S]*?message:/);
    expect(src).toContain('You do not have write access to this business.');
  });

  it('403 response preserves reason: unauthorized and status 403', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/giving/save/route.ts'), 'utf-8');
    expect(src).toMatch(/reason:\s*'unauthorized'/);
    expect(src).toMatch(/status:\s*403/);
  });
});
