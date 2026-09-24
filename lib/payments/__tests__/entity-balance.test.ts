import { describe, expect, it, vi } from 'vitest';
import { getEntityBalance } from '../entity-balance';

function makeSupabase(payments: Array<{ amount: number; refund_amount?: number | null }>, error: unknown = null) {
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: error ? null : payments, error }).then(resolve, reject),
  };
  return {
    from: vi.fn((table: string) => {
      if (table !== 'payments') throw new Error(`unexpected table ${table}`);
      return chain;
    }),
  } as any;
}

describe('#381 canonical entity balance authority', () => {
  it('calculates remaining balance from successful payment history, not configured deposit', async () => {
    const result = await getEntityBalance(makeSupabase([
      { amount: 200, refund_amount: 0 },
    ]), {
      bookingId: 'booking-1',
      totalAmount: 1000,
    });

    expect(result).toEqual({
      totalAmount: 1000,
      netPaid: 200,
      balanceDue: 800,
    });
  });

  it('returns zero due after deposit and balance are both successfully paid', async () => {
    const result = await getEntityBalance(makeSupabase([
      { amount: 200, refund_amount: 0 },
      { amount: 800, refund_amount: 0 },
    ]), {
      bookingId: 'booking-1',
      totalAmount: 1000,
    });

    expect(result).toEqual({
      totalAmount: 1000,
      netPaid: 1000,
      balanceDue: 0,
    });
  });

  it('uses net paid after refunds', async () => {
    const result = await getEntityBalance(makeSupabase([
      { amount: 200, refund_amount: 0 },
      { amount: 800, refund_amount: 100 },
    ]), {
      reservationId: 'reservation-1',
      totalAmount: 1000,
    });

    expect(result).toEqual({
      totalAmount: 1000,
      netPaid: 900,
      balanceDue: 100,
    });
  });

  it('never returns a negative balance when successful payments exceed total', async () => {
    const result = await getEntityBalance(makeSupabase([
      { amount: 1200, refund_amount: 0 },
    ]), {
      bookingId: 'booking-1',
      totalAmount: 1000,
    });

    expect(result?.balanceDue).toBe(0);
    expect(result?.netPaid).toBe(1200);
  });

  it('fails closed when payment history cannot be read', async () => {
    const result = await getEntityBalance(makeSupabase([], { message: 'db error' }), {
      bookingId: 'booking-1',
      totalAmount: 1000,
    });

    expect(result).toBeNull();
  });
});
