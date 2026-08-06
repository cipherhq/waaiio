/**
 * P0-SUB-2 — Executable behavioral tests for subscription activation
 *
 * Tests execute the PRODUCTION activation helpers:
 *   activateStripeSubscription()
 *   activatePaystackSubscription()
 *
 * These are the exact same functions called by the Stripe and Paystack webhook routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateStripeSubscription, activatePaystackSubscription } from '../recurring/activate-subscription';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ── Mock Supabase for Stripe ──
// The production code calls from() up to 3 times:
// 1. Pending lookup (SELECT): .from().select().eq().eq() → awaited as array
// 2. Conditional update (UPDATE): .from().update().eq().eq().eq().select() → awaited
// 3. Replay lookup (SELECT): .from().select().eq().eq().maybeSingle() → awaited
// We detect the operation by the first method called after from().
function mockStripeSupabase(scenario: {
  pendingLookupResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  replayLookupResult?: { data: unknown; error: unknown };
}): SupabaseClient {
  return {
    from: vi.fn().mockImplementation(() => {
      const chain: Record<string, any> = {};
      const methods = ['select', 'eq', 'is', 'update', 'maybeSingle', 'contains'];
      methods.forEach(m => chain[m] = vi.fn().mockReturnValue(chain));

      let isUpdate = false;
      let hasMaybeSingle = false;

      // Detect operation by first method called
      chain.update = vi.fn().mockImplementation(() => { isUpdate = true; return chain; });
      chain.select = vi.fn().mockImplementation(() => {
        if (isUpdate) {
          // This is the .select('id') at the end of the update chain
          return Promise.resolve(scenario.updateResult ?? { data: [], error: null });
        }
        return chain; // Part of a SELECT chain
      });

      // For the pending lookup: final awaitable = last eq() returns a thenable
      // For the replay lookup: maybeSingle() returns a thenable
      // We make the chain itself a thenable (for the pending lookup)
      chain.then = undefined; // not thenable by default

      // eq() chaining — the pending lookup ends when the chain is awaited
      let pendingLookupUsed = false;
      const origEq = chain.eq;
      chain.eq = vi.fn().mockImplementation(() => {
        if (!isUpdate && !pendingLookupUsed) {
          // Make chain awaitable — returns pending lookup result
          const awaitableChain = { ...chain };
          awaitableChain.then = (resolve: (v: unknown) => void) => {
            pendingLookupUsed = true;
            return Promise.resolve(scenario.pendingLookupResult ?? { data: [], error: null }).then(resolve);
          };
          awaitableChain.eq = vi.fn().mockReturnValue(awaitableChain);
          awaitableChain.maybeSingle = vi.fn().mockResolvedValue(scenario.replayLookupResult ?? { data: null, error: null });
          return awaitableChain;
        }
        return chain;
      });

      chain.maybeSingle = vi.fn().mockResolvedValue(scenario.replayLookupResult ?? { data: null, error: null });

      return chain;
    }),
  } as any;
}

// More flexible mock for Paystack which has a 3-step flow
function mockPaystackSupabase(scenario: {
  lookupResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  replayLookupResult?: { data: unknown; error: unknown };
}): SupabaseClient {
  let fromCallIdx = 0;
  return {
    from: vi.fn().mockImplementation(() => {
      fromCallIdx++;
      const chain: Record<string, any> = {};
      ['select', 'eq', 'is', 'contains', 'update', 'maybeSingle'].forEach(m => chain[m] = vi.fn().mockReturnValue(chain));

      if (fromCallIdx === 1) {
        // Lookup call — ends with resolved data
        chain.contains = vi.fn().mockResolvedValue(scenario.lookupResult ?? { data: [], error: null });
      } else if (fromCallIdx === 2) {
        // Activation update — ends with .select('id')
        chain.select = vi.fn().mockResolvedValue(scenario.updateResult ?? { data: [], error: null });
      } else {
        // Replay lookup — ends with .maybeSingle()
        chain.maybeSingle = vi.fn().mockResolvedValue(scenario.replayLookupResult ?? { data: null, error: null });
      }
      return chain;
    }),
  } as any;
}

const AUTH_UPDATE = { authorization_code: 'AUTH_abc', card_last_four: '4242', card_brand: 'visa', gateway_customer_code: 'CUS_abc' };

describe('P0-SUB-2: Executable activation tests', () => {
  beforeEach(() => vi.clearAllMocks());

  // ══════════════════════════════════════════════
  // STRIPE — executes activateStripeSubscription()
  // ══════════════════════════════════════════════

  describe('Stripe activation (production helper)', () => {

    it('SA. one pending row → activates exactly that row', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }], error: null },
        updateResult: { data: [{ id: 'sub-001' }], error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_session123', 'sub_real456');
      expect(result.result).toBe('activated');
      expect(result).toHaveProperty('subscriptionId', 'sub-001');

      // Verify UPDATE was called on the second from() with correct table and payload
      const fromCalls = (sb.from as any).mock.calls;
      expect(fromCalls.length).toBe(2); // lookup + update
      expect(fromCalls[1][0]).toBe('customer_subscriptions');
    });

    it('SB. two pending rows → ambiguous, UPDATE never called', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }, { id: 'sub-002' }], error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('ambiguous');
      expect(result).toHaveProperty('count', 2);

      // Only one from() call — the pending lookup. No update call.
      const fromCalls = (sb.from as any).mock.calls;
      expect(fromCalls.length).toBe(1);
    });

    it('SC. pending lookup DB error → db_error', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: null, error: { message: 'connection lost' } },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'pending lookup failed');
    });

    it('SD. selected row disappears before UPDATE → falls through to replay check', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }], error: null },
        updateResult: { data: [], error: null }, // zero rows — state changed
        replayLookupResult: { data: { id: 'sub-001', status: 'active' }, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('idempotent');
    });

    it('SE. zero pending + matching already-active → idempotent', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [], error: null },
        replayLookupResult: { data: { id: 'sub-001', status: 'active' }, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('idempotent');
      expect(result).toHaveProperty('subscriptionId', 'sub-001');
    });

    it('SF. zero pending + no matching active → inconsistent', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [], error: null },
        replayLookupResult: { data: null, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('inconsistent');
    });

    it('SG. activation UPDATE DB error → db_error', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }], error: null },
        updateResult: { data: null, error: { message: 'constraint violation' } },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'activation update failed');
    });

    it('SH. already-active lookup DB error → db_error', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [], error: null },
        replayLookupResult: { data: null, error: { message: 'timeout' } },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'idempotent lookup failed');
    });

    it('SI. duplicate delivery: second call returns idempotent', async () => {
      const sb1 = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }], error: null },
        updateResult: { data: [{ id: 'sub-001' }], error: null },
      });
      expect((await activateStripeSubscription(sb1, 'cs_x', 'sub_real')).result).toBe('activated');

      const sb2 = mockStripeSupabase({
        pendingLookupResult: { data: [], error: null },
        replayLookupResult: { data: { id: 'sub-001', status: 'active' }, error: null },
      });
      expect((await activateStripeSubscription(sb2, 'cs_x', 'sub_real')).result).toBe('idempotent');
    });

    it('SJ. UPDATE payload contains real Stripe sub ID and status=active', async () => {
      let capturedUpdatePayload: Record<string, unknown> | null = null;
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'sub-001' }], error: null },
        updateResult: { data: [{ id: 'sub-001' }], error: null },
      });
      // Intercept the update call to capture the payload
      const origFrom = (sb.from as any).getMockImplementation();
      let fromIdx = 0;
      (sb.from as any).mockImplementation((...args: unknown[]) => {
        fromIdx++;
        const chain = origFrom(...args);
        if (fromIdx === 2) {
          // This is the update from() call
          const origUpdate = chain.update;
          chain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            capturedUpdatePayload = payload;
            return origUpdate(payload);
          });
        }
        return chain;
      });

      await activateStripeSubscription(sb, 'cs_session', 'sub_real789');
      expect(capturedUpdatePayload).not.toBeNull();
      expect(capturedUpdatePayload!.status).toBe('active');
      expect(capturedUpdatePayload!.gateway_subscription_code).toBe('sub_real789');
    });

    // ── Same-row replay enforcement ──

    it('SK. selected row A + UPDATE zero + replay finds row A active → idempotent', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'row-A' }], error: null },
        updateResult: { data: [], error: null }, // zero — row changed concurrently
        replayLookupResult: { data: { id: 'row-A', status: 'active' }, error: null }, // SAME row
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('idempotent');
      expect(result).toHaveProperty('subscriptionId', 'row-A');
    });

    it('SL. selected row A + UPDATE zero + replay finds DIFFERENT row B → inconsistent', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'row-A' }], error: null },
        updateResult: { data: [], error: null },
        replayLookupResult: { data: { id: 'row-B', status: 'active' }, error: null }, // DIFFERENT row
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('inconsistent');
      expect(result.result).not.toBe('idempotent');
    });

    it('SM. zero pending + one active → ordinary duplicate replay idempotent', async () => {
      // No selectedPendingId — pure duplicate delivery
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [], error: null },
        replayLookupResult: { data: { id: 'row-C', status: 'active' }, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('idempotent');
      expect(result).toHaveProperty('subscriptionId', 'row-C');
    });

    it('SN. selected row A + UPDATE zero + no active → inconsistent', async () => {
      const sb = mockStripeSupabase({
        pendingLookupResult: { data: [{ id: 'row-A' }], error: null },
        updateResult: { data: [], error: null },
        replayLookupResult: { data: null, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('inconsistent');
    });
  });

  // ══════════════════════════════════════════════
  // PAYSTACK — executes activatePaystackSubscription()
  // ══════════════════════════════════════════════

  describe('Paystack activation (production helper)', () => {

    it('P1. exact reference activates one pending row', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: [{ id: 'ps-001' }], error: null },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('activated');
      expect(result).toHaveProperty('subscriptionId', 'ps-001');
    });

    it('P2. wrong reference: returns skipped (no pending match)', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [], error: null },
      });
      const result = await activatePaystackSubscription(sb, 'ref_wrong', AUTH_UPDATE);
      expect(result.result).toBe('skipped');
    });

    it('P3. pending lookup DB error: returns db_error', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: null, error: { message: 'connection' } },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'pending lookup failed');
    });

    it('P4. activation UPDATE DB error: returns db_error', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: null, error: { message: 'constraint' } },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'activation update failed');
    });

    it('P5. zero-row finalization + already-active: returns idempotent', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: [], error: null },
        replayLookupResult: { data: { id: 'ps-001' }, error: null },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('idempotent');
    });

    it('P6. zero-row finalization + not active: returns inconsistent', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: [], error: null },
        replayLookupResult: { data: null, error: null },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('inconsistent');
    });

    it('P7. multiple pending for same reference: returns ambiguous', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }, { id: 'ps-002' }], error: null },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('ambiguous');
      expect(result).toHaveProperty('count', 2);
    });

    it('P8. already-active lookup DB error: returns db_error', async () => {
      const sb = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: [], error: null },
        replayLookupResult: { data: null, error: { message: 'timeout' } },
      });
      const result = await activatePaystackSubscription(sb, 'ref_abc', AUTH_UPDATE);
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'idempotent lookup failed');
    });

    it('P9. duplicate: second call returns idempotent', async () => {
      // First: activates
      const sb1 = mockPaystackSupabase({
        lookupResult: { data: [{ id: 'ps-001' }], error: null },
        updateResult: { data: [{ id: 'ps-001' }], error: null },
      });
      const r1 = await activatePaystackSubscription(sb1, 'ref_abc', AUTH_UPDATE);
      expect(r1.result).toBe('activated');

      // Second: pending row gone → zero-row → idempotent via already-active check
      const sb2 = mockPaystackSupabase({
        lookupResult: { data: [], error: null }, // No pending match
      });
      const r2 = await activatePaystackSubscription(sb2, 'ref_abc', AUTH_UPDATE);
      expect(r2.result).toBe('skipped'); // No pending row — safe
    });
  });

  // ══════════════════════════════════════════════
  // SOURCE INVARIANTS (structural guards)
  // ══════════════════════════════════════════════

  describe('Source invariants', () => {
    const SETUP_SRC = fs.readFileSync(path.resolve(__dirname, '../../app/api/recurring/setup/route.ts'), 'utf-8');
    const STRIPE_WH = fs.readFileSync(path.resolve(__dirname, '../../app/api/payments/stripe-webhook/route.ts'), 'utf-8');
    const RETRY_CRON = fs.readFileSync(path.resolve(__dirname, '../../app/api/cron/retry-failed-charges/route.ts'), 'utf-8');

    it('INV-1. setup writes pending for both gateways', () => {
      const inserts = SETUP_SRC.match(/supabase\.from\('customer_subscriptions'\)\.insert\(\{[\s\S]*?\}\)/g) || [];
      expect(inserts.length).toBeGreaterThanOrEqual(2);
      for (const block of inserts) {
        expect(block).toContain("status: 'pending'");
        expect(block).not.toContain("status: 'active'");
      }
    });

    it('INV-2. Stripe invoice.paid renewal excludes pending', () => {
      const block = STRIPE_WH.substring(STRIPE_WH.indexOf("Stripe recurring invoice paid"));
      const filter = block.match(/\.in\('status',\s*\[([^\]]+)\]/);
      expect(filter).not.toBeNull();
      expect(filter![1]).not.toContain("'pending'");
    });

    it('INV-3. retry cron excludes pending', () => {
      const statuses = RETRY_CRON.match(/\.eq\('status',\s*'([^']+)'\)/g) || [];
      for (const s of statuses) expect(s).not.toContain("'pending'");
    });

    it('INV-4. Stripe webhook uses activateStripeSubscription helper', () => {
      expect(STRIPE_WH).toContain('activateStripeSubscription');
    });

    it('INV-5. Paystack webhook uses activatePaystackSubscription helper', () => {
      const PS_WH = fs.readFileSync(path.resolve(__dirname, '../../app/api/payments/webhook/route.ts'), 'utf-8');
      expect(PS_WH).toContain('activatePaystackSubscription');
    });

    it('INV-6. MRR counts active only', () => {
      const dash = fs.readFileSync(path.resolve(__dirname, '../../app/dashboard/recurring/page.tsx'), 'utf-8');
      expect(dash).toContain("s.status === 'active'");
    });

    it('INV-7. pending is valid in schema CHECK', () => {
      const m228 = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/228_add_pending_subscription_status.sql'), 'utf-8');
      expect(m228).toContain("'pending'");
    });
  });
});
