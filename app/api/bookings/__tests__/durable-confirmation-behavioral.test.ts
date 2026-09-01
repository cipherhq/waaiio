/**
 * #244: Durable Confirmation Intent — Behavioral route tests.
 *
 * Tests the actual route handlers with mocked dependencies to verify:
 *
 * 1. Booking succeeds independently of notification outcome
 * 2. One logical create confirmation -> max one WhatsApp provider call
 * 3. Pre-dispatch failure safely retryable (booking still succeeds)
 * 4. Unresolved create intent blocks unsafe resend
 * 5. Cross-business denial
 * 6. Route-level provider-call-count tests
 * 7. singleAttemptWhatsAppSend used instead of sendOrEmail (no retry)
 * 8. p_booking_amount: 0 verified
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks (must be declared before vi.mock due to hoisting) ──
const {
  mockSingleAttemptSend,
  mockSendEmail,
  mockResolveByBusinessId,
  mockCloudSendText,
} = vi.hoisted(() => {
  const mockCloudSendText = vi.fn();
  const mockSingleAttemptSend = vi.fn();
  const mockSendEmail = vi.fn();
  const mockResolveByBusinessId = vi.fn();
  return { mockSingleAttemptSend, mockSendEmail, mockResolveByBusinessId, mockCloudSendText };
});

// ── Provider call tracking ──
let whatsappProviderCallCount = 0;

vi.mock('@/lib/channels/single-attempt-send', () => ({
  singleAttemptWhatsAppSend: mockSingleAttemptSend,
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: vi.fn().mockReturnValue({ html: '<p>test</p>' }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/channels/channel-resolver', () => {
  return {
    ChannelResolver: class MockChannelResolver {
      resolveByBusinessId(...args: unknown[]) {
        return mockResolveByBusinessId(...args);
      }
    },
  };
});

vi.mock('@/lib/channels/send-or-email', () => ({
  findCustomerEmail: vi.fn().mockResolvedValue('test@test.com'),
}));

// ── Supabase mock ──
const BIZ_ID = 'biz-test-244';
const BOOKING_ID = 'booking-test-244';
const USER_ID = 'user-test-244';
const INTENT_ID = 'intent-test-244';
const CLAIM_TOKEN = 'token-test-244';

const mockRpc = vi.fn();
const mockServiceFrom = vi.fn();
const mockAuthGetUser = vi.fn();

function buildChain(result: { data: any; error?: any }) {
  const chain: Record<string, any> = {};
  ['select', 'eq', 'not', 'is', 'in', 'update', 'insert', 'order', 'limit'].forEach(
    (m) => (chain[m] = vi.fn().mockReturnValue(chain))
  );
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  chain.single = vi.fn().mockResolvedValue(result);
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void, reject?: (v: unknown) => void) => {
      return Promise.resolve(result).then(resolve, reject);
    },
    writable: true,
  });
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockServiceFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: () => mockAuthGetUser() },
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireAnyCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: vi.fn().mockResolvedValue('customer-id-244'),
}));

// ── Helpers ──
function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/bookings/create-manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeConfirmRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/bookings/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const defaultBookingBody = {
  businessId: BIZ_ID,
  serviceId: 'svc-1',
  date: '2027-01-15',
  time: '10:00',
  customerName: 'John Doe',
  customerPhone: '+2348001234567',
  sendConfirmation: true,
};

function setupDefaultMocks() {
  whatsappProviderCallCount = 0;
  mockCloudSendText.mockReset();
  mockCloudSendText.mockImplementation(async () => {
    whatsappProviderCallCount++;
    return { messageId: 'wamid.test123' };
  });
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(undefined);
  mockSingleAttemptSend.mockReset();
  mockSingleAttemptSend.mockImplementation(async () => {
    whatsappProviderCallCount++;
    return { outcome: 'sent' as const, providerMessageId: 'wamid.test123', error: null };
  });
  mockRpc.mockReset();
  mockServiceFrom.mockReset();
  mockResolveByBusinessId.mockReset();
  mockResolveByBusinessId.mockResolvedValue({
    channel: { id: 'ch-1', phone_number: '+1234567890' },
    sender: { sendText: mockCloudSendText },
    cloud: { sendText: mockCloudSendText },
  });
  mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });

  // Default from() handler
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'services') {
      return buildChain({ data: { name: 'Haircut', price: 2500, duration_minutes: 30, max_capacity: 1, buffer_minutes: 0, requires_staff: false, is_class: false } });
    }
    if (table === 'businesses') {
      return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
    }
    if (table === 'bookings') {
      return buildChain({ data: { reference_code: 'REF123', date: '2027-01-15', time: '10:00', service: { name: 'Haircut' }, appointment: null } });
    }
    if (table === 'booking_confirmation_intents') {
      return buildChain({ data: null });
    }
    return buildChain({ data: null });
  });

  // Default RPC handler
  mockRpc.mockImplementation((name: string) => {
    if (name === 'book_manual_slot_atomic') {
      return { single: vi.fn().mockResolvedValue({ data: { booking_id: BOOKING_ID, reference_code: 'REF123', slot_available: true }, error: null }) };
    }
    if (name === 'claim_booking_confirmation') {
      return { data: { claimed: true, intent_id: INTENT_ID, claim_token: CLAIM_TOKEN, guest_phone: '+2348001234567', guest_email: null }, error: null };
    }
    if (name === 'mark_booking_confirmation_dispatched') {
      return { data: { dispatched: true }, error: null };
    }
    if (name === 'record_booking_confirmation_outcome') {
      return { data: { recorded: true }, error: null };
    }
    if (name === 'upsert_customer_profile') {
      return { data: null, error: null };
    }
    return { data: null, error: null };
  });
}

// ── Import route handlers (after mocks are set up) ──
import { POST as createManualPOST } from '../create-manual/route';
import { POST as confirmPOST } from '../confirm/route';

describe('#244 create-manual route — durable confirmation', () => {
  beforeEach(setupDefaultMocks);

  it('booking succeeds even when notification fails (no channel)', async () => {
    mockResolveByBusinessId.mockResolvedValueOnce(null);

    const response = await createManualPOST(makeRequest(defaultBookingBody));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.booking_id).toBe(BOOKING_ID);
    expect(data.whatsapp_sent).toBe(false);
  });

  it('booking succeeds even when claim RPC fails', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'book_manual_slot_atomic') {
        return { single: vi.fn().mockResolvedValue({ data: { booking_id: BOOKING_ID, reference_code: 'REF123', slot_available: true }, error: null }) };
      }
      if (name === 'claim_booking_confirmation') {
        return { data: null, error: new Error('RPC unavailable') };
      }
      if (name === 'upsert_customer_profile') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const response = await createManualPOST(makeRequest(defaultBookingBody));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.booking_id).toBe(BOOKING_ID);
  });

  it('makes exactly ONE provider API call when sendConfirmation=true', async () => {
    const response = await createManualPOST(makeRequest(defaultBookingBody));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(mockSingleAttemptSend).toHaveBeenCalledTimes(1);
    expect(whatsappProviderCallCount).toBe(1);
  });

  it('makes ZERO provider calls when sendConfirmation=false', async () => {
    const response = await createManualPOST(makeRequest({ ...defaultBookingBody, sendConfirmation: false }));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(mockSingleAttemptSend).not.toHaveBeenCalled();
    expect(whatsappProviderCallCount).toBe(0);
  });

  it('uses p_booking_amount: 0 for upsert_customer_profile', async () => {
    await createManualPOST(makeRequest(defaultBookingBody));

    const upsertCall = mockRpc.mock.calls.find(
      (call: unknown[]) => call[0] === 'upsert_customer_profile'
    );
    expect(upsertCall).toBeDefined();
    expect((upsertCall as any[])[1].p_booking_amount).toBe(0);
  });

  it('calls claim -> dispatch -> send -> outcome in correct order', async () => {
    const callOrder: string[] = [];
    mockRpc.mockImplementation((name: string) => {
      callOrder.push(name);
      if (name === 'book_manual_slot_atomic') {
        return { single: vi.fn().mockResolvedValue({ data: { booking_id: BOOKING_ID, reference_code: 'REF123', slot_available: true }, error: null }) };
      }
      if (name === 'claim_booking_confirmation') {
        return { data: { claimed: true, intent_id: INTENT_ID, claim_token: CLAIM_TOKEN, guest_phone: '+2348001234567', guest_email: null }, error: null };
      }
      if (name === 'mark_booking_confirmation_dispatched') {
        return { data: { dispatched: true }, error: null };
      }
      if (name === 'record_booking_confirmation_outcome') {
        return { data: { recorded: true }, error: null };
      }
      if (name === 'upsert_customer_profile') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    const response = await createManualPOST(makeRequest(defaultBookingBody));
    const data = await response.json();

    expect(data.success).toBe(true);
    expect(callOrder).toContain('book_manual_slot_atomic');
    expect(callOrder).toContain('claim_booking_confirmation');
    expect(callOrder).toContain('mark_booking_confirmation_dispatched');
    expect(callOrder).toContain('record_booking_confirmation_outcome');

    const claimIdx = callOrder.indexOf('claim_booking_confirmation');
    const dispatchIdx = callOrder.indexOf('mark_booking_confirmation_dispatched');
    const outcomeIdx = callOrder.indexOf('record_booking_confirmation_outcome');
    expect(dispatchIdx).toBeGreaterThan(claimIdx);
    expect(outcomeIdx).toBeGreaterThan(dispatchIdx);
  });

  it('records indeterminate when provider returns unknown outcome', async () => {
    mockSingleAttemptSend.mockImplementationOnce(async () => ({
      outcome: 'unknown' as const,
      providerMessageId: null,
      error: 'network timeout',
    }));

    const response = await createManualPOST(makeRequest(defaultBookingBody));
    const data = await response.json();

    expect(data.success).toBe(true); // Booking still succeeds
    expect(data.notification_outcome).toBe('indeterminate');

    const outcomeCall = mockRpc.mock.calls.find(
      (call: unknown[]) => call[0] === 'record_booking_confirmation_outcome' && (call[1] as any)?.p_outcome === 'indeterminate'
    );
    expect(outcomeCall).toBeDefined();
  });

  it('does NOT create a payment row', async () => {
    await createManualPOST(makeRequest(defaultBookingBody));

    // Check that no `from('payments').insert()` was called
    const paymentCalls = mockServiceFrom.mock.calls.filter(
      (call: unknown[]) => call[0] === 'payments'
    );
    expect(paymentCalls.length).toBe(0);
  });
});

describe('#244 confirm route — resend safety', () => {
  beforeEach(setupDefaultMocks);

  it('blocks resend when create intent is dispatched', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: { id: INTENT_ID, status: 'dispatched' } });
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.reason).toBe('create_intent_unresolved');
    expect(data.create_intent_status).toBe('dispatched');
    expect(mockSingleAttemptSend).not.toHaveBeenCalled();
  });

  it('blocks resend when create intent is indeterminate', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: { id: INTENT_ID, status: 'indeterminate' } });
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.reason).toBe('create_intent_unresolved');
    expect(mockSingleAttemptSend).not.toHaveBeenCalled();
  });

  it('blocks resend when create intent is claiming (active lease)', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: { id: INTENT_ID, status: 'claiming' } });
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.reason).toBe('create_intent_unresolved');
    expect(mockSingleAttemptSend).not.toHaveBeenCalled();
  });

  it('allows resend when create intent is sent (terminal)', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: { id: INTENT_ID, status: 'sent' } });
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      if (table === 'bookings') {
        return buildChain({ data: { reference_code: 'REF123', date: '2027-01-15', time: '10:00', service: { name: 'Haircut' }, appointment: null } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));

    // Should NOT be blocked by the resend safety gate (status 409 with create_intent_unresolved)
    const data = await response.json();
    expect(data.reason).not.toBe('create_intent_unresolved');
  });

  it('allows resend when create intent is failed (terminal)', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: { id: INTENT_ID, status: 'failed' } });
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      if (table === 'bookings') {
        return buildChain({ data: { reference_code: 'REF123', date: '2027-01-15', time: '10:00', service: { name: 'Haircut' }, appointment: null } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));

    const data = await response.json();
    expect(data.reason).not.toBe('create_intent_unresolved');
  });

  it('allows resend when no create intent exists', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'booking_confirmation_intents') {
        return buildChain({ data: null }); // No intent found
      }
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      if (table === 'bookings') {
        return buildChain({ data: { reference_code: 'REF123', date: '2027-01-15', time: '10:00', service: { name: 'Haircut' }, appointment: null } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'resend',
    }));

    const data = await response.json();
    expect(data.reason).not.toBe('create_intent_unresolved');
  });

  it('denies cross-business access', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Other Biz', country_code: 'US', owner_id: 'other-user' } });
      }
      return buildChain({ data: null });
    });

    const response = await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'create',
    }));
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain('Not authorized');
    expect(mockSingleAttemptSend).not.toHaveBeenCalled();
  });

  it('makes exactly ONE provider call for successful dispatch', async () => {
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return buildChain({ data: { id: BIZ_ID, name: 'Test Biz', country_code: 'NG', owner_id: USER_ID } });
      }
      if (table === 'bookings') {
        return buildChain({ data: { reference_code: 'REF123', date: '2027-01-15', time: '10:00', service: { name: 'Haircut' }, appointment: null } });
      }
      return buildChain({ data: null });
    });

    await confirmPOST(makeConfirmRequest({
      bookingId: BOOKING_ID,
      businessId: BIZ_ID,
      purpose: 'create',
    }));

    expect(mockSingleAttemptSend).toHaveBeenCalledTimes(1);
  });
});

describe('#244 singleAttemptWhatsAppSend — unit tests', () => {
  it('returns sent with messageId on success', async () => {
    const mod = await vi.importActual<typeof import('@/lib/channels/single-attempt-send')>('@/lib/channels/single-attempt-send');

    const mockCloud = {
      sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.abc123' }),
    } as any;

    const result = await mod.singleAttemptWhatsAppSend(mockCloud, '2348001234567', 'Hello');
    expect(result.outcome).toBe('sent');
    expect(result.providerMessageId).toBe('wamid.abc123');
    expect(result.error).toBeNull();
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('returns failed for 4xx errors', async () => {
    const mod = await vi.importActual<typeof import('@/lib/channels/single-attempt-send')>('@/lib/channels/single-attempt-send');

    const mockCloud = {
      sendText: vi.fn().mockRejectedValue(new Error('Cloud API error: 400 - invalid phone')),
    } as any;

    const result = await mod.singleAttemptWhatsAppSend(mockCloud, 'badphone', 'Hello');
    expect(result.outcome).toBe('failed');
    expect(result.providerMessageId).toBeNull();
    expect(result.error).toContain('400');
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('returns unknown for 5xx/network errors', async () => {
    const mod = await vi.importActual<typeof import('@/lib/channels/single-attempt-send')>('@/lib/channels/single-attempt-send');

    const mockCloud = {
      sendText: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    } as any;

    const result = await mod.singleAttemptWhatsAppSend(mockCloud, '2348001234567', 'Hello');
    expect(result.outcome).toBe('unknown');
    expect(result.providerMessageId).toBeNull();
    expect(result.error).toContain('ECONNRESET');
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });

  it('never retries — exactly one provider call regardless of outcome', async () => {
    const mod = await vi.importActual<typeof import('@/lib/channels/single-attempt-send')>('@/lib/channels/single-attempt-send');

    const mockCloud = {
      sendText: vi.fn().mockRejectedValue(new Error('Server error 500')),
    } as any;

    await mod.singleAttemptWhatsAppSend(mockCloud, '2348001234567', 'Hello');
    expect(mockCloud.sendText).toHaveBeenCalledTimes(1);
  });
});
