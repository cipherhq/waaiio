/**
 * PR #655 — Actionable-first pagination for admin onboarding queue.
 *
 * Proves:
 * 1. More than 1000 actionable records are all returned (no PostgREST cap)
 * 2. No duplicates in the combined result
 * 3. Terminal records (active/cancelled/completed) are excluded from
 *    actionable query and bounded to 100 in the terminal query
 * 4. Page boundary records are not lost
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  serviceClient: vi.fn(),
}));

vi.mock('@/lib/admin-auth', () => ({ requirePlatformAdmin: mocks.authorize }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.serviceClient }));

function makeRow(id: number, status: string) {
  return {
    id: `onb-${id}`,
    target_email: `user${id}@test.com`,
    business_id: null,
    status,
    created_at: new Date(2026, 0, 1, 0, 0, id).toISOString(),
  };
}

const ADMIN = { id: 'admin-1', userId: 'admin-1', email: 'admin@test.com', role: 'admin', aal: 'aal2', bearerToken: 'bearer' };

describe('PR #655: admin onboarding queue pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(ADMIN);
  });

  it('retrieves all 1500 actionable records via pagination (no PostgREST cap)', async () => {
    // Generate 1500 actionable rows (status='customer_action_required')
    const allActionable = Array.from({ length: 1500 }, (_, i) =>
      makeRow(i, 'customer_action_required'),
    );

    // Terminal rows (should be separate)
    const terminalRows = Array.from({ length: 5 }, (_, i) =>
      makeRow(10000 + i, 'active'),
    );

    // Countries and categories
    const countries = [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }];
    const categories = [{ key: 'restaurant', name: 'Restaurant' }];

    let actionableCallCount = 0;
    const PAGE_SIZE = 1000;

    const from = vi.fn((table: string) => {
      if (table === 'admin_onboarding_invites') {
        return {
          select: () => ({
            not: () => {
              const orderChain: Record<string, unknown> = {};
              orderChain.order = () => orderChain; // chainable for secondary sort
              orderChain.range = (fromIdx: number, toIdx: number) => {
                actionableCallCount++;
                const page = allActionable.slice(fromIdx, toIdx + 1);
                return Promise.resolve({ data: page, error: null });
              };
              return { order: () => orderChain };
            },
            in: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: terminalRows, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'countries') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: countries, error: null }),
            }),
          }),
        };
      }
      if (table === 'category_templates') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: categories, error: null }),
            }),
          }),
        };
      }
      // Default for businesses/channels enrichment
      return {
        select: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      };
    });

    mocks.serviceClient.mockReturnValue({ from });

    const { GET } = await import('@/app/api/admin/onboarding/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/onboarding'));
    expect(res.status).toBe(200);

    const body = await res.json();
    const onboardings = body.onboardings as Array<{ id: string; status: string }>;

    // All 1500 actionable + 5 terminal = 1505 total
    expect(onboardings.length).toBe(1505);

    // Pagination required 2 pages (1000 + 500)
    expect(actionableCallCount).toBe(2);

    // No duplicates
    const ids = onboardings.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    // All actionable records present
    const actionableIds = onboardings
      .filter(r => r.status === 'customer_action_required')
      .map(r => r.id);
    expect(actionableIds.length).toBe(1500);

    // Terminal records present
    const terminalIds = onboardings
      .filter(r => r.status === 'active')
      .map(r => r.id);
    expect(terminalIds.length).toBe(5);
  });

  it('returns a single page when fewer than 1000 actionable records', async () => {
    const actionable = Array.from({ length: 50 }, (_, i) =>
      makeRow(i, 'provisioning'),
    );

    let actionableCallCount = 0;

    const from = vi.fn((table: string) => {
      if (table === 'admin_onboarding_invites') {
        return {
          select: () => ({
            not: () => {
              const orderChain: Record<string, unknown> = {};
              orderChain.order = () => orderChain;
              orderChain.range = () => {
                actionableCallCount++;
                return Promise.resolve({ data: actionable, error: null });
              };
              return { order: () => orderChain };
            },
            in: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'countries') {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      if (table === 'category_templates') {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
    });

    mocks.serviceClient.mockReturnValue({ from });

    const { GET } = await import('@/app/api/admin/onboarding/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/onboarding'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.onboardings.length).toBe(50);
    // Only 1 page needed
    expect(actionableCallCount).toBe(1);
  });

  it('does not include terminal statuses in actionable results', async () => {
    // The .not() filter excludes active/cancelled/completed
    // This test verifies the structural contract
    const { readFileSync } = await import('fs');
    const source = readFileSync('app/api/admin/onboarding/route.ts', 'utf8');
    // Actionable query excludes terminal statuses
    expect(source).toContain('.not(\'status\', \'in\', \'("active","cancelled","completed")\')');
    // Terminal query selects only terminal statuses
    expect(source).toContain('.in(\'status\', [\'active\', \'cancelled\', \'completed\'])');
    // Terminal is bounded
    expect(source).toContain('.limit(100)');
    // Pagination uses .range()
    expect(source).toContain('.range(from, to)');
    // Deterministic ordering: secondary key prevents lost/duplicated rows
    // when created_at values are identical across a page boundary
    expect(source).toContain(".order('id', { ascending: false })");
  });

  it('identical created_at across page boundary: no lost or duplicated records', async () => {
    // 1002 records with the SAME timestamp. Without a secondary sort key,
    // rows 999-1001 could appear on both pages or be skipped entirely.
    const SAME_TS = '2026-06-15T12:00:00.000Z';
    const allRows = Array.from({ length: 1002 }, (_, i) => ({
      id: `onb-dup-${String(i).padStart(4, '0')}`,
      target_email: `dup${i}@test.com`,
      business_id: null,
      status: 'customer_action_required',
      created_at: SAME_TS,
    }));

    // Simulate server-side deterministic ordering by id DESC.
    // The mock returns rows pre-sorted, as PostgREST would with the
    // ORDER BY created_at DESC, id DESC clause.
    const sorted = [...allRows].sort((a, b) => b.id.localeCompare(a.id));

    let callCount = 0;
    const PAGE_SIZE = 1000;

    const from = vi.fn((table: string) => {
      if (table === 'admin_onboarding_invites') {
        return {
          select: () => ({
            not: () => {
              const chain: Record<string, unknown> = {};
              chain.order = () => chain;
              chain.range = (fromIdx: number, toIdx: number) => {
                callCount++;
                return Promise.resolve({ data: sorted.slice(fromIdx, toIdx + 1), error: null });
              };
              return { order: () => chain };
            },
            in: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'countries') {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      if (table === 'category_templates') {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      return { select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) };
    });

    mocks.serviceClient.mockReturnValue({ from });

    const { GET } = await import('@/app/api/admin/onboarding/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/onboarding'));
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = (body.onboardings as Array<{ id: string }>).map(r => r.id);

    // All 1002 records present — none lost at the page boundary
    expect(ids.length).toBe(1002);
    // No duplicates
    expect(new Set(ids).size).toBe(1002);
    // 2 pages fetched
    expect(callCount).toBe(2);
  });
});
