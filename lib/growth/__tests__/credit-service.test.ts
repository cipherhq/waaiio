import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBalance, reserveCredits, grantCredits } from '../credit-service';

// Mock Supabase client
function createMockSupabase(overrides: Record<string, unknown> = {}) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    update: vi.fn().mockReturnThis(),
  };

  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
    ...overrides,
  } as unknown as Parameters<typeof getBalance>[0];
}

describe('Credit Service — getBalance', () => {
  it('returns zero balance when no credits exist', async () => {
    const supabase = createMockSupabase();
    (supabase as any)._chain.select.mockReturnThis();
    (supabase as any)._chain.eq.mockReturnThis();
    (supabase as any)._chain.gt.mockResolvedValueOnce({ data: [] });
    (supabase as any)._chain.in.mockResolvedValueOnce({ data: [] });

    const balance = await getBalance(supabase, 'biz-123');
    expect(balance.total).toBe(0);
    expect(balance.available).toBe(0);
    expect(balance.reserved).toBe(0);
  });
});

describe('Credit Service — reserveCredits', () => {
  it('fails when insufficient credits', async () => {
    const supabase = createMockSupabase();
    // Mock getBalance to return 0 available
    const chain = (supabase as any)._chain;
    chain.gt.mockResolvedValueOnce({ data: [] }); // credits query
    chain.in.mockResolvedValueOnce({ data: [] }); // reserved query

    const result = await reserveCredits(supabase, 'biz-123', 'camp-1', 100);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient');
  });
});

describe('Credit Service — grantCredits', () => {
  it('inserts credit record and transaction', async () => {
    const insertCalls: unknown[] = [];
    const supabase = createMockSupabase();
    const chain = (supabase as any)._chain;
    chain.insert.mockImplementation((data: unknown) => {
      insertCalls.push(data);
      return Promise.resolve({ error: null });
    });

    const result = await grantCredits(supabase, 'biz-123', 'included', 100, 'subscription');
    expect(result.success).toBe(true);
    // Should have called insert twice (credit + transaction)
    expect(insertCalls.length).toBe(2);
  });
});
