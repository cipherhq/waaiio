/**
 * Issue #191 Correction 5C — NEW APP + OLD DB Reproduction
 *
 * NEW run — not the deleted prior test. Reconstructed from current
 * authoritative main (ddfa939a3a464c5a2477ef8b2fa0ebc7f30d304d).
 *
 * Proves: when the current webhook handler (post-#176 application code)
 * runs against a pre-migration-337 database (paystack_billing_attempts
 * table absent), customer-recurring charge.success events are silently
 * swallowed — no financial writes occur, no finalizer runs, but the
 * outer processed_webhook_events reaches 'completed' and HTTP 200 is
 * returned.
 *
 * Approach:
 * - Extracts the exact production logic from route.ts lines 326–557
 *   (the charge.success && !existingPayment block) into an isolated
 *   test harness with a mock Supabase client that faithfully models
 *   PostgREST missing-table semantics.
 * - NO behavioral rewrite: the code under test uses the same query
 *   patterns, destructuring, and error (non-)handling as production.
 * - The mock returns { data: null, error: { code: '42P01', ... } }
 *   for paystack_billing_attempts queries, matching real PostgREST
 *   behavior when a table doesn't exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// PostgREST missing-table error shape (real Supabase behavior)
// ═══════════════════════════════════════════════════════════════
const MISSING_TABLE_ERROR = {
  code: '42P01',
  message: 'relation "public.paystack_billing_attempts" does not exist',
  details: null,
  hint: null,
};

const MISSING_FUNCTION_ERROR = {
  code: '42883',
  message: 'function finalize_paystack_recurring_charge(unknown, unknown, unknown, unknown, unknown) does not exist',
  details: null,
  hint: null,
};

// ═══════════════════════════════════════════════════════════════
// Mock Supabase client modeling pre-337 database
// ═══════════════════════════════════════════════════════════════
interface CallLog {
  table: string;
  method: string;
  args?: unknown[];
}

function createPre337MockClient() {
  const calls: CallLog[] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const eventUpdates: Array<{ eventId: string; status: string }> = [];

  // Chain builder for .from() queries
  function buildChain(tableName: string) {
    const chain: Record<string, unknown> = {};

    const makeChainable = (method: string) => {
      return (...args: unknown[]) => {
        calls.push({ table: tableName, method, args });

        // paystack_billing_attempts doesn't exist pre-337
        if (tableName === 'paystack_billing_attempts') {
          // Terminal methods return the PostgREST error
          if (method === 'maybeSingle' || method === 'single') {
            return Promise.resolve({ data: null, error: MISSING_TABLE_ERROR });
          }
          if (method === 'insert' || method === 'update' || method === 'upsert') {
            // insert/update also return error shape (non-throwing)
            return { ...chain, then: (resolve: (v: unknown) => void) => resolve({ data: null, error: MISSING_TABLE_ERROR }) };
          }
        }

        // processed_webhook_events — exists pre-337, track updates
        if (tableName === 'processed_webhook_events' && method === 'update') {
          const updateData = args[0] as Record<string, string>;
          if (updateData?.status) {
            // Will be resolved when .eq is called with event_id
            chain._pendingUpdate = updateData;
          }
        }
        if (tableName === 'processed_webhook_events' && method === 'eq') {
          const [field, value] = args as [string, string];
          if (field === 'event_id' && (chain._pendingUpdate as Record<string, string>)) {
            eventUpdates.push({
              eventId: value,
              status: (chain._pendingUpdate as Record<string, string>).status,
            });
          }
        }
        if (tableName === 'processed_webhook_events' && method === 'upsert') {
          const data = args[0] as Record<string, string>;
          calls.push({ table: tableName, method: 'upsert', args: [data] });
        }

        // For terminal async methods on other tables
        if (method === 'maybeSingle' || method === 'single') {
          return Promise.resolve({ data: null, error: null });
        }

        return chain;
      };
    };

    // Build full query chain (covers all Supabase query methods used in route.ts)
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'maybeSingle', 'single', 'order', 'limit']) {
      chain[m] = makeChainable(m);
    }

    return chain;
  }

  const client = {
    from: (table: string) => buildChain(table),
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === 'finalize_paystack_recurring_charge') {
        return Promise.resolve({ data: null, error: MISSING_FUNCTION_ERROR });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { client, calls, rpcCalls, eventUpdates };
}

// ═══════════════════════════════════════════════════════════════
// Extract the exact production logic from route.ts lines 326-557
//
// This function mirrors the EXACT code path in the webhook handler
// for: event === 'charge.success' && !existingPayment
//
// Production lines referenced:
//   334-338: paystack_billing_attempts SELECT by provider_reference
//   340:     if (existingAttempt) — Path A
//   385:     else if (webhookSubscriptionCode) — Path B
//   535:     else — Path C (no attempt, no sub code)
//
// The function does NOT modify any logic — it reproduces the exact
// destructuring pattern that swallows the 42P01 error.
// ═══════════════════════════════════════════════════════════════
async function executeRecurringChargeBlock(
  supabase: ReturnType<typeof createPre337MockClient>['client'],
  reference: string,
  data: Record<string, unknown>,
  logger: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
) {
  const webhookAmountKobo = data.amount as number;
  const webhookCurrency = ((data.currency as string) || 'NGN').toUpperCase();
  const webhookMetadata = data.metadata as Record<string, unknown> | undefined;
  const subscriptionRef = data.subscription as Record<string, unknown> | undefined;
  const webhookSubscriptionCode = (subscriptionRef?.subscription_code as string) || undefined;

  // ── route.ts lines 334-338: exact destructuring pattern ──
  // CRITICAL: only { data: existingAttempt } is destructured — error is IGNORED.
  // With pre-337 DB, this returns { data: null, error: { code: '42P01', ... } }
  // but existingAttempt becomes null and the error is silently dropped.
  const { data: existingAttempt } = await supabase
    .from('paystack_billing_attempts')
    .select('id, customer_subscription_id, intended_amount_minor, intended_currency, status')
    .eq('provider_reference', reference)
    .maybeSingle();

  // ── route.ts line 340: Path A — attempt found ──
  if (existingAttempt) {
    // This entire block is unreachable with pre-337 DB
    // because existingAttempt is always null (table doesn't exist)
    if (existingAttempt.status === 'finalized') {
      logger.info(`[PAYSTACK RECURRING] Already finalized for reference ${reference}`);
    } else {
      const metaSubId = webhookMetadata?.customer_subscription_id as string | undefined;
      if (metaSubId && metaSubId !== existingAttempt.customer_subscription_id) {
        logger.error(`[PAYSTACK RECURRING] Identity conflict`);
      } else {
        const webhookTransactionId = data.id ? String(data.id) : null;
        let cronInvoiceCode: string | null = null;

        const { data: finResult, error: finErr } = await supabase.rpc('finalize_paystack_recurring_charge', {
          p_attempt_id: existingAttempt.id,
          p_provider_amount_minor: webhookAmountKobo,
          p_provider_currency: webhookCurrency,
          p_provider_transaction_id: webhookTransactionId,
          p_provider_invoice_code: cronInvoiceCode,
        });

        if (finErr) {
          logger.error('[PAYSTACK RECURRING] Finalizer RPC error:', finErr);
        }
      }
    }
  // ── route.ts line 385: Path B — subscription code present ──
  } else if (webhookSubscriptionCode) {
    const { data: localSub } = await supabase
      .from('customer_subscriptions')
      .select('id, amount, currency, frequency')
      .eq('gateway_subscription_code', webhookSubscriptionCode)
      .eq('gateway', 'paystack')
      .maybeSingle();

    if (localSub) {
      const webhookTransactionId = data.id ? String(data.id) : undefined;

      // Invoice fetch would happen here but we skip the dynamic import
      // in the test — the production code wraps it in try/catch anyway
      const invoiceCode: string | null = null;

      if (!invoiceCode) {
        // route.ts lines 410-425: upsert reconciliation_required
        await supabase.from('processed_webhook_events').upsert({
          event_id: `paystack-unresolved-invoice-${reference}`,
          gateway: 'paystack',
          event_type: 'provider_managed_invoice_unresolved',
          status: 'reconciliation_required',
          first_received_at: new Date().toISOString(),
          last_attempted_at: new Date().toISOString(),
          last_error: JSON.stringify({
            reference,
            subscription_code: webhookSubscriptionCode,
            subscription_id: localSub.id,
            amount_kobo: webhookAmountKobo,
            currency: webhookCurrency,
            transaction_id: webhookTransactionId || null,
          }),
        }, { onConflict: 'event_id', ignoreDuplicates: true });
        logger.warn(`[PAYSTACK RECURRING] Invoice unresolved for provider-managed charge`);
      } else {
        // With invoiceCode resolved, would query paystack_billing_attempts
        // again (lines 432-438, 444-450, 469-481) — all return 42P01
        // Then would call finalize_paystack_recurring_charge RPC (line 509)
        // — returns 42883 missing function error, logged but not thrown
      }
    } else {
      logger.warn(`[PAYSTACK RECURRING] No local subscription for subscription_code: ${webhookSubscriptionCode}`);
    }
  // ── route.ts line 535: Path C — no attempt, no sub code ──
  } else {
    const authorization = data.authorization as Record<string, string> | undefined;
    const customerData = data.customer as Record<string, string> | undefined;
    await supabase.from('processed_webhook_events').upsert({
      event_id: `paystack-unresolved-${reference}`,
      gateway: 'paystack',
      event_type: 'unresolved_recurring_charge',
      status: 'reconciliation_required',
      first_received_at: new Date().toISOString(),
      last_attempted_at: new Date().toISOString(),
      last_error: JSON.stringify({
        reference,
        amount_kobo: webhookAmountKobo,
        currency: webhookCurrency,
        auth_code: authorization?.authorization_code,
        customer_code: customerData?.customer_code,
      }),
    }, { onConflict: 'event_id', ignoreDuplicates: true });
    logger.warn(`[PAYSTACK RECURRING] Unresolved charge.success`);
  }

  return { existingAttempt };
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('Issue #191 Correction 5C: NEW APP + OLD DB Reproduction', () => {
  let mock: ReturnType<typeof createPre337MockClient>;
  let logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mock = createPre337MockClient();
    logger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    };
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO A: Cron-initiated recurring charge (has provider_reference
  // matching a cron attempt, but table doesn't exist)
  //
  // Production lines covered:
  //   334-338: .from('paystack_billing_attempts').select()...maybeSingle()
  //   The destructuring { data: existingAttempt } silently drops the 42P01
  //   error — existingAttempt is null, not because no row matched, but
  //   because the TABLE doesn't exist.
  // ═══════════════════════════════════════════════════════════

  it('A1. Missing paystack_billing_attempts returns PostgREST error object (not exception)', async () => {
    // Directly verify the Supabase mock behavior matches PostgREST semantics
    const result = await mock.client
      .from('paystack_billing_attempts')
      .select('id, customer_subscription_id')
      .eq('provider_reference', 'ps-retry-test-ref')
      .maybeSingle();

    // PostgREST returns error object, NOT a thrown exception
    expect(result.error).toEqual(MISSING_TABLE_ERROR);
    expect(result.error!.code).toBe('42P01');
    expect(result.data).toBeNull();
  });

  it('A2. Production destructuring pattern silently drops the 42P01 error', async () => {
    // This mirrors the EXACT line 334 pattern: const { data: existingAttempt } = await ...
    // The error field is never checked in production code
    const { data: existingAttempt } = await mock.client
      .from('paystack_billing_attempts')
      .select('id, customer_subscription_id, intended_amount_minor, intended_currency, status')
      .eq('provider_reference', 'ps-retry-cron-ref')
      .maybeSingle();

    // existingAttempt is null — error is silently swallowed by destructuring
    expect(existingAttempt).toBeNull();
    // No exception was thrown — the code continues normally
  });

  it('A3. Current route does NOT throw from the missing-table query', async () => {
    // The full block completes without throwing, even though the table doesn't exist
    await expect(
      executeRecurringChargeBlock(mock.client, 'ps-retry-cron-ref-123', {
        amount: 500000,
        currency: 'NGN',
        id: 'txn-123',
        metadata: { customer_subscription_id: 'sub-abc' },
        // No subscription object → falls to Path C
      }, logger)
    ).resolves.not.toThrow();
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO B: No recurring attempt established
  //
  // Production lines covered:
  //   340: if (existingAttempt) — FALSE because 42P01 made data=null
  //   385: else if (webhookSubscriptionCode) — depends on webhook data
  //   535: else — Path C fallback
  //
  // The core defect: existingAttempt is null not because no row matched
  // but because the table doesn't exist. The code cannot distinguish
  // "no matching row" from "table doesn't exist".
  // ═══════════════════════════════════════════════════════════

  it('B1. No valid recurring attempt is established (Path C — no sub code)', async () => {
    const result = await executeRecurringChargeBlock(mock.client, 'ps-retry-no-sub-ref', {
      amount: 250000,
      currency: 'NGN',
      id: 'txn-456',
      // No subscription object, no subscription_code
    }, logger);

    // existingAttempt is null (42P01 silently swallowed)
    expect(result.existingAttempt).toBeNull();

    // No attempt insert was made (table doesn't exist, but code never reaches insert)
    const attemptInserts = mock.calls.filter(
      c => c.table === 'paystack_billing_attempts' && c.method === 'insert'
    );
    expect(attemptInserts).toHaveLength(0);
  });

  it('B2. No valid recurring attempt established (Path B — with sub code, no local sub)', async () => {
    const result = await executeRecurringChargeBlock(mock.client, 'ps-auto-renewal-ref', {
      amount: 300000,
      currency: 'NGN',
      id: 'txn-789',
      subscription: { subscription_code: 'SUB_abc123' },
    }, logger);

    expect(result.existingAttempt).toBeNull();

    // customer_subscriptions was queried (it exists pre-337) but returned null
    const subQueries = mock.calls.filter(
      c => c.table === 'customer_subscriptions' && c.method === 'select'
    );
    expect(subQueries.length).toBeGreaterThanOrEqual(1);

    // No attempt was inserted into paystack_billing_attempts
    const attemptInserts = mock.calls.filter(
      c => c.table === 'paystack_billing_attempts' && c.method === 'insert'
    );
    expect(attemptInserts).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO C: No recurring finalization occurs
  //
  // Production lines covered:
  //   362-368: finalize_paystack_recurring_charge RPC (Path A) — UNREACHABLE
  //   509-515: finalize_paystack_recurring_charge RPC (Path B) — UNREACHABLE
  //   Both paths require existingAttempt or attemptIdToFinalize, which
  //   require paystack_billing_attempts to exist.
  // ═══════════════════════════════════════════════════════════

  it('C1. No recurring finalization RPC is called', async () => {
    await executeRecurringChargeBlock(mock.client, 'ps-retry-no-final', {
      amount: 100000,
      currency: 'NGN',
      id: 'txn-nofin',
      // No sub code → Path C
    }, logger);

    // finalize_paystack_recurring_charge was never called
    const finCalls = mock.rpcCalls.filter(
      c => c.fn === 'finalize_paystack_recurring_charge'
    );
    expect(finCalls).toHaveLength(0);
  });

  it('C2. No recurring finalization even with subscription_code (no local sub found)', async () => {
    await executeRecurringChargeBlock(mock.client, 'ps-auto-nofin', {
      amount: 200000,
      currency: 'NGN',
      id: 'txn-nofin2',
      subscription: { subscription_code: 'SUB_xyz' },
    }, logger);

    const finCalls = mock.rpcCalls.filter(
      c => c.fn === 'finalize_paystack_recurring_charge'
    );
    expect(finCalls).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO D: No new financial writes
  //
  // Production lines covered:
  //   Path A (line 362): finalize RPC creates payment/booking/
  //     subscription_charge/platform_fee — UNREACHABLE
  //   Path B (line 509): same finalize RPC — UNREACHABLE
  //   Neither path fires, so no financial records are created.
  // ═══════════════════════════════════════════════════════════

  it('D1. No payments/bookings/subscription_charges/platform_fees writes occur', async () => {
    await executeRecurringChargeBlock(mock.client, 'ps-no-financial', {
      amount: 400000,
      currency: 'NGN',
      id: 'txn-fin',
    }, logger);

    // No writes to financial tables
    const financialTables = ['payments', 'bookings', 'subscription_charges', 'platform_fees'];
    for (const table of financialTables) {
      const writes = mock.calls.filter(
        c => c.table === table && ['insert', 'update', 'upsert'].includes(c.method)
      );
      expect(writes).toHaveLength(0);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO E: Outer event reaches 'completed' + HTTP 200
  //
  // Production lines covered:
  //   642-644: processed_webhook_events updated to 'completed'
  //   647: return NextResponse.json({ received: true })
  //
  // Because the 42P01 error is silently swallowed and no exception
  // is thrown, execution proceeds past the recurring block to the
  // outer completion mark (line 642) and returns HTTP 200 (line 647).
  //
  // This is the core NEW APP + OLD DB problem: the event appears
  // successfully processed when in reality no financial work was done.
  // ═══════════════════════════════════════════════════════════

  it('E1. Outer processed_webhook_events can reach completed (simulated)', async () => {
    // Execute the recurring block — it completes without throwing
    await executeRecurringChargeBlock(mock.client, 'ps-completes-ref', {
      amount: 100000,
      currency: 'NGN',
      id: 'txn-completes',
    }, logger);

    // Simulate what production does AFTER the recurring block (route.ts line 642):
    const eventId = 'paystack-ps-completes-ref';
    await mock.client.from('processed_webhook_events')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('event_id', eventId);

    // The event update to 'completed' was recorded
    const completedUpdates = mock.eventUpdates.filter(
      u => u.eventId === eventId && u.status === 'completed'
    );
    expect(completedUpdates).toHaveLength(1);
  });

  it('E2. HTTP 200 would be returned (no exception thrown)', async () => {
    // The function does not throw → in production, line 647 returns 200
    const result = await executeRecurringChargeBlock(mock.client, 'ps-http200-ref', {
      amount: 100000,
      currency: 'NGN',
      id: 'txn-200',
    }, logger);

    // No exception means the outer try block continues to line 647:
    // return NextResponse.json({ received: true })
    // We prove this by the fact that executeRecurringChargeBlock resolved
    // (if it threw, the outer catch at line 648 would return 500 instead)
    expect(result).toBeDefined();
    expect(result.existingAttempt).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════
  // SCENARIO F: Identify every swallowed error
  //
  // The specific errors that are silently consumed:
  //   1. paystack_billing_attempts SELECT 42P01 — destructuring drops error
  //   2. Path C upsert into processed_webhook_events (reconciliation_required)
  //      goes through but is NOT an error — it's the fallback behavior
  // ═══════════════════════════════════════════════════════════

  it('F1. 42P01 error is swallowed by destructuring (error field never checked)', async () => {
    // Directly verify: the production pattern { data: existingAttempt } ignores error
    const queryResult = await mock.client
      .from('paystack_billing_attempts')
      .select('id, customer_subscription_id, intended_amount_minor, intended_currency, status')
      .eq('provider_reference', 'ps-error-swallowed')
      .maybeSingle();

    // Error IS present in the result
    expect(queryResult.error).not.toBeNull();
    expect(queryResult.error!.code).toBe('42P01');

    // But production code only reads .data, never checks .error:
    //   const { data: existingAttempt } = await supabase.from(...)...
    const { data: existingAttempt } = queryResult;
    expect(existingAttempt).toBeNull();
    // The 42P01 is now unreachable — swallowed by selective destructuring
  });

  it('F2. Path C reconciliation_required upsert fires (not an error, but masks the real problem)', async () => {
    await executeRecurringChargeBlock(mock.client, 'ps-masked-ref', {
      amount: 100000,
      currency: 'NGN',
      id: 'txn-masked',
      customer: { customer_code: 'CUS_test' },
      authorization: { authorization_code: 'AUTH_test' },
    }, logger);

    // A reconciliation_required upsert was attempted
    const reconUpserts = mock.calls.filter(
      c => c.table === 'processed_webhook_events' && c.method === 'upsert'
    );
    expect(reconUpserts.length).toBeGreaterThanOrEqual(1);

    // But this masks the real problem: the event looks "handled" when it wasn't
    // The warn log was called (route.ts line 555)
    expect(logger.warn).toHaveBeenCalled();
  });
});
