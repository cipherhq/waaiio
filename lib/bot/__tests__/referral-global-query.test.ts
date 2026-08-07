import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isReferralQuery,
  handleGlobalQuery,
} from '../handlers/global-queries';

// ── Mocks ──────────────────────────────────────────────
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/channels/message-sender', () => ({}));
vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v.replace(/[^a-zA-Z0-9+@._-]/g, ''),
}));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn(), getPoweredByHtml: vi.fn() }));

// ── Helpers ─────────────────────────────────────────────

function mockSupabase(overrides: Record<string, unknown> = {}) {
  const chainMock = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    delete: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    ...overrides,
  };
  return {
    from: vi.fn(() => chainMock),
    rpc: vi.fn().mockResolvedValue({ data: null }),
    _chain: chainMock,
  } as any;
}

function makeSession(opts: {
  businessId?: string | null;
  step?: string;
  capabilities?: string[];
  businessName?: string;
} = {}) {
  return {
    id: 'sess-1',
    whatsapp_number: '2348012345678',
    user_id: 'user-1',
    business_id: opts.businessId !== undefined ? opts.businessId : 'biz-1',
    current_step: opts.step ?? 'greeting',
    session_data: {
      capabilities: opts.capabilities ?? ['scheduling', 'referral'],
      business_name: opts.businessName ?? 'Test Salon',
    },
    is_active: true,
    version: 1,
  } as any;
}

function makeGlobalParams(overrides: Record<string, unknown> = {}) {
  const supabase = overrides.supabase || mockSupabase();
  const sendText = overrides.sendText || vi.fn();
  const session = overrides.session !== undefined ? overrides.session : makeSession();
  return {
    supabase,
    messageSender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } as any,
    flowExecutor: { execute: vi.fn() } as any,
    sendText,
    from: '2348012345678',
    session,
    text: overrides.text as string || 'refer',
    messageType: 'text',
    getProfile: vi.fn().mockResolvedValue({ id: 'user-1' }),
    handleMessage: vi.fn(),
    ...overrides,
  } as any;
}

// ══════════════════════════════════════════════════════════
// 1. isReferralQuery — pattern matching
// ══════════════════════════════════════════════════════════

