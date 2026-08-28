/**
 * #165 / #213 Fix 3: Interaction-boundary authorization tests.
 *
 * Tests that handleRecurringSetupInteraction correctly enforces:
 *   - Payer identity (user_id match)
 *   - Null userId rejection
 *   - Cross-business tenant isolation
 *   - Expired intent rejection
 *   - Terminal state rejection (declined/expired/setup_failed)
 *   - Decline with wrong user rejection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock logger ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

import { handleRecurringSetupInteraction } from '../recurring-setup';

// ── Helpers ──

const INTENT_ID = '11111111-1111-1111-1111-111111111111';
const BUSINESS_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_BUSINESS_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '44444444-4444-4444-4444-444444444444';
const WRONG_USER_ID = '55555555-5555-5555-5555-555555555555';
const PHONE = '+2348000000000';

function makeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    source_payment_id: '66666666-6666-6666-6666-666666666666',
    business_id: BUSINESS_ID,
    user_id: USER_ID,
    service_id: null,
    amount: 5000,
    currency: 'NGN',
    frequency: null,
    status: 'offered',
    provider: 'paystack',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h future
    provider_customer_code: null,
    provider_authorization_code: null,
    provider_plan_id: null,
    consent_at: null,
    consent_message_hash: null,
    ...overrides,
  };
}

function makeMockSupabase(intent: ReturnType<typeof makeIntent> | null) {
  const rpcMock = vi.fn().mockResolvedValue({ data: { transitioned: true }, error: null });

  const supabase = {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: intent,
            error: intent ? null : { message: 'not found' },
          }),
        }),
      }),
    }),
    rpc: rpcMock,
  } as unknown as Parameters<typeof handleRecurringSetupInteraction>[0];

  return { supabase, rpcMock };
}

describe('handleRecurringSetupInteraction authorization (#213 Fix 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('valid payer proceeds (offered state shows frequency prompt)', async () => {
    const intent = makeIntent();
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    // Should proceed — handled is true, no rejection message about identity/tenant
    expect(result.handled).toBe(true);
    // No message means it proceeded to the frequency selection flow (sender is null so no buttons sent)
    expect(result.message).toBeUndefined();
  });

  it('wrong user_id is rejected', async () => {
    const intent = makeIntent();
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, WRONG_USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('different account');
  });

  it('null userId is rejected', async () => {
    const intent = makeIntent();
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, null, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('Unable to verify');
  });

  it('cross-business intent is rejected', async () => {
    const intent = makeIntent(); // business_id = BUSINESS_ID
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, OTHER_BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('not valid for this business');
  });

  it('expired intent is rejected', async () => {
    const intent = makeIntent({
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1s in the past
    });
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('expired');
  });

  it('terminal state (declined) is rejected', async () => {
    const intent = makeIntent({ status: 'declined' });
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('declined');
  });

  it('terminal state (expired) is rejected', async () => {
    const intent = makeIntent({
      status: 'expired',
      expires_at: new Date(Date.now() + 1000).toISOString(), // not time-expired, state-expired
    });
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('expired');
  });

  it('terminal state (setup_failed) is rejected', async () => {
    const intent = makeIntent({ status: 'setup_failed' });
    const { supabase } = makeMockSupabase(intent);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('could not be completed');
  });

  it('decline with wrong user is rejected at DB level', async () => {
    // frequency_selected state, user tries to decline but is wrong user
    const intent = makeIntent({ status: 'frequency_selected', frequency: 'monthly' });
    const { supabase, rpcMock } = makeMockSupabase(intent);

    // Mock the decline RPC to return user_mismatch
    rpcMock.mockResolvedValueOnce({
      data: { declined: false, reason: 'user_mismatch' },
      error: null,
    });

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'recurring_consent:decline:' + INTENT_ID, null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('different account');
  });

  it('intent not found returns expiry/invalid message', async () => {
    const { supabase } = makeMockSupabase(null);

    const result = await handleRecurringSetupInteraction(
      supabase, INTENT_ID, BUSINESS_ID, USER_ID, PHONE, 'setup', null,
    );

    expect(result.handled).toBe(true);
    expect(result.message).toContain('expired or is invalid');
  });
});
