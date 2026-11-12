/**
 * Unused bank-transfer offers after an online payment (Owner Option A, 2026-11-12).
 * Staging trace: TestBiz bookings paid by card kept a `pending` transfer forever.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 100 }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { hasProtectedProof, supersedeUnusedTransfers } from '../stale-transfers';
import { processSuccessfulPayment } from '../process-success';

describe('hasProtectedProof (same rule as cancel_stale_order_atomic, M479)', () => {
  const expires_at = '2026-11-12T14:00:00Z';
  it.each([
    ['no receipt', {}, false],
    ['already protected', { proof_protected: true }, true],
    ['receipt before the deadline', { proof_submitted_at: '2026-11-12T13:59:00Z', expires_at }, true],
    ['receipt after the deadline', { proof_submitted_at: '2026-11-12T14:01:00Z', expires_at }, false],
    ['legacy screenshot, no time', { proof_image_url: 'https://x/receipt.jpg' }, true],
    ['legacy typed reference, no time', { proof_text: 'FT123' }, true],
  ])('%s', (_label, t, expected) => {
    expect(hasProtectedProof({ expires_at: null, ...t })).toBe(expected);
  });
});

/** Records every filter applied to each update. */
function recordingSupabase(opts: { bookingStatus?: string } = {}) {
  const updates: Array<{ table: string; row: Record<string, unknown>; filters: Array<[string, string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'is', 'neq']) {
      builder[m] = vi.fn((col: string, val: unknown) => { filters.push([m, col, val]); return builder; });
    }
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    builder.select = vi.fn(() => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      single: vi.fn().mockResolvedValue({ data: { status: opts.bookingStatus ?? 'confirmed', deposit_status: 'paid' }, error: null }),
    }));
    return {
      update: vi.fn((row: Record<string, unknown>) => { updates.push({ table, row, filters }); return builder; }),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({
            data: table === 'bookings'
              ? { business_id: 'biz1', total_amount: 20000, status: opts.bookingStatus ?? 'confirmed', deposit_status: 'paid' }
              : table === 'businesses'
              ? { subscription_tier: 'premium', trial_ends_at: '2025-01-01', payout_mode: 'platform_managed' }
              : table === 'payments'
              ? { business_id: 'biz1', currency: 'NGN', tax_allocation: null, tax_fee_basis: null }
              : null,
            error: null,
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        })),
      })),
    };
  });
  return {
    from,
    rpc: vi.fn().mockResolvedValue({ data: { applied: true, outcome: 'not_ticket' }, error: null }),
    updates,
  };
}

const transferUpdates = (sb: ReturnType<typeof recordingSupabase>) => sb.updates.filter(u => u.table === 'pending_transfers');

describe('supersedeUnusedTransfers', () => {
  it('cancels only pending transfers with no receipt of any kind', async () => {
    const sb = recordingSupabase();
    await supersedeUnusedTransfers(sb as never, { booking_id: 'bk1' });

    const [u] = transferUpdates(sb);
    expect(u.row.status).toBe('cancelled');
    expect(u.filters).toEqual(expect.arrayContaining([
      ['eq', 'booking_id', 'bk1'],
      ['eq', 'status', 'pending'],
      ['eq', 'proof_protected', false],
      ['is', 'proof_submitted_at', null],
      ['is', 'proof_image_url', null],
      ['is', 'proof_text', null],
    ]));
  });

  it('does nothing without a booking, reservation or invoice', async () => {
    const sb = recordingSupabase();
    await supersedeUnusedTransfers(sb as never, { booking_id: null });
    expect(transferUpdates(sb)).toHaveLength(0);
  });
});

describe('processSuccessfulPayment closes the unused transfer offer', () => {
  it('card payment confirms a booking → its receipt-less transfer is cancelled', async () => {
    const sb = recordingSupabase();
    const result = await processSuccessfulPayment(sb as never, {
      id: 'pay1', amount: 5000, booking_id: 'bk1', invoice_id: null, campaign_id: null,
    });

    expect(result.criticalSuccess).toBe(true);
    const u = transferUpdates(sb);
    expect(u).toHaveLength(1);
    expect(u[0].row.status).toBe('cancelled');
    expect(u[0].filters).toEqual(expect.arrayContaining([['eq', 'booking_id', 'bk1'], ['is', 'proof_submitted_at', null]]));
  });

  it('booking cancelled before the payment landed → transfer left alone', async () => {
    const sb = recordingSupabase({ bookingStatus: 'cancelled' });
    const result = await processSuccessfulPayment(sb as never, {
      id: 'pay1', amount: 5000, booking_id: 'bk1', invoice_id: null, campaign_id: null,
    });

    expect(result.criticalSuccess).toBe(false);
    expect(transferUpdates(sb)).toHaveLength(0);
  });
});
