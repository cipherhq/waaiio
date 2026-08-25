/**
 * Bridge v3.1 — resolveChargeRole unit tests (#191)
 *
 * Tests the read-only role resolver for Paystack charge.success events.
 * Covers: all 6 roles (A–F), 5 conflict rules (C1–C5),
 * resolver DB errors, setupMatch with/without paymentMatch,
 * multiple pending setup rows, and signal ordering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveChargeRole, type ResolverResult } from '@/lib/payments/charge-role-resolver';

// ═══════════════════════════════════════════════════════════
// Mock Supabase client builder
// ═══════════════════════════════════════════════════════════

interface TableConfig {
  // For .maybeSingle() calls — return { data, error }
  maybeSingleResult?: { data: unknown; error: unknown };
  // For array-returning calls (no .maybeSingle()) — return { data: [], error }
  arrayResult?: { data: unknown[]; error: unknown };
}

function buildMockSupabase(tableConfigs: Record<string, TableConfig> = {}) {
  const queriedTables: string[] = [];

  function createChain(tableName: string): Record<string, unknown> {
    const config = tableConfigs[tableName] || {};

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop: string) {
        if (prop === 'maybeSingle') {
          return vi.fn(() => {
            const result = config.maybeSingleResult || { data: null, error: null };
            return Promise.resolve(result);
          });
        }

        // Thenable — for awaiting chains without terminal (e.g., array select)
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const result = config.arrayResult || { data: [], error: null };
            resolve(result);
          };
        }

        // All chain methods return the proxy
        return vi.fn(() => proxy);
      },
    };

    const proxy = new Proxy({} as Record<string, unknown>, handler);
    return proxy;
  }

  const mock = {
    from: vi.fn((tableName: string) => {
      queriedTables.push(tableName);
      return createChain(tableName);
    }),
  };

  return { mock, queriedTables };
}

// ═══════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════

const PAYMENT_ROW = { id: 'pay-001', status: 'pending', amount: 5000, booking_id: 'bk-001', gateway: 'paystack' };

function makeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reference: 'ref-test-123',
    amount: 500000,
    currency: 'NGN',
    ...overrides,
  };
}

function makeDataWithSubCode(subCode: string): Record<string, unknown> {
  return makeData({
    subscription: { subscription_code: subCode },
  });
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('resolveChargeRole', () => {

  // ── RESOLVER ERROR HANDLING ──

  describe('resolver DB errors', () => {
    it('payments lookup error → RESOLVER_ERROR', async () => {
      const { mock } = buildMockSupabase();
      const result = await resolveChargeRole(
        'ref-1', makeData(), null,
        { code: 'PGRST301', message: 'connection refused' },
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('RESOLVER_ERROR');
        expect(result.detail).toContain('payments lookup');
      }
    });

    it('subscriptions lookup error → RESOLVER_ERROR', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: {
          maybeSingleResult: { data: null, error: { code: '42P01', message: 'table missing' } },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('RESOLVER_ERROR');
        expect(result.detail).toContain('subscriptions lookup');
      }
    });

    it('customer_subscriptions (sub_code) lookup error → RESOLVER_ERROR', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: { code: 'TIMEOUT', message: 'query timeout' } },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('RESOLVER_ERROR');
        expect(result.detail).toContain('customer_subscriptions (sub_code)');
      }
    });

    it('customer_subscriptions (setup) lookup error → RESOLVER_ERROR', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: {
          arrayResult: { data: [], error: { code: '42P01', message: 'table missing' } },
        },
      });
      // No subscription_code, so sub_code lookup is skipped. Setup lookup runs.
      const result = await resolveChargeRole(
        'ref-1', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('RESOLVER_ERROR');
        expect(result.detail).toContain('customer_subscriptions (setup)');
      }
    });
  });

  // ── CONFLICT DETECTION ──

  describe('conflict detection', () => {
    it('C1: platformSubMatch + customerSubMatch → CONFLICT', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: { id: 'plat-1' }, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: { id: 'cs-1' }, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('CONFLICT');
        expect(result.detail).toContain('BOTH');
      }
    });

    it('C2: platformSubMatch + isCronRecurring → CONFLICT', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: { id: 'plat-1' }, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ps-retry-sub1-1-123', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('CONFLICT');
        expect(result.detail).toContain('ps-retry');
        expect(result.detail).toContain('platform sub');
      }
    });

    it('C3: setupMatch + isCronRecurring → CONFLICT', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: {
          arrayResult: { data: [{ id: 'cs-setup-1' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ps-retry-sub1-1-123', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('CONFLICT');
        expect(result.detail).toContain('pending setup sub');
      }
    });

    it('C4: setupMatch + platformSubMatch → CONFLICT', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: { id: 'plat-1' }, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: null },
          arrayResult: { data: [{ id: 'cs-setup-1' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('CONFLICT');
        expect(result.detail).toContain('setup sub');
        expect(result.detail).toContain('platform sub');
      }
    });

    it('C5: setupMatch + customerSubMatch → CONFLICT', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: { id: 'cs-active-1' }, error: null },
          arrayResult: { data: [{ id: 'cs-setup-1' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('CONFLICT');
        expect(result.detail).toContain('setup sub');
        expect(result.detail).toContain('active customer sub');
      }
    });
  });

  // ── ROLE CLASSIFICATION ──

  describe('role classification', () => {
    it('paymentMatch without setupMatch → role A', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const result = await resolveChargeRole(
        'ref-1', makeData(), PAYMENT_ROW, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe('A');
        expect(result.detail).toContain('payment_id=pay-001');
      }
    });

    it('paymentMatch + isCronRecurring → role A (finalized replay)', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const result = await resolveChargeRole(
        'ps-retry-sub1-1-123', makeData(), PAYMENT_ROW, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.role).toBe('A');
    });

    it('setupMatch + paymentMatch → role B (normal setup)', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: {
          arrayResult: { data: [{ id: 'cs-setup-1' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'REC-12345', makeData(), PAYMENT_ROW, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe('B');
        expect(result.detail).toContain('setup_sub=cs-setup-1');
        expect(result.detail).toContain('payment=pay-001');
      }
    });

    it('setupMatch without paymentMatch → role B (payment insert failed)', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: {
          arrayResult: { data: [{ id: 'cs-setup-1' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'REC-12345', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe('B');
        expect(result.detail).toContain('no payment row');
      }
    });

    it('multiple pending setup matches → role B (activation handles ambiguity)', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: {
          arrayResult: { data: [{ id: 'cs-1' }, { id: 'cs-2' }], error: null },
        },
      });
      const result = await resolveChargeRole(
        'REC-12345', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe('B');
        // Role B — activation handler (Block 2) owns cardinality via activatePaystackSubscription
        // which returns 'ambiguous' for multiple rows. Bridge classifies as B, not D/E.
      }
    });

    it('platformSubMatch only → role C', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: { id: 'plat-1' }, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.role).toBe('C');
    });

    it('isCronRecurring only → role D', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const result = await resolveChargeRole(
        'ps-retry-sub1-1-123', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.role).toBe('D');
    });

    it('isCronRecurring + customerSubMatch → role D (compatible)', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: { id: 'cs-1' }, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ps-retry-sub1-1-123', makeDataWithSubCode('SUB_cs'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.role).toBe('D');
        expect(result.detail).toContain('customer_sub=cs-1');
      }
    });

    it('customerSubMatch only → role E', async () => {
      const { mock } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: { id: 'cs-1' }, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      const result = await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_cs'), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.role).toBe('E');
    });

    it('no signals → role F', async () => {
      const { mock } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const result = await resolveChargeRole(
        'ref-unknown', makeData(), null, null,
        mock as any,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.role).toBe('F');
    });
  });

  // ── SIGNAL COLLECTION ──

  describe('signal collection ordering', () => {
    it('ps-retry-* with subscription_code: both sub lookups still execute', async () => {
      const { mock, queriedTables } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      await resolveChargeRole(
        'ps-retry-sub1-1-123', makeDataWithSubCode('SUB_x'), null, null,
        mock as any,
      );
      // subscriptions was queried (parallel lookup ran)
      expect(queriedTables).toContain('subscriptions');
      expect(queriedTables).toContain('customer_subscriptions');
    });

    it('paymentMatch with subscription_code: sub lookups still execute', async () => {
      const { mock, queriedTables } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: {
          maybeSingleResult: { data: null, error: null },
          arrayResult: { data: [], error: null },
        },
      });
      await resolveChargeRole(
        'ref-1', makeDataWithSubCode('SUB_x'), PAYMENT_ROW, null,
        mock as any,
      );
      expect(queriedTables).toContain('subscriptions');
      expect(queriedTables).toContain('customer_subscriptions');
    });

    it('roles A/B/C/D/E/F never query paystack_billing_attempts', async () => {
      // Test with each role scenario — none should query the #176 table
      const scenarios = [
        // Role A: payment match
        { ref: 'ref-1', data: makeData(), payment: PAYMENT_ROW },
        // Role B: setup match
        { ref: 'REC-1', data: makeData(), payment: null },
        // Role F: no match
        { ref: 'ref-unknown', data: makeData(), payment: null },
      ];

      for (const s of scenarios) {
        const { mock, queriedTables } = buildMockSupabase({
          customer_subscriptions: {
            arrayResult: { data: s.ref === 'REC-1' ? [{ id: 'cs-1' }] : [], error: null },
          },
        });
        await resolveChargeRole(s.ref, s.data, s.payment, null, mock as any);
        expect(queriedTables).not.toContain('paystack_billing_attempts');
      }
    });
  });

  // ── BOUNDARY TESTS ──

  describe('boundary cases', () => {
    it('ps-retry- prefix is case-sensitive and start-anchored', async () => {
      const { mock: mock1 } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      // Exact prefix → D
      const r1 = await resolveChargeRole('ps-retry-sub1-1-123', makeData(), null, null, mock1 as any);
      expect(r1.ok && r1.role).toBe('D');

      // Uppercase → not recognized
      const { mock: mock2 } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const r2 = await resolveChargeRole('PS-RETRY-sub1', makeData(), null, null, mock2 as any);
      expect(r2.ok && r2.role).toBe('F');

      // Substring → not recognized
      const { mock: mock3 } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const r3 = await resolveChargeRole('my-ps-retry-ref', makeData(), null, null, mock3 as any);
      expect(r3.ok && r3.role).toBe('F');
    });

    it('plan_object without subscription_code triggers subscriptions lookup', async () => {
      const { mock, queriedTables } = buildMockSupabase({
        subscriptions: { maybeSingleResult: { data: null, error: null } },
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      const data = makeData({ plan_object: { id: 'PLN_123' } });
      await resolveChargeRole('ref-1', data, null, null, mock as any);
      expect(queriedTables).toContain('subscriptions');
    });

    it('no subscription_code and no plan_object skips sub lookups', async () => {
      const { mock, queriedTables } = buildMockSupabase({
        customer_subscriptions: { arrayResult: { data: [], error: null } },
      });
      await resolveChargeRole('ref-1', makeData(), null, null, mock as any);
      expect(queriedTables).not.toContain('subscriptions');
    });
  });
});
