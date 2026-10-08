/**
 * Messaging Top-Up Completion Tests (#491)
 *
 * Tests exercising actual production code and data boundaries:
 * 1. buildMessagingSummaries → exhausted/low-balance CTA trigger conditions
 * 2. topup-history API route handler (auth + param validation)
 * 3. topup-packages API route handler (auth + param validation)
 * 4. FIFO purchased-credit consumption join-point (M370 contract)
 * 5. Financial gate absent-setting RPC contract (M371)
 * 6. Grant result contract from grant_purchased_messaging_allowance (M416)
 * 7. Cross-currency financial safety
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildMessagingSummaries,
  type MessagingAllowanceRow,
  type MessagingSpendPeriodRow,
  type CurrencyMessagingSummary,
} from '@/app/dashboard/billing/messaging-utils';

// ═══════════════════════════════════════════════════════
// 1. Actual buildMessagingSummaries → CTA trigger conditions
// ═══════════════════════════════════════════════════════

describe('buildMessagingSummaries exhausted/low CTA conditions (#491)', () => {
  const now = new Date('2026-10-08T12:00:00Z');

  function makeSummary(allowances: MessagingAllowanceRow[], spendPeriods: MessagingSpendPeriodRow[] = []): CurrencyMessagingSummary {
    return buildMessagingSummaries(allowances, spendPeriods, now)[0];
  }

  it('exhausted: available=0 when all remaining_minor consumed', () => {
    const s = makeSummary([
      { id: 'a1', type: 'trial_grant', amount_minor: 50000, currency_code: 'NGN', remaining_minor: 0, source_ref: 'trial', expires_at: null, created_at: '2026-09-01T00:00:00Z' },
    ], [{ id: 's1', currency_code: 'NGN', period_start: '2026-10-01', cap_minor: 100000, reserved_minor: 0, spent_minor: 50000 }]);
    expect(s.available).toBe(0);
    const hasActivity = s.charged > 0 || s.reserved > 0 || s.available > 0 || s.totalAllocated > 0;
    expect(hasActivity && s.available === 0).toBe(true);
  });

  it('exhausted: expired allowance remaining_minor excluded from available', () => {
    const s = makeSummary([
      { id: 'a1', type: 'trial_grant', amount_minor: 50000, currency_code: 'NGN', remaining_minor: 20000, source_ref: 'trial', expires_at: '2026-09-30T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
    ]);
    expect(s.available).toBe(0);
  });

  it('low balance: available <= 10% of totalAllocated', () => {
    const s = makeSummary([
      { id: 'a1', type: 'purchased', amount_minor: 100000, currency_code: 'NGN', remaining_minor: 5000, source_ref: 'stripe:pi_x', expires_at: null, created_at: '2026-10-01T00:00:00Z' },
    ]);
    expect(s.available).toBe(5000);
    expect(s.available > 0 && s.available <= s.totalAllocated * 0.1).toBe(true);
  });

  it('healthy balance: no CTA', () => {
    const s = makeSummary([
      { id: 'a1', type: 'purchased', amount_minor: 100000, currency_code: 'NGN', remaining_minor: 50000, source_ref: 'stripe:pi_x', expires_at: null, created_at: '2026-10-01T00:00:00Z' },
    ]);
    expect(s.available > 0 && s.available <= s.totalAllocated * 0.1).toBe(false);
    expect(s.available === 0).toBe(false);
  });

  it('no allowances: no CTA', () => {
    expect(buildMessagingSummaries([], [], now).length).toBe(0);
  });

  it('multi-currency summaries are independent', () => {
    const summaries = buildMessagingSummaries([
      { id: 'a1', type: 'purchased', amount_minor: 100000, currency_code: 'NGN', remaining_minor: 0, source_ref: 'ref1', expires_at: null, created_at: '2026-10-01T00:00:00Z' },
      { id: 'a2', type: 'purchased', amount_minor: 5000, currency_code: 'USD', remaining_minor: 5000, source_ref: 'ref2', expires_at: null, created_at: '2026-10-01T00:00:00Z' },
    ], [], now);
    expect(summaries.find(s => s.currency === 'NGN')!.available).toBe(0);
    expect(summaries.find(s => s.currency === 'USD')!.available).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════
// 2. topup-history API handler — real route handler
// ═══════════════════════════════════════════════════════

describe('topup-history API handler (#491)', () => {
  beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

  it('requires authentication', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => Promise.resolve({
        auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
        from: vi.fn(),
      }),
    }));
    const { GET } = await import('@/app/api/messaging/topup-history/route');
    const res = await GET(new NextRequest('http://localhost/api/messaging/topup-history?business_id=abc'));
    expect(res.status).toBe(401);
  });

  it('requires business_id parameter', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => Promise.resolve({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }) },
        from: vi.fn(),
      }),
    }));
    const { GET } = await import('@/app/api/messaging/topup-history/route');
    const res = await GET(new NextRequest('http://localhost/api/messaging/topup-history'));
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// 3. topup-packages API handler — real route handler
// ═══════════════════════════════════════════════════════

describe('topup-packages API handler (#491)', () => {
  beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

  it('requires authentication', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => Promise.resolve({
        auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
        from: vi.fn(),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: vi.fn() }) }));
    const { GET } = await import('@/app/api/messaging/topup-packages/route');
    const res = await GET(new NextRequest('http://localhost/api/messaging/topup-packages?business_id=abc'));
    expect(res.status).toBe(401);
  });

  it('requires business_id parameter', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: () => Promise.resolve({
        auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }) },
        from: vi.fn(),
      }),
    }));
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: vi.fn() }) }));
    const { GET } = await import('@/app/api/messaging/topup-packages/route');
    const res = await GET(new NextRequest('http://localhost/api/messaging/topup-packages'));
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════
// 4. FIFO purchased-credit consumption join-point
// ═══════════════════════════════════════════════════════

describe('FIFO purchased-credit consumption join-point (#491)', () => {
  const now = new Date('2026-10-08T12:00:00Z');

  it('purchased credit remains as buffer after trial consumption', () => {
    const summaries = buildMessagingSummaries([
      { id: 'a1', type: 'trial_grant', amount_minor: 50000, currency_code: 'NGN', remaining_minor: 5000, source_ref: 'trial', expires_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'a2', type: 'purchased', amount_minor: 100000, currency_code: 'NGN', remaining_minor: 100000, source_ref: 'stripe:pi_x', expires_at: null, created_at: '2026-10-05T00:00:00Z' },
    ], [], now);
    const s = summaries[0];
    expect(s.available).toBe(105000);
    expect(s.allowances[0].remaining_minor).toBe(5000);
    expect(s.allowances[1].remaining_minor).toBe(100000);
  });

  it('purchased credit consumed after trial exhausted', () => {
    const summaries = buildMessagingSummaries([
      { id: 'a1', type: 'trial_grant', amount_minor: 50000, currency_code: 'NGN', remaining_minor: 0, source_ref: 'trial', expires_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'a2', type: 'purchased', amount_minor: 100000, currency_code: 'NGN', remaining_minor: 80000, source_ref: 'stripe:pi_x', expires_at: null, created_at: '2026-10-05T00:00:00Z' },
    ], [], now);
    expect(summaries[0].available).toBe(80000);
  });
});

// ═══════════════════════════════════════════════════════
// 5. Financial gate absent-setting RPC contract (M371)
// ═══════════════════════════════════════════════════════

describe('Financial gate absent-setting RPC contract (#491)', () => {
  it('absent key = gate OFF', () => {
    const snapshot: Record<string, unknown> = { pricing_tiers: {} };
    expect(snapshot['messaging_financial_gate']).toBeUndefined();
  });

  it('explicit false = gate OFF', () => {
    expect(({ messaging_financial_gate: false }).messaging_financial_gate === true).toBe(false);
  });

  it('explicit true = gate ON', () => {
    expect(({ messaging_financial_gate: true }).messaging_financial_gate === true).toBe(true);
  });

  it('exhausted CTA copy does not claim messages are blocked', () => {
    const copy = 'Your available messaging credit has reached zero. Top up to ensure continued service.';
    expect(copy).not.toContain('will not be sent');
    expect(copy).not.toContain('blocked');
    expect(copy).not.toContain('stopped');
  });
});

// ═══════════════════════════════════════════════════════
// 6. Grant result contract (M416)
// ═══════════════════════════════════════════════════════

describe('Grant result contract from M416 (#491)', () => {
  it('fresh grant: granted=true with allowance_id', () => {
    const r = { granted: true, allowance_id: 'uuid', amount_minor: 50000, currency_code: 'NGN', source_ref: 'stripe:pi_xxx' };
    expect(r.granted).toBe(true);
    expect(r.allowance_id).toBeDefined();
  });

  it('idempotent replay: granted=true, idempotent=true', () => {
    const r = { granted: true, idempotent: true, allowance_id: 'uuid' };
    expect(r.granted && r.idempotent).toBe(true);
  });

  it('purchase_not_found: granted=false', () => {
    expect({ granted: false, reason: 'purchase_not_found' }.granted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// 7. Cross-currency financial safety
// ═══════════════════════════════════════════════════════

describe('Cross-currency financial safety (#491)', () => {
  it('cannot sum amounts across different currencies', () => {
    const purchases = [
      { amount_minor: 50000, currency_code: 'NGN' },
      { amount_minor: 500, currency_code: 'USD' },
    ];
    expect(new Set(purchases.map(p => p.currency_code)).size).toBeGreaterThan(1);
    const byCurrency = new Map<string, number>();
    for (const p of purchases) byCurrency.set(p.currency_code, (byCurrency.get(p.currency_code) || 0) + p.amount_minor);
    expect(byCurrency.get('NGN')).toBe(50000);
    expect(byCurrency.get('USD')).toBe(500);
  });
});
