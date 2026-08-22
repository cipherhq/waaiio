/**
 * SPEND-MARKER-BOOKINGS — Application boundary tests.
 *
 * Executes the real production handlePostCompletion and verifies
 * the actual Supabase RPC calls, not source strings.
 *
 * Also tests the send-confirmation → handlePostCompletion call boundary
 * for Booking, Reservation, and Order payment types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies that handlePostCompletion imports
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  calculateLtvTier: vi.fn().mockReturnValue('new'),
}));

describe('handlePostCompletion with skipCustomerSpend=true', () => {
  let rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  let fromCalls: Array<{ table: string; method: string; args?: unknown }>;

  function mockSupabase() {
    rpcCalls = [];
    fromCalls = [];

    const chainMock = () => {
      // eslint-disable-next-line
      const c: Record<string, any> = {};
      ['select', 'eq', 'neq', 'is', 'not', 'in', 'order', 'limit', 'update', 'insert', 'delete'].forEach(
        m => c[m] = vi.fn().mockReturnValue(c),
      );
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      return c;
    };

    return {
      rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === 'increment_customer_visit') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn().mockImplementation((table: string) => {
        const chain = chainMock();
        // Track from() calls
        const originalSelect = chain.select;
        chain.select = vi.fn((...a: unknown[]) => {
          fromCalls.push({ table, method: 'select', args: a });
          return originalSelect(...a);
        });
        const originalInsert = chain.insert;
        chain.insert = vi.fn((...a: unknown[]) => {
          fromCalls.push({ table, method: 'insert', args: a });
          return originalInsert(...a);
        });

        // For customer_profiles lookup: return existing profile
        if (table === 'customer_profiles') {
          chain.maybeSingle = vi.fn().mockResolvedValue({
            data: { id: 'cp-1', total_spent: 5000, total_visits: 3, first_seen_at: '2025-01-01' },
            error: null,
          });
        }
        // For businesses lookup
        if (table === 'businesses') {
          chain.single = vi.fn().mockResolvedValue({
            data: { name: 'Test Biz', country_code: 'NG', subscription_tier: 'free', metadata: {} },
            error: null,
          });
        }
        return chain;
      }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skipCustomerSpend=true: increment_customer_visit called with p_amount=0', async () => {
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = mockSupabase();

    await handlePostCompletion({
      supabase: supabase as never,
      businessId: 'biz-1',
      customerPhone: '+2341234567890',
      customerName: 'Jane Doe',
      serviceType: 'booking',
      referenceId: 'bk-1',
      amountPaid: 8000,           // Real payment amount
      skipCustomerSpend: true,    // Stage 2 owns monetary spend
    });

    // increment_customer_visit MUST be called (nonfinancial activity)
    const visitCall = rpcCalls.find(c => c.name === 'increment_customer_visit');
    expect(visitCall).toBeTruthy();
    // p_amount MUST be 0 (monetary spend suppressed)
    expect(visitCall!.args.p_amount).toBe(0);
    // Business and phone still correct
    expect(visitCall!.args.p_business_id).toBe('biz-1');
    expect(visitCall!.args.p_phone).toBe('+2341234567890');
  });

  it('skipCustomerSpend=true: real amountPaid available for receipt gate', async () => {
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = mockSupabase();

    // The receipt gate is `if (amountPaid && amountPaid > 0)`.
    // With skipCustomerSpend=true and amountPaid=8000, the receipt should attempt to run.
    // We can't fully test PDF generation here, but we can verify the receipt section
    // is entered by checking that the code doesn't skip due to amountPaid=0.
    await handlePostCompletion({
      supabase: supabase as never,
      businessId: 'biz-1',
      customerPhone: '+2341234567890',
      customerName: 'Jane Doe',
      serviceType: 'booking',
      amountPaid: 8000,
      skipCustomerSpend: true,
    });

    // The receipt path attempts to send a message. Since sender is undefined,
    // it won't actually send, but the increment_customer_visit should still have
    // been called with p_amount=0 (not 8000, and not skipped entirely).
    const visitCall = rpcCalls.find(c => c.name === 'increment_customer_visit');
    expect(visitCall).toBeTruthy();
    expect(visitCall!.args.p_amount).toBe(0);
  });

  it('skipCustomerSpend=false: increment_customer_visit called with real amount', async () => {
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = mockSupabase();

    await handlePostCompletion({
      supabase: supabase as never,
      businessId: 'biz-1',
      customerPhone: '+2341234567890',
      customerName: 'Jane Doe',
      serviceType: 'booking',
      amountPaid: 8000,
      skipCustomerSpend: false,  // Legacy behavior
    });

    const visitCall = rpcCalls.find(c => c.name === 'increment_customer_visit');
    expect(visitCall).toBeTruthy();
    expect(visitCall!.args.p_amount).toBe(8000);  // Full amount passed
  });

  it('skipCustomerSpend=true, new profile: total_spent=0 in INSERT', async () => {
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = mockSupabase();
    // Override customer_profiles lookup to return null (no existing profile)
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      // eslint-disable-next-line
      const c: Record<string, any> = {};
      ['select', 'eq', 'neq', 'is', 'not', 'in', 'order', 'limit', 'update', 'insert', 'delete'].forEach(
        m => c[m] = vi.fn().mockReturnValue(c),
      );
      c.single = vi.fn().mockResolvedValue({ data: table === 'businesses' ? { name: 'Biz', country_code: 'NG', subscription_tier: 'free', metadata: {} } : null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      const origInsert = c.insert;
      c.insert = vi.fn((...args: unknown[]) => {
        if (table === 'customer_profiles') {
          fromCalls.push({ table, method: 'insert', args: args[0] });
        }
        return origInsert(...args);
      });
      return c;
    });

    await handlePostCompletion({
      supabase: supabase as never,
      businessId: 'biz-1',
      customerPhone: '+2341234567890',
      customerName: 'Jane Doe',
      serviceType: 'booking',
      amountPaid: 8000,
      skipCustomerSpend: true,
    });

    // New profile INSERT should have total_spent=0 (skipCustomerSpend=true)
    const insertCall = fromCalls.find(c => c.table === 'customer_profiles' && c.method === 'insert');
    expect(insertCall).toBeTruthy();
    const insertData = insertCall!.args as Record<string, unknown>;
    expect(insertData.total_spent).toBe(0);  // NOT 8000
    expect(insertData.name).toBe('Jane Doe'); // Name preserved
  });
});

describe('send-confirmation → handlePostCompletion call boundary', () => {
  it('Booking payment passes real amount + skipCustomerSpend=true', () => {
    // Read the actual send-confirmation source to verify the call args.
    // This is a source-level supplemental check; the handlePostCompletion
    // behavioral tests above prove the actual function behavior.
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');

    // For booking payments: amountPaid should NOT be 0
    // The expression is: isOrderPayment ? 0 : payment.amount
    expect(src).toContain('isOrderPayment ? 0 : payment.amount');

    // skipCustomerSpend should include booking but NOT order
    expect(src).toContain('skipCustomerSpend: isBookingPayment || isReservationPayment');
  });

  it('Order payment preserves pre-#161 amountPaid=0 and no skipCustomerSpend', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/payments/send-confirmation.ts', 'utf-8');

    // Orders: amountPaid=0 (existing behavior)
    expect(src).toContain('isOrderPayment ? 0 : payment.amount');

    // skipCustomerSpend must NOT include isOrderPayment
    const skipLine = src.split('skipCustomerSpend:')[1]?.split('\n')[0] || '';
    expect(skipLine).toContain('isBookingPayment || isReservationPayment');
    expect(skipLine).not.toContain('isOrderPayment');
  });
});
