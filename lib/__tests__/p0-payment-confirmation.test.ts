/**
 * P0-CONFIRM-1 — Payment confirmation claim ownership + RPC error handling
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function buildMock(rpcResults: Record<string, { data?: unknown; error?: unknown }> = {}) {
  mockRpc.mockImplementation((name: string) => {
    const r = rpcResults[name];
    if (r) return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    return Promise.resolve({ data: null, error: null });
  });
  const chain = () => {
    const c: Record<string, any> = {};
    ['select','eq','is','in','or','not','order','limit','update'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') {
      c.single = vi.fn().mockResolvedValue({
        data: { guest_phone: '+2341234567890', business_id: 'biz-001', reference_code: 'BW-X1',
                date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 50, deposit_amount: 50,
                businesses: { name: 'Biz', country_code: 'NG' }, services: { name: 'Svc', duration: 30 } },
        error: null,
      });
    }
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
    return c;
  });
  return { rpc: mockRpc, from: mockFrom } as any;
}

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('User') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));

const CLAIM_OK = {
  data: { claimed: true, claim_token: 'tok-aaa-bbb', payment_id: 'pay-001', amount: 50,
    booking_id: 'bk-001', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null },
};
const FINALIZE_OK = { data: { finalized: true, already_finalized: false } };
const RELEASE_OK = { data: { released: true } };

describe('P0-CONFIRM-1: Claim ownership + RPC error handling', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('1. claim returns ownership token', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FINALIZE_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null }, '[T]');
    expect(mockRpc).toHaveBeenCalledWith('claim_payment_confirmation', { p_payment_id: 'pay-001' });
  });

  it('2. finalize passes claim token', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, finalize_payment_confirmation: FINALIZE_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', { p_payment_id: 'pay-001', p_claim_token: 'tok-aaa-bbb' });
  });

  it('3. release passes claim token on failure', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, release_payment_confirmation: RELEASE_OK });
    // Override from() to throw AFTER buildMock sets up RPC
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', { p_payment_id: 'pay-001', p_claim_token: 'tok-aaa-bbb' });
  });

  it('4. finalize with wrong token (token_mismatch) is not logged as success', async () => {
    const s = buildMock({
      claim_payment_confirmation: CLAIM_OK,
      finalize_payment_confirmation: { data: { finalized: false, reason: 'token_mismatch' } },
    });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Finalization not confirmed'));
  });

  it('5. already completed claim skips all side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: false, already_completed: true, reason: 'already_sent' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: null, invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('6. concurrent claim loser performs no side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: false, reason: 'processing_in_progress' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: null, invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('7. non-successful payment rejected', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: false, reason: 'not_successful', status: 'pending' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: null, invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('8. claim RPC error → no side effects, no finalize', async () => {
    const s = buildMock({ claim_payment_confirmation: { error: { message: 'db error' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: null, invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('9. finalize RPC error does NOT release (avoids duplicate retry after sends)', async () => {
    const s = buildMock({
      claim_payment_confirmation: CLAIM_OK,
      finalize_payment_confirmation: { error: { message: 'timeout' } },
    });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null });
    // Should NOT call release (sends already happened)
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
    // Should retry finalize
    const finCalls = mockRpc.mock.calls.filter((c: any[]) => c[0] === 'finalize_payment_confirmation');
    expect(finCalls.length).toBe(2); // original + retry
  });

  it('10. release RPC error is logged but does not throw', async () => {
    const s = buildMock({
      claim_payment_confirmation: CLAIM_OK,
      release_payment_confirmation: { error: { message: 'db error' } },
    });
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    // Should not throw
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: 'bk-001', invoice_id: null, campaign_id: null });
  });

  it('11. claim with incomplete data (no token) stops before side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: true, payment_id: 'pay-001' } } }); // no claim_token
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { id: 'pay-001', amount: 50, booking_id: null, invoice_id: null, campaign_id: null });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('12. no sensitive data in RPC return fields', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/307_confirmation_claim_lifecycle.sql'), 'utf-8');
    for (const field of ['customer_phone', 'customer_email', 'gateway_reference', 'card_', 'token']) {
      // claim_token is the only 'token' — it's a UUID, not a secret
      if (field === 'token') {
        expect(src).toContain('claim_token'); // our UUID field
        expect(src).not.toContain('access_token');
      } else {
        expect(src).not.toContain(field);
      }
    }
  });
});
