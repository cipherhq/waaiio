/**
 * P0-CONFIRM-1 — Mock control-flow tests for confirmation lifecycle
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function buildMock(rpcMap: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const rpcCalls: string[] = [];
  mockRpc.mockImplementation((name: string) => {
    rpcCalls.push(name);
    const r = rpcMap[name];
    return Promise.resolve({ data: r?.data ?? null, error: r?.error ?? null });
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
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234123', business_id: 'b1', reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 50, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG' }, services: { name: 'S', duration: 30 } }, error: null });
    if (table === 'businesses') c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'free', owner_id: 'o1' }, error: null });
    if (table === 'profiles') c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null });
    return c;
  });
  return { rpc: mockRpc, from: mockFrom, _rpcCalls: rpcCalls } as any;
}

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('U') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));

const CLAIM_OK = { data: { claimed: true, claim_token: 'tok-aaa', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null } };
const RENEW_OK = { data: { renewed: true } };
const FIN_OK = { data: { finalized: true, already_finalized: false } };
const REL_OK = { data: { released: true } };
const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null };

describe('P0-CONFIRM-1: Control-flow tests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. renewal success → processing continues', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledWith('finalize_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('2. renewal RPC error → stops before next side effect', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('3. renewed:false stops processing', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { data: { renewed: false, reason: 'token_mismatch' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('finalize_payment_confirmation', expect.anything());
  });

  it('4. token_mismatch stops stale worker — no release, no finalize', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: { data: { renewed: false, reason: 'token_mismatch' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('5. already_completed claim → zero side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: false, already_completed: true } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('6. no-business release uses helper correctly', async () => {
    const s = buildMock({ claim_payment_confirmation: { ...CLAIM_OK, data: { ...CLAIM_OK.data, booking_id: null } }, release_payment_confirmation: REL_OK });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, { ...pay, booking_id: null });
    // No business found → release should have been called
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });

  it('7. claim RPC error → zero downstream', async () => {
    const s = buildMock({ claim_payment_confirmation: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('8. finalize succeeds on first attempt', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: FIN_OK });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
  });

  it('9. finalize error retries and succeeds', async () => {
    let finCallCount = 0;
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK });
    mockRpc.mockImplementation((name: string) => {
      if (name === 'finalize_payment_confirmation') {
        finCallCount++;
        if (finCallCount === 1) return Promise.resolve({ data: null, error: { message: 'timeout' } });
        return Promise.resolve({ data: { finalized: true, already_finalized: false }, error: null });
      }
      const map: Record<string, any> = { claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK };
      return Promise.resolve({ data: map[name]?.data ?? null, error: map[name]?.error ?? null });
    });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
  });

  it('10. finalize both attempts fail → no release after sends', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: { error: { message: 'db' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('11. finalize token_mismatch → no release', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, renew_payment_confirmation_claim: RENEW_OK, finalize_payment_confirmation: { data: { finalized: false, reason: 'token_mismatch' } } });
    const { logger } = await import('@/lib/logger');
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Confirmation finalized'));
    expect(mockRpc).not.toHaveBeenCalledWith('release_payment_confirmation', expect.anything());
  });

  it('12. no claim token in response → zero side effects', async () => {
    const s = buildMock({ claim_payment_confirmation: { data: { claimed: true, payment_id: 'p1' } } });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('13. outer catch releases when no external sends occurred', async () => {
    const s = buildMock({ claim_payment_confirmation: CLAIM_OK, release_payment_confirmation: REL_OK });
    s.from = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const { sendProactiveConfirmation } = await import('../payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);
    expect(mockRpc).toHaveBeenCalledWith('release_payment_confirmation', expect.objectContaining({ p_claim_token: 'tok-aaa' }));
  });
});
