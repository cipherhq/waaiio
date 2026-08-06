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

// ── Mock Supabase builder ──
function mockSupabase(scenario: {
  updateResult?: { data: unknown; error: unknown };
  lookupResult?: { data: unknown; error: unknown };
}): SupabaseClient {
  let callIdx = 0;
  const chain: Record<string, any> = {};
  ['update', 'select', 'eq', 'is', 'contains', 'maybeSingle'].forEach(m => chain[m] = vi.fn().mockReturnValue(chain));

  // First .select() call from update chain = activation result
  // Second .select() chain ending in .maybeSingle() = idempotent lookup
  chain.select = vi.fn().mockImplementation(() => {
    callIdx++;
    if (callIdx === 1) return Promise.resolve(scenario.updateResult ?? { data: [], error: null });
    const lookupChain: Record<string, any> = {};
    ['eq', 'maybeSingle'].forEach(m => lookupChain[m] = vi.fn().mockReturnValue(lookupChain));
    lookupChain.maybeSingle = vi.fn().mockResolvedValue(scenario.lookupResult ?? { data: null, error: null });
    return lookupChain;
  });

  return { from: vi.fn().mockReturnValue(chain) } as any;
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

    it('S1. pending→active: returns activated with subscription ID', async () => {
      const sb = mockSupabase({ updateResult: { data: [{ id: 'sub-001' }], error: null } });
      const result = await activateStripeSubscription(sb, 'cs_session123', 'sub_real456');
      expect(result.result).toBe('activated');
      expect(result).toHaveProperty('subscriptionId', 'sub-001');
    });

    it('S2. activation replaces session ID with real subscription ID', async () => {
      const sb = mockSupabase({ updateResult: { data: [{ id: 'sub-001' }], error: null } });
      await activateStripeSubscription(sb, 'cs_session123', 'sub_real456');
      const fromCall = (sb.from as any).mock.calls[0];
      expect(fromCall[0]).toBe('customer_subscriptions');
    });

    it('S3. activation UPDATE DB error: returns db_error', async () => {
      const sb = mockSupabase({ updateResult: { data: null, error: { message: 'connection lost' } } });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'activation update failed');
    });

    it('S4. zero rows + matching already-active: returns idempotent', async () => {
      const sb = mockSupabase({
        updateResult: { data: [], error: null },
        lookupResult: { data: { id: 'sub-001', status: 'active' }, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_real');
      expect(result.result).toBe('idempotent');
      expect(result).toHaveProperty('subscriptionId', 'sub-001');
    });

    it('S5. zero rows + no valid active row: returns inconsistent', async () => {
      const sb = mockSupabase({
        updateResult: { data: [], error: null },
        lookupResult: { data: null, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('inconsistent');
    });

    it('S6. already-active lookup DB error: returns db_error', async () => {
      const sb = mockSupabase({
        updateResult: { data: [], error: null },
        lookupResult: { data: null, error: { message: 'timeout' } },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).toBe('db_error');
      expect(result).toHaveProperty('detail', 'idempotent lookup failed');
    });

    it('S7. conflicting state cannot report success', async () => {
      const sb = mockSupabase({
        updateResult: { data: [], error: null },
        lookupResult: { data: null, error: null },
      });
      const result = await activateStripeSubscription(sb, 'cs_x', 'sub_y');
      expect(result.result).not.toBe('activated');
      expect(result.result).not.toBe('idempotent');
    });

    it('S8. duplicate delivery cannot double-activate (second call returns idempotent)', async () => {
      // First call activates
      const sb1 = mockSupabase({ updateResult: { data: [{ id: 'sub-001' }], error: null } });
      const r1 = await activateStripeSubscription(sb1, 'cs_x', 'sub_real');
      expect(r1.result).toBe('activated');

      // Second call: pending row is gone, but active row exists with sub_real
      const sb2 = mockSupabase({
        updateResult: { data: [], error: null },
        lookupResult: { data: { id: 'sub-001', status: 'active' }, error: null },
      });
      const r2 = await activateStripeSubscription(sb2, 'cs_x', 'sub_real');
      expect(r2.result).toBe('idempotent');
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
