/**
 * #373: Saved-card reuse cold country cache regression tests.
 *
 * Proves chargeSavedCard uses authoritative DB-based currency resolution
 * instead of the module-global country cache. Tests cover:
 * - Cold cache + US → USD reaches adapter
 * - Cold cache + NG → NGN reaches adapter
 * - Missing/inactive country → zero provider dispatch
 * - DB error → fail closed without crash
 * - Malformed currency → fail closed
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChargeSavedMethod, mockLogError } = vi.hoisted(() => ({
  mockChargeSavedMethod: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    chargeSavedMethod: mockChargeSavedMethod,
    getSavedMethods: vi.fn().mockResolvedValue([]),
    requiresPin: vi.fn().mockResolvedValue({ required: false }),
    verifyPin: vi.fn().mockResolvedValue({ valid: true }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    error: mockLogError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ error: mockLogError, warn: vi.fn(), info: vi.fn() }),
  },
}));

import { handleSavedCardInput } from '../bot/flows/shared/saved-card-flow';
import type { FlowContext } from '../bot/flows/types';

function makeCtx(overrides: Partial<FlowContext> = {}): FlowContext {
  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { currency_code: 'USD' }, error: null }),
          }),
        }),
      }),
    }),
  } as never;

  return {
    supabase,
    from: '15551234567',
    sender: { sendText: vi.fn().mockResolvedValue({ messageId: 'test' }) },
    t: (key: string) => key,
    business: {
      id: 'biz-123',
      name: 'Test Business',
      country_code: 'US',
    } as FlowContext['business'],
    session: {
      id: 'session-123',
      whatsapp_number: '15551234567',
      business_id: 'biz-123',
      current_step: 'saved_card_prompt',
      session_data: {
        _saved_method_id: 'method-123',
        _awaiting_card_pin: true,
      },
      is_active: true,
      version: 1,
    } as FlowContext['session'],
    ...overrides,
  } as FlowContext;
}

function makeSupabaseWithCountry(currencyCode: string | null, error: unknown = null, countryExists = true) {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: countryExists ? { currency_code: currencyCode } : null,
              error,
            }),
          }),
        }),
      }),
    }),
  } as never;
}

describe('#373: Saved-card cold cache — authoritative currency resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cold cache + US → adapter receives USD', async () => {
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-1' });

    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('USD'),
    });
    ctx.business!.country_code = 'US';

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 2000, reference: 'WA-BK-TEST',
      entityId: { bookingId: 'booking-1' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    // Verify adapter was called with USD (not from cache)
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('USD');
  });

  it('cold cache + NG → adapter receives NGN', async () => {
    mockChargeSavedMethod.mockResolvedValue({ status: 'charged', paymentId: 'pay-2' });

    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('NGN'),
    });
    ctx.business!.country_code = 'NG';

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 5000, reference: 'WA-BK-NG',
      entityId: { bookingId: 'booking-2' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(mockChargeSavedMethod).toHaveBeenCalledTimes(1);
    expect(mockChargeSavedMethod.mock.calls[0][1].currency).toBe('NGN');
  });

  it('missing/inactive country → zero provider dispatch, fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(null, null, false), // countryExists = false
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-MISS',
      entityId: { bookingId: 'booking-3' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.errorMessage).toContain('could not process');
    // Zero provider dispatch
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('DB error → fail closed without crash, zero provider dispatch', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(null, { message: 'connection timeout' }),
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-ERR',
      entityId: { bookingId: 'booking-4' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('malformed currency (lowercase) → fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry('usd'), // lowercase = malformed
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-MALFORM',
      entityId: { bookingId: 'booking-5' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('malformed currency (empty string) → fail closed', async () => {
    const ctx = makeCtx({
      supabase: makeSupabaseWithCountry(''),
    });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-EMPTY',
      entityId: { bookingId: 'booking-6' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });

  it('DB throw → fail closed without crashing the bot', async () => {
    const throwingSupabase = {
      from: vi.fn().mockImplementation(() => { throw new Error('DB connection lost'); }),
    } as never;

    const ctx = makeCtx({ supabase: throwingSupabase });

    const result = await handleSavedCardInput('pay_saved', ctx, {
      amount: 1000, reference: 'WA-BK-THROW',
      entityId: { bookingId: 'booking-7' }, transactionCategory: 'scheduling',
    });

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(mockChargeSavedMethod).not.toHaveBeenCalled();
  });
});
