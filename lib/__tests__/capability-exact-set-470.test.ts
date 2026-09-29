/**
 * #470 — Capability exact-set reconciliation tests.
 *
 * Proves initCapabilities converges to the intended set with fail-safe
 * write ordering: enable intended first, then disable stale.
 *
 * 1. Fresh initialization enables intended set
 * 2. Same-set retry is idempotent
 * 3. Smaller-set retry disables stale capabilities
 * 4. Larger-set retry enables additions
 * 5. Failed enable/upsert does not trigger stale cleanup
 * 6. Failed stale cleanup reports failure and remains retryable
 * 7. Unrelated businesses are untouched
 * 8. Explicit user-selected capabilities remain authoritative
 * 9. Category default/fallback behavior is unchanged
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/categoryConfig', () => ({
  getCategoryDefaultCapabilities: vi.fn().mockReturnValue(null),
}));

import { initCapabilities } from '@/lib/capabilities/service';
import { getCategoryDefaultCapabilities } from '@/lib/categoryConfig';
import type { CapabilityId } from '@/lib/capabilities/types';

const mockGetCategoryCaps = getCategoryDefaultCapabilities as ReturnType<typeof vi.fn>;

// ── Supabase mock builder ──

interface UpsertCall { rows: unknown[]; options: unknown }
interface UpdateCall { field: string; value: unknown; eqs: Record<string, unknown>; notFilter?: string }

function createMockSupabase(opts: {
  upsertError?: { message: string } | null;
  updateError?: { message: string } | null;
} = {}) {
  const upsertCalls: UpsertCall[] = [];
  const updateCalls: UpdateCall[] = [];

  const mockSupabase = {
    from: vi.fn().mockReturnValue({
      upsert: vi.fn().mockImplementation((rows: unknown[], options: unknown) => {
        upsertCalls.push({ rows, options });
        return Promise.resolve({ error: opts.upsertError || null });
      }),
      update: vi.fn().mockImplementation((fields: Record<string, unknown>) => {
        const call: UpdateCall = { field: Object.keys(fields)[0], value: Object.values(fields)[0], eqs: {} };
        updateCalls.push(call);
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
          call.eqs[col] = val;
          return chain;
        });
        chain.not = vi.fn().mockImplementation((col: string, _op: string, val: string) => {
          call.notFilter = `${col}:${val}`;
          return Promise.resolve({ error: opts.updateError || null });
        });
        return chain;
      }),
    }),
    _upsertCalls: upsertCalls,
    _updateCalls: updateCalls,
  };

  return mockSupabase;
}

describe('#470 initCapabilities — fresh initialization', () => {
  beforeEach(() => {
    mockGetCategoryCaps.mockReturnValue(null);
  });

  it('enables the intended set with upsert', async () => {
    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'shop', ['ordering', 'chat'] as CapabilityId[]);

    expect(sb._upsertCalls).toHaveLength(1);
    expect(sb._upsertCalls[0].rows).toEqual([
      { business_id: 'biz-1', capability: 'ordering', is_enabled: true },
      { business_id: 'biz-1', capability: 'chat', is_enabled: true },
    ]);
  });

  it('disables stale capabilities after enabling intended set', async () => {
    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'shop', ['ordering', 'chat'] as CapabilityId[]);

    expect(sb._updateCalls).toHaveLength(1);
    const staleCall = sb._updateCalls[0];
    expect(staleCall.field).toBe('is_enabled');
    expect(staleCall.value).toBe(false);
    expect(staleCall.eqs['business_id']).toBe('biz-1');
    expect(staleCall.eqs['is_enabled']).toBe(true);
    expect(staleCall.notFilter).toContain('ordering');
    expect(staleCall.notFilter).toContain('chat');
  });
});

describe('#470 initCapabilities — retry idempotency', () => {
  it('same-set retry is idempotent (upserts same rows, stale cleanup is no-op)', async () => {
    const sb = createMockSupabase();
    // First call
    await initCapabilities(sb as any, 'biz-1', 'shop', ['ordering', 'chat'] as CapabilityId[]);
    // Second call with same set
    await initCapabilities(sb as any, 'biz-1', 'shop', ['ordering', 'chat'] as CapabilityId[]);

    // Both calls should upsert the same rows
    expect(sb._upsertCalls).toHaveLength(2);
    expect(sb._upsertCalls[0].rows).toEqual(sb._upsertCalls[1].rows);
    // Both calls should attempt stale cleanup with same filter
    expect(sb._updateCalls).toHaveLength(2);
  });
});

describe('#470 initCapabilities — smaller-set retry disables stale', () => {
  it('stale cleanup filter excludes only the new intended set', async () => {
    const sb = createMockSupabase();
    // Retry with smaller set — only 'chat'
    await initCapabilities(sb as any, 'biz-1', 'shop', ['chat'] as CapabilityId[]);

    expect(sb._upsertCalls[0].rows).toEqual([
      { business_id: 'biz-1', capability: 'chat', is_enabled: true },
    ]);
    // Stale cleanup should only exclude 'chat' — so 'ordering' would be disabled
    const staleCall = sb._updateCalls[0];
    expect(staleCall.notFilter).toContain('chat');
    expect(staleCall.notFilter).not.toContain('ordering');
  });
});

describe('#470 initCapabilities — larger-set retry enables additions', () => {
  it('upserts the larger set including new additions', async () => {
    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'shop', ['ordering', 'chat', 'payment', 'ticketing'] as CapabilityId[]);

    expect(sb._upsertCalls[0].rows).toHaveLength(4);
    const caps = sb._upsertCalls[0].rows.map((r: any) => r.capability);
    expect(caps).toContain('ordering');
    expect(caps).toContain('chat');
    expect(caps).toContain('payment');
    expect(caps).toContain('ticketing');
    // Stale cleanup excludes all 4
    expect(sb._updateCalls[0].notFilter).toContain('ordering');
    expect(sb._updateCalls[0].notFilter).toContain('ticketing');
  });
});

describe('#470 initCapabilities — failed enable does NOT trigger stale cleanup', () => {
  it('throws on upsert failure without running stale disable', async () => {
    const sb = createMockSupabase({ upsertError: { message: 'upsert failed' } });

    await expect(
      initCapabilities(sb as any, 'biz-1', 'shop', ['ordering'] as CapabilityId[]),
    ).rejects.toThrow('Capability initialization failed: upsert failed');

    // Stale cleanup must NOT have been attempted
    expect(sb._updateCalls).toHaveLength(0);
  });
});

describe('#470 initCapabilities — failed stale cleanup reports failure truthfully', () => {
  it('throws on stale cleanup failure (intended set is already enabled)', async () => {
    const sb = createMockSupabase({ updateError: { message: 'cleanup failed' } });

    await expect(
      initCapabilities(sb as any, 'biz-1', 'shop', ['ordering'] as CapabilityId[]),
    ).rejects.toThrow('Capability stale cleanup failed (intended set is enabled): cleanup failed');

    // Enable step DID succeed
    expect(sb._upsertCalls).toHaveLength(1);
    // Stale cleanup was attempted but failed
    expect(sb._updateCalls).toHaveLength(1);
  });

  it('remains retryable after stale cleanup failure', async () => {
    // First call: cleanup fails
    const sb1 = createMockSupabase({ updateError: { message: 'cleanup failed' } });
    await expect(
      initCapabilities(sb1 as any, 'biz-1', 'shop', ['ordering'] as CapabilityId[]),
    ).rejects.toThrow();

    // Retry: cleanup succeeds — function should succeed
    const sb2 = createMockSupabase();
    await expect(
      initCapabilities(sb2 as any, 'biz-1', 'shop', ['ordering'] as CapabilityId[]),
    ).resolves.toBeUndefined();
  });
});

describe('#470 initCapabilities — unrelated businesses untouched', () => {
  it('all queries are scoped to the specified business_id', async () => {
    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-target', 'shop', ['ordering'] as CapabilityId[]);

    // Upsert rows must all have business_id = 'biz-target'
    for (const row of sb._upsertCalls[0].rows as Array<{ business_id: string }>) {
      expect(row.business_id).toBe('biz-target');
    }
    // Stale cleanup must filter by business_id = 'biz-target'
    expect(sb._updateCalls[0].eqs['business_id']).toBe('biz-target');
  });
});

describe('#470 initCapabilities — explicit user selections authoritative', () => {
  it('overrides take priority over category defaults', async () => {
    mockGetCategoryCaps.mockReturnValue(['ordering', 'feedback', 'loyalty', 'chat', 'referral']);

    const sb = createMockSupabase();
    const userSelected: CapabilityId[] = ['appointment', 'payment', 'chat'];
    await initCapabilities(sb as any, 'biz-1', 'shop', userSelected);

    const caps = sb._upsertCalls[0].rows.map((r: any) => r.capability);
    expect(caps).toEqual(['appointment', 'payment', 'chat']);
    expect(caps).not.toContain('ordering');
    expect(caps).not.toContain('feedback');
  });
});

describe('#470 initCapabilities — category default/fallback behavior unchanged', () => {
  it('uses DB category defaults when no overrides provided', async () => {
    mockGetCategoryCaps.mockReturnValue(['ordering', 'feedback', 'loyalty', 'chat', 'referral']);

    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'shop');

    const caps = sb._upsertCalls[0].rows.map((r: any) => r.capability);
    expect(caps).toEqual(['ordering', 'feedback', 'loyalty', 'chat', 'referral']);
  });

  it('falls back to hardcoded defaults when DB returns null', async () => {
    mockGetCategoryCaps.mockReturnValue(null);

    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'shop');

    const caps = sb._upsertCalls[0].rows.map((r: any) => r.capability);
    // CATEGORY_DEFAULT_CAPABILITIES['shop'] = ['ordering', 'payment', 'feedback', 'chat', 'broadcast']
    expect(caps).toEqual(['ordering', 'payment', 'feedback', 'chat', 'broadcast']);
  });

  it('falls back to scheduling when category is unknown', async () => {
    mockGetCategoryCaps.mockReturnValue(null);

    const sb = createMockSupabase();
    await initCapabilities(sb as any, 'biz-1', 'unknown_category_xyz');

    const caps = sb._upsertCalls[0].rows.map((r: any) => r.capability);
    expect(caps).toEqual(['scheduling']);
  });
});
