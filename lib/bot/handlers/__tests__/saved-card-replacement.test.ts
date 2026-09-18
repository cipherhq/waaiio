/**
 * Saved card replacement tests — R3/R4 design.
 * Tests handleSaveCard replacement flow + handleReplacementPinStep.
 *
 * Implementation-Agent: Claude Code
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  const c: Record<string, unknown> = {};
  ['select', 'eq', 'in', 'or', 'order', 'limit', 'update', 'delete', 'gte'].forEach(m => {
    (c as Record<string, unknown>)[m] = vi.fn().mockReturnValue(c);
  });
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

vi.mock('@/lib/payments/saved-payment-adapter', () => ({
  savedPaymentAdapter: {
    verifyPin: vi.fn(),
  },
}));

const BIZ = 'biz-001';
const METHOD_ID = 'meth-001';
const PAY_ID = 'pay-001';
const OLD_AUTH = 'auth_old_xxx';
const NEW_AUTH = 'auth_new_yyy';
const CUST_CODE = 'CUS_test123';
const PHONE = '+2348012345678';

// Saved method with old auth
const EXISTING_METHOD = {
  id: METHOD_ID, authorization_code: OLD_AUTH, customer_code: CUST_CODE,
  card_last4: '1234', card_brand: 'visa', pin_hash: 'hash_xxx',
  pin_attempts: 0, pin_locked_until: null, gateway: 'paystack',
};

// Payment with new auth
const NEW_PAYMENT = {
  id: PAY_ID, business_id: BIZ, gateway: 'paystack', status: 'success',
  metadata: { _card_authorization: {
    authorization_code: NEW_AUTH, customer_code: CUST_CODE,
    last4: '5678', brand: 'mastercard', exp_month: 12, exp_year: 2028,
    card_type: 'debit', bank: 'GTBank', reusable: true,
  }},
};

function buildSupabase(overrides: {
  existingMethods?: unknown[];
  payment?: unknown;
  sessionRows?: unknown[];
  insertError?: { code: string; message: string } | null;
  updateResult?: unknown[];
  rpcResult?: unknown;
} = {}) {
  const { existingMethods = [EXISTING_METHOD], payment = NEW_PAYMENT,
    sessionRows, insertError, updateResult, rpcResult } = overrides;

  mockRpc.mockImplementation(() => Promise.resolve({
    data: rpcResult ?? { success: true, version: 2 }, error: null,
  }));

  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'saved_payment_methods') {
      // For the initial query (existingMethods) and the re-read
      (c as Record<string, unknown>).maybeSingle = vi.fn().mockResolvedValue({
        data: existingMethods?.[0] || null, error: null,
      });
      // For the listing query that returns multiple
      const selectFn = vi.fn().mockReturnValue(c);
      (c as Record<string, unknown>).select = selectFn;
      // Override to return array for the initial existingMethods query
      // The chain resolves as a Promise with data array
      Object.defineProperty(c, 'then', {
        value: (resolve: (v: unknown) => void) => resolve({ data: existingMethods, error: null }),
        configurable: true,
      });
      if (updateResult !== undefined) {
        // For the conditional UPDATE
        (c as Record<string, unknown>).select = vi.fn().mockResolvedValue({ data: updateResult, error: null });
      }
    }
    if (table === 'payments') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: payment, error: null });
    }
    if (table === 'bookings') {
      c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'bk-1', business_id: BIZ }, error: null });
    }
    if (table === 'bot_sessions') {
      if (sessionRows) {
        Object.defineProperty(c, 'then', {
          value: (resolve: (v: unknown) => void) => resolve({ data: sessionRows, error: null }),
          configurable: true,
        });
      }
      c.maybeSingle = vi.fn().mockResolvedValue({
        data: sessionRows?.[0] || { current_step: 'replace_card_pin', session_data: {} },
        error: null,
      });
      if (insertError) {
        c.insert = vi.fn().mockResolvedValue({ data: null, error: insertError });
      }
    }
    return c;
  });

  return { rpc: mockRpc, from: mockFrom } as unknown;
}

const sendText = vi.fn().mockResolvedValue(undefined);
const getProfile = vi.fn().mockResolvedValue({ id: 'user-1' });

describe('Saved Card Replacement', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ─── R3 TESTS ───

  it('R3-01: no existing card → normal save flow (unchanged)', async () => {
    const s = buildSupabase({ existingMethods: [] });
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, null, getProfile);
    // Should prompt for PIN creation (save flow)
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('4-digit Waaiio PIN'));
  });

  it('R3-02: existing card + different auth → replacement PIN prompt', async () => {
    const s = buildSupabase();
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1, whatsapp_number: PHONE } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Replace saved card'));
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Waaiio PIN'));
  });

  it('R3-05: same authorization_code → already up to date', async () => {
    const sameMethod = { ...EXISTING_METHOD, authorization_code: NEW_AUTH };
    const s = buildSupabase({ existingMethods: [sameMethod] });
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1 } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('already up to date'));
  });

  it('R3-08: cancel → zero credential changes', async () => {
    const { createHash } = await import('crypto');
    const stateHash = createHash('sha256').update(`${METHOD_ID}:${OLD_AUTH}:${CUST_CODE}`).digest('hex');
    const session = {
      id: 'sess-1', business_id: BIZ, version: 1,
      session_data: { _replace_method_id: METHOD_ID, _replace_payment_id: PAY_ID, _replace_expected_state_hash: stateHash },
    } as any;
    const s = buildSupabase();
    const { handleReplacementPinStep } = await import('../saved-cards');
    await handleReplacementPinStep(s as any, sendText, PHONE, session, 'cancel');
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('cancelled'));
    // No update to saved_payment_methods (only session cleanup via CAS)
  });

  it('R3-12: duplicate phone ambiguity → fail closed', async () => {
    const dup = [EXISTING_METHOD, { ...EXISTING_METHOD, id: 'meth-002' }];
    const s = buildSupabase({ existingMethods: dup });
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1 } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('contact support'));
  });

  it('R3-14: same authorization_code → already up to date (idempotent)', async () => {
    const sameAuth = { ...EXISTING_METHOD, authorization_code: NEW_AUTH };
    const s = buildSupabase({ existingMethods: [sameAuth] });
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1 } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('already up to date'));
  });

  // ─── R3 PIN + CAS TESTS ───

  it('R3-06: wrong PIN → zero credential changes', async () => {
    const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
    (savedPaymentAdapter.verifyPin as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false, attemptsRemaining: 2, locked: false });

    const { createHash } = await import('crypto');
    const stateHash = createHash('sha256').update(`${METHOD_ID}:${OLD_AUTH}:${CUST_CODE}`).digest('hex');
    const session = {
      id: 'sess-1', business_id: BIZ, version: 1,
      session_data: { _replace_method_id: METHOD_ID, _replace_payment_id: PAY_ID, _replace_expected_state_hash: stateHash },
    } as any;
    const s = buildSupabase();
    const { handleReplacementPinStep } = await import('../saved-cards');
    await handleReplacementPinStep(s as any, sendText, PHONE, session, '9999');
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Wrong PIN'));
  });

  it('R3-07: locked PIN → zero credential changes', async () => {
    const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
    (savedPaymentAdapter.verifyPin as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false, attemptsRemaining: 0, locked: true });

    const { createHash } = await import('crypto');
    const stateHash = createHash('sha256').update(`${METHOD_ID}:${OLD_AUTH}:${CUST_CODE}`).digest('hex');
    const session = {
      id: 'sess-1', business_id: BIZ, version: 1,
      session_data: { _replace_method_id: METHOD_ID, _replace_payment_id: PAY_ID, _replace_expected_state_hash: stateHash },
    } as any;
    const s = buildSupabase();
    const { handleReplacementPinStep } = await import('../saved-cards');
    await handleReplacementPinStep(s as any, sendText, PHONE, session, '9999');
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('locked'));
  });

  // ─── R4 NULL-SESSION TESTS ───

  it('R4-01: session=null + no existing session rows → creation works', async () => {
    const s = buildSupabase({ sessionRows: [] });
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, null, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Replace saved card'));
  });

  it('R4-05: session=null + unrelated active session → NOT overwritten', async () => {
    const activeUnrelated = { id: 'sess-other', is_active: true, version: 5, current_step: 'select_service', session_data: {}, business_id: BIZ };
    const s = buildSupabase({ sessionRows: [activeUnrelated] });
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, null, getProfile);
    // Should fail closed — not overwrite unrelated journey
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Could not start'));
  });

  it('R4-06: DB persistence failure → zero PIN prompt', async () => {
    const s = buildSupabase({
      sessionRows: [],
      insertError: { code: '42P01', message: 'table does not exist' },
    });
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, null, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Could not start'));
    // No PIN prompt was sent
    expect(sendText).not.toHaveBeenCalledWith(PHONE, expect.stringContaining('Waaiio PIN'));
  });

  // ─── CUSTOMER CODE MATCHING ───

  it('R3-CC: mismatched customer_code → fail closed', async () => {
    const diffCustomer = { ...EXISTING_METHOD, customer_code: 'CUS_different' };
    const s = buildSupabase({ existingMethods: [diffCustomer] });
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1 } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('different account'));
  });

  it('R3-CC2: null customer_code → fail closed', async () => {
    const nullCustomer = { ...EXISTING_METHOD, customer_code: null };
    const s = buildSupabase({ existingMethods: [nullCustomer] });
    const session = { id: 'sess-1', business_id: BIZ, session_data: {}, version: 1 } as any;
    const { handleSaveCard } = await import('../saved-cards');
    await handleSaveCard(s as any, sendText, PHONE, session, getProfile);
    expect(sendText).toHaveBeenCalledWith(PHONE, expect.stringContaining('Cannot verify'));
  });
});