describe('isReferralQuery', () => {
  it.each([
    'refer',
    'Refer',
    'REFER',
    'referral',
    'my referral',
    'referral code',
    'my referral code',
    'refer a friend',
    'invite a friend',
    'invite friend',
  ])('matches: "%s"', (text) => {
    expect(isReferralQuery(text)).toBe(true);
  });

  it.each([
    'reference',
    'preferred',
    'referencing',
    'book',
    'hello',
    'my bookings',
    'refer me to a doctor',
    'ABCDE6',    // referral code format — not a command
  ])('does NOT match: "%s"', (text) => {
    expect(isReferralQuery(text)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// 2. handleGlobalQuery — referral handler
// ══════════════════════════════════════════════════════════

describe('handleGlobalQuery — referral', () => {
  let sendText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendText = vi.fn();
  });

  // ── Test 1: returns existing referral code ──
  it('returns the current customer\'s existing referral code', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { referral_code: 'XHGK29', reward_type: 'points', reward_amount: 50 },
        error: null,
      }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'refer' });
    const result = await handleGlobalQuery(params);

    expect(result.handled).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain('XHGK29');
    expect(msg).toContain('50 loyalty points');
  });

  // ── Test 2: cannot return another customer's code ──
  it('cannot return another customer\'s code (scoped by phone)', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const params = makeGlobalParams({
      supabase,
      sendText,
      text: 'refer',
      from: '2349999999999', // different phone
    });
    const result = await handleGlobalQuery(params);

    expect(result.handled).toBe(true);
    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain("don't have a referral code yet");
    // Verify the query filters included the phone
    const orCall = supabase._chain.or.mock.calls.find((c: string[]) => c[0]?.includes('referrer_phone'));
    expect(orCall).toBeDefined();
  });

  // ── Test 3: cannot return another business's code ──
  it('cannot return another business\'s code (scoped by business_id)', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const session = makeSession({ businessId: 'biz-OTHER' });
    const params = makeGlobalParams({ supabase, sendText, text: 'refer', session });
    await handleGlobalQuery(params);

    // Verify business_id filter was applied
    const eqCalls = supabase._chain.eq.mock.calls;
    const bizFilter = eqCalls.find((c: string[]) => c[0] === 'business_id' && c[1] === 'biz-OTHER');
    expect(bizFilter).toBeDefined();
  });

  // ── Test 4: no eligible code returns safe message ──
  it('returns a helpful message when no referral code exists', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'refer' });
    const result = await handleGlobalQuery(params);

    expect(result.handled).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain("don't have a referral code yet");
    expect(msg).toContain('Complete a booking');
  });

  // ── Test 5: referral capability disabled ──
  it('does not expose referral code when capability is disabled', async () => {
    const session = makeSession({ capabilities: ['scheduling'] }); // no 'referral'
    const supabase = mockSupabase();

    const params = makeGlobalParams({ supabase, sendText, text: 'refer', session });
    const result = await handleGlobalQuery(params);

    expect(result.handled).toBe(true);
    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain("doesn't have a referral program");
    // Should NOT have queried the referrals table
    const fromCalls = supabase.from.mock.calls.map((c: string[]) => c[0]);
    expect(fromCalls).not.toContain('referrals');
  });

  // ── Test 6: works through the global query entry path ──
  it('handles "refer" from any active step without deactivating session', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { referral_code: 'ABC123', reward_type: 'points', reward_amount: 100 },
        error: null,
      }),
    });

    // Customer is mid-booking (select_service step) and types "refer"
    const session = makeSession({ step: 'select_service' });
    const params = makeGlobalParams({ supabase, sendText, text: 'refer', session });
    const result = await handleGlobalQuery(params);

    expect(result.handled).toBe(true);
    // Session should be returned unchanged — not deactivated
    expect(result.session).toBe(session);
    // Should NOT have called deactivate
    expect(supabase.rpc).not.toHaveBeenCalled();
    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain('ABC123');
  });

  // ── Test 7: unrelated keywords are not affected ──
  it('does not intercept unrelated keywords', async () => {
    const supabase = mockSupabase();
    const params = makeGlobalParams({ supabase, sendText, text: 'my bookings' });
    // This should NOT be handled by the referral handler — it'll be handled by bookings
    // We're just verifying "my bookings" doesn't trigger referral
    const result = await handleGlobalQuery(params);

    // It will be handled by the bookings handler, not referral
    // Verify referrals table was not queried
    const fromCalls = supabase.from.mock.calls.map((c: string[]) => c[0]);
    const referralQueries = fromCalls.filter((t: string) => t === 'referrals');
    expect(referralQueries.length).toBe(0);
  });

  // ── Test 8: session is not corrupted ──
  it('does not modify session state', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { referral_code: 'CODE01', reward_type: 'discount', reward_amount: 10 },
        error: null,
      }),
    });

    const session = makeSession({ step: 'collect_email' });
    const originalStep = session.current_step;
    const originalData = { ...session.session_data };

    const params = makeGlobalParams({ supabase, sendText, text: 'refer', session });
    await handleGlobalQuery(params);

    // Session step and data must be unchanged
    expect(session.current_step).toBe(originalStep);
    expect(session.session_data.capabilities).toEqual(originalData.capabilities);
    expect(session.business_id).toBe('biz-1');
  });

  // ── Test 9: no business context — falls through ──
  it('falls through when no business_id on session', async () => {
    const session = makeSession({ businessId: null });
    const supabase = mockSupabase();

    const params = makeGlobalParams({ supabase, sendText, text: 'refer', session });
    const result = await handleGlobalQuery(params);

    // Should NOT be handled by referral (requires business_id)
    // Verify referrals table was not queried
    const fromCalls = supabase.from.mock.calls.map((c: string[]) => c[0]);
    expect(fromCalls).not.toContain('referrals');
  });

  // ── Test 10: reward type rendering ──
  it('renders discount reward type correctly', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { referral_code: 'DISC20', reward_type: 'discount', reward_amount: 20 },
        error: null,
      }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'my referral code' });
    await handleGlobalQuery(params);

    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain('DISC20');
    expect(msg).toContain('discount');
  });

  it('renders freebie reward type correctly', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { referral_code: 'FREE01', reward_type: 'freebie', reward_amount: 1 },
        error: null,
      }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'referral' });
    await handleGlobalQuery(params);

    const msg = sendText.mock.calls[0][1] as string;
    expect(msg).toContain('FREE01');
    expect(msg).toContain('reward');
  });

  // ── Test 11: phone normalization covers both formats ──
  it('queries both phone formats (with and without +)', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'refer', from: '2348012345678' });
    await handleGlobalQuery(params);

    // The .or() filter should contain both +2348012345678 and 2348012345678
    const orCall = supabase._chain.or.mock.calls.find((c: string[]) => c[0]?.includes('referrer_phone'));
    expect(orCall).toBeDefined();
    expect(orCall![0]).toContain('+2348012345678');
    expect(orCall![0]).toContain('2348012345678');
  });

  // ── Test 12: status scoping — only pending codes returned ──
  it('only queries pending referral codes', async () => {
    const supabase = mockSupabase({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });

    const params = makeGlobalParams({ supabase, sendText, text: 'refer' });
    await handleGlobalQuery(params);

    // Verify .eq('status', 'pending') was called
    const eqCalls = supabase._chain.eq.mock.calls;
    const statusFilter = eqCalls.find((c: string[]) => c[0] === 'status' && c[1] === 'pending');
    expect(statusFilter).toBeDefined();
  });
});
