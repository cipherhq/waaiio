/**
 * Issue #249 — Catalog Safety Guard Tests
 *
 * Verifies that catalog sync operations are blocked for businesses on shared
 * WhatsApp channels and only proceed for businesses with dedicated channels.
 * The guard must be checked BEFORE any Meta API call is made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertDedicatedCatalogAccess } from '../catalog';

// ── Logger mock ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Supabase mock helpers ──
function chain(finalData: { data: unknown; error?: unknown }) {
  const c: Record<string, any> = {};
  ['select', 'eq', 'maybeSingle'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c))
  );
  c.maybeSingle = vi.fn().mockResolvedValue(finalData);
  return c;
}

function makeSupabase(channelResult: { data: unknown; error?: unknown }) {
  const fromChain = chain(channelResult);
  return {
    from: vi.fn().mockReturnValue(fromChain),
    _chain: fromChain,
  } as any;
}

describe('assertDedicatedCatalogAccess', () => {
  const BUSINESS_ID = 'biz-111';
  const DEDICATED_CHANNEL = {
    id: 'ch-1',
    channel_type: 'dedicated',
    business_id: BUSINESS_ID,
    waba_id: 'dedicated-waba-999',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.META_CLOUD_WABA_ID;
  });

  it('allows access for business with dedicated channel', async () => {
    const supabase = makeSupabase({ data: DEDICATED_CHANNEL });
    const result = await assertDedicatedCatalogAccess(supabase, BUSINESS_ID);
    expect(result).toBeNull();
  });

  it('blocks access when no channel exists (fail closed)', async () => {
    const supabase = makeSupabase({ data: null });
    const result = await assertDedicatedCatalogAccess(supabase, BUSINESS_ID);
    expect(result).toBe('Catalog sync requires a dedicated WhatsApp channel');
  });

  it('blocks access when dedicated channel waba_id matches platform WABA', async () => {
    process.env.META_CLOUD_WABA_ID = 'platform-waba-shared';
    const channel = { ...DEDICATED_CHANNEL, waba_id: 'platform-waba-shared' };
    const supabase = makeSupabase({ data: channel });
    const result = await assertDedicatedCatalogAccess(supabase, BUSINESS_ID);
    expect(result).toBe('Catalog sync requires a dedicated WhatsApp channel');
  });

  it('queries for dedicated channel_type specifically', async () => {
    const supabase = makeSupabase({ data: null });
    await assertDedicatedCatalogAccess(supabase, BUSINESS_ID);

    // Verify the query chain includes channel_type = 'dedicated'
    const fromChain = supabase._chain;
    const eqCalls = fromChain.eq.mock.calls;
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['business_id', BUSINESS_ID],
        ['channel_type', 'dedicated'],
        ['provider', 'meta_cloud'],
        ['is_active', true],
      ])
    );
  });

  it('does not fall back to platform WABA for businesses without a channel', async () => {
    // Even if META_CLOUD_WABA_ID is set, guard must block
    process.env.META_CLOUD_WABA_ID = 'platform-waba-shared';
    const supabase = makeSupabase({ data: null });
    const result = await assertDedicatedCatalogAccess(supabase, BUSINESS_ID);
    expect(result).toBe('Catalog sync requires a dedicated WhatsApp channel');
  });
});

describe('Catalog sync route guards (structural)', () => {
  // These tests verify that the guard is called BEFORE any CatalogService
  // instantiation or Meta API calls, by reading the source code.
  const { readFileSync } = require('fs');
  const { resolve } = require('path');

  const syncRouteCode = readFileSync(
    resolve(__dirname, '../../../app/api/catalog/sync/route.ts'),
    'utf-8'
  );
  const cronRouteCode = readFileSync(
    resolve(__dirname, '../../../app/api/cron/catalog-sync/route.ts'),
    'utf-8'
  );

  it('manual sync route imports assertDedicatedCatalogAccess', () => {
    expect(syncRouteCode).toContain('assertDedicatedCatalogAccess');
  });

  it('cron route imports assertDedicatedCatalogAccess', () => {
    expect(cronRouteCode).toContain('assertDedicatedCatalogAccess');
  });

  it('manual sync route calls guard before CatalogService instantiation', () => {
    const guardPos = syncRouteCode.indexOf('assertDedicatedCatalogAccess(');
    const servicePos = syncRouteCode.indexOf('new CatalogService(');
    expect(guardPos).toBeGreaterThan(-1);
    expect(servicePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(servicePos);
  });

  it('cron route calls guard before CatalogService instantiation', () => {
    const guardPos = cronRouteCode.indexOf('assertDedicatedCatalogAccess(');
    const servicePos = cronRouteCode.indexOf('new CatalogService(');
    expect(guardPos).toBeGreaterThan(-1);
    expect(servicePos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(servicePos);
  });

  it('manual sync route does NOT fall back to env var for access token', () => {
    // After guard, the route should use channel credentials directly,
    // not fall back to META_CLOUD_ACCESS_TOKEN
    const afterGuard = syncRouteCode.slice(
      syncRouteCode.indexOf('assertDedicatedCatalogAccess(')
    );
    expect(afterGuard).not.toContain('|| process.env.META_CLOUD_ACCESS_TOKEN');
  });

  it('cron route does NOT fall back to env var for access token', () => {
    const afterGuard = cronRouteCode.slice(
      cronRouteCode.indexOf('assertDedicatedCatalogAccess(')
    );
    expect(afterGuard).not.toContain('|| process.env.META_CLOUD_ACCESS_TOKEN');
  });

  it('manual sync route queries with channel_type=dedicated after guard', () => {
    const afterGuard = syncRouteCode.slice(
      syncRouteCode.indexOf('assertDedicatedCatalogAccess(')
    );
    expect(afterGuard).toContain("'dedicated'");
  });

  it('cron route queries with channel_type=dedicated after guard', () => {
    const afterGuard = cronRouteCode.slice(
      cronRouteCode.indexOf('assertDedicatedCatalogAccess(')
    );
    expect(afterGuard).toContain("'dedicated'");
  });
});

describe('Cross-business isolation', () => {
  it('business A (shared) cannot trigger catalog ops even if business B (dedicated) exists', async () => {
    const BUSINESS_A = 'biz-shared-A';
    const BUSINESS_B = 'biz-dedicated-B';

    // Supabase returns null for business A (no dedicated channel)
    const supabaseA = makeSupabase({ data: null });
    const resultA = await assertDedicatedCatalogAccess(supabaseA, BUSINESS_A);
    expect(resultA).toBe('Catalog sync requires a dedicated WhatsApp channel');

    // Verify the query was scoped to business A, not B
    const eqCalls = supabaseA._chain.eq.mock.calls;
    expect(eqCalls).toEqual(
      expect.arrayContaining([['business_id', BUSINESS_A]])
    );
    expect(eqCalls).not.toEqual(
      expect.arrayContaining([['business_id', BUSINESS_B]])
    );
  });
});
