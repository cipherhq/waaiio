/**
 * Ticket check-in race-loss error handling — handler-level tests.
 *
 * Proves that:
 * - DB errors during the conditional UPDATE are NOT reported as duplicates (Finding 1).
 * - A cancellation race (status='cancelled' on re-read) is NOT reported as a duplicate (Finding 2).
 * - A genuine duplicate (status='used' on re-read) still returns the correct duplicate response.
 *
 * Uses mocked Supabase client — the real-PG concurrency test in
 * checkin-race-condition-db.test.ts proves the SQL atomicity separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state for verify route tests (vi.mock is hoisted before imports)
// ---------------------------------------------------------------------------
const { mockState } = vi.hoisted(() => ({
  mockState: {
    supabase: null as any,
  },
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => mockState.supabase,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));

// ---------------------------------------------------------------------------
// Supabase mock builder
// ---------------------------------------------------------------------------

function buildMockSupabase(opts: {
  initialTicket: any;
  updateResult: { data: any; error: any };
  reReadResult?: { data: any; error: any };
}) {
  let singleCallCount = 0;

  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockImplementation(() => {
        const chain: any = {
          eq: vi.fn().mockImplementation(() => chain),
          single: vi.fn().mockImplementation(() => {
            singleCallCount++;
            if (singleCallCount === 1) {
              return Promise.resolve({ data: opts.initialTicket, error: null });
            }
            return Promise.resolve(opts.reReadResult ?? { data: null, error: null });
          }),
          maybeSingle: vi.fn(),
        };
        return chain;
      }),
      update: vi.fn().mockImplementation(() => {
        const updateChain: any = {
          eq: vi.fn().mockImplementation(() => updateChain),
          select: vi.fn().mockImplementation(() => updateChain),
          maybeSingle: vi.fn().mockResolvedValue(opts.updateResult),
        };
        return updateChain;
      }),
    }),
  };
}

/** Build a mock that dispatches to different table handlers (for partner route). */
function buildTableAwareMock(opts: {
  eventData: any;
  ticketData: any;
  updateResult: { data: any; error: any };
  reReadResult: { data: any; error: any };
}) {
  let ticketSingleCount = 0;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'events') {
        const evtChain: any = {};
        evtChain.select = vi.fn().mockReturnValue(evtChain);
        evtChain.eq = vi.fn().mockReturnValue(evtChain);
        evtChain.single = vi.fn().mockResolvedValue({ data: opts.eventData, error: null });
        return evtChain;
      }
      // event_tickets
      return {
        select: vi.fn().mockImplementation(() => {
          const chain: any = {
            eq: vi.fn().mockImplementation(() => chain),
            single: vi.fn().mockImplementation(() => {
              ticketSingleCount++;
              if (ticketSingleCount === 1) {
                return Promise.resolve({ data: opts.ticketData, error: null });
              }
              return Promise.resolve(opts.reReadResult);
            }),
            maybeSingle: vi.fn(),
          };
          return chain;
        }),
        update: vi.fn().mockImplementation(() => {
          const updateChain: any = {
            eq: vi.fn().mockImplementation(() => updateChain),
            select: vi.fn().mockImplementation(() => updateChain),
            maybeSingle: vi.fn().mockResolvedValue(opts.updateResult),
          };
          return updateChain;
        }),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. Bot handler tests
// ---------------------------------------------------------------------------

describe('Bot ticket-checkin: race-loss error handling', () => {
  let handleTicketCheckin: typeof import('@/lib/bot/handlers/ticket-checkin').handleTicketCheckin;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@/lib/bot/handlers/ticket-checkin');
    handleTicketCheckin = mod.handleTicketCheckin;
  });

  const validTicket = {
    id: '00000000-0000-0000-0000-000000000001',
    status: 'valid',
    scanned_at: null,
    scanned_by: null,
    guest_name: 'Alice',
    guest_phone: '+2341234567890',
    event: { name: 'Concert', date: null, time: null, self_checkin_enabled: true, business_id: 'biz-1' },
  };

  it('Finding 1: DB error on UPDATE → retryable failure, NOT a duplicate message', async () => {
    const sent: string[] = [];
    const sendText = vi.fn(async (_to: string, text: string) => { sent.push(text); });
    const supabase = buildMockSupabase({
      initialTicket: validTicket,
      updateResult: { data: null, error: { message: 'connection reset', code: 'PGRST301' } },
    });

    await handleTicketCheckin(supabase as any, sendText, '+2341234567890', 'TK-ABC123');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain('Something went wrong');
    expect(sent[0]).toContain('TK-ABC123');
    expect(sent[0]).toContain('try again');
    expect(sent[0]).not.toContain('already checked in');
  });

  it('Finding 2: race-loss re-read returns cancelled → cancelled message, NOT a duplicate', async () => {
    const sent: string[] = [];
    const sendText = vi.fn(async (_to: string, text: string) => { sent.push(text); });
    const supabase = buildMockSupabase({
      initialTicket: validTicket,
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'cancelled', scanned_at: null, scanned_by: null }, error: null },
    });

    await handleTicketCheckin(supabase as any, sendText, '+2341234567890', 'TK-ABC123');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain('cancelled');
    expect(sent[0]).toContain('❌');
    expect(sent[0]).not.toContain('already checked in');
  });

  it('race-loss re-read returns used → duplicate message (regression guard)', async () => {
    const sent: string[] = [];
    const sendText = vi.fn(async (_to: string, text: string) => { sent.push(text); });
    const supabase = buildMockSupabase({
      initialTicket: validTicket,
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'used', scanned_at: '2027-01-01T18:00:00Z', scanned_by: 'door_staff' }, error: null },
    });

    await handleTicketCheckin(supabase as any, sendText, '+2341234567890', 'TK-ABC123');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain('already checked in');
    expect(sent[0]).toContain('⚠️');
    expect(sent[0]).toContain('door_staff');
  });

  it('race-loss re-read fails → retryable failure, NOT a duplicate', async () => {
    const sent: string[] = [];
    const sendText = vi.fn(async (_to: string, text: string) => { sent.push(text); });
    const supabase = buildMockSupabase({
      initialTicket: validTicket,
      updateResult: { data: null, error: null },
      reReadResult: { data: null, error: { message: 'timeout' } },
    });

    await handleTicketCheckin(supabase as any, sendText, '+2341234567890', 'TK-ABC123');

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sent[0]).toContain('Something went wrong');
    expect(sent[0]).toContain('try again');
    expect(sent[0]).not.toContain('already checked in');
  });
});

// ---------------------------------------------------------------------------
// 2. Verify route tests (uses hoisted vi.mock for createServiceClient)
// ---------------------------------------------------------------------------

describe('Verify route: race-loss status handling', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const baseTicket = {
    id: 'tk-1', status: 'valid', scanned_at: null, scanned_by: null,
    guest_name: 'Alice', guest_phone: '+234', ticket_code: 'TK-TEST',
    ticket_number: 1, booking_id: 'bk-1', created_at: '2027-01-01',
    event: { id: 'e1', name: 'Evt', date: null, time: null, venue: 'V', image_url: null, self_checkin_enabled: true, business_id: 'b1', businesses: { subscription_tier: 'free' } },
    booking: { quantity: 1, reference_code: 'REF' },
  };

  it('Finding 2: re-read returns cancelled → 410 cancelled, NOT 409 duplicate', async () => {
    mockState.supabase = buildMockSupabase({
      initialTicket: baseTicket,
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'cancelled', scanned_at: null, scanned_by: null }, error: null },
    });

    const { POST } = await import('@/app/api/tickets/verify/[code]/route');
    const req = new Request('http://localhost/api/tickets/verify/TK-TEST', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: 'b1' }),
    });
    // @ts-expect-error - simplified NextRequest for test
    const res = await POST(req, { params: Promise.resolve({ code: 'TK-TEST' }) });
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toContain('cancelled');
    expect(body.error).not.toContain('already checked in');
  });

  it('re-read returns used → 409 duplicate (regression guard)', async () => {
    mockState.supabase = buildMockSupabase({
      initialTicket: baseTicket,
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'used', scanned_at: '2027-01-01T18:00:00Z', scanned_by: 'door_staff' }, error: null },
    });

    const { POST } = await import('@/app/api/tickets/verify/[code]/route');
    const req = new Request('http://localhost/api/tickets/verify/TK-TEST', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: 'b1' }),
    });
    // @ts-expect-error - simplified NextRequest for test
    const res = await POST(req, { params: Promise.resolve({ code: 'TK-TEST' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.scanned_at).toBe('2027-01-01T18:00:00Z');
    expect(body.scanned_by).toBe('door_staff');
  });
});

// ---------------------------------------------------------------------------
// 3. Partner route tests (uses vi.doMock for authenticatePartner)
// ---------------------------------------------------------------------------

describe('Partner checkin route: race-loss status handling', () => {
  it('Finding 2: re-read returns cancelled → 400 cancelled, NOT 409 duplicate', async () => {
    vi.resetModules();
    const mock = buildTableAwareMock({
      eventData: { id: 'e1', name: 'Evt' },
      ticketData: { id: 'tk-1', ticket_code: 'TK-TEST', guest_name: 'Alice', guest_phone: '+234', ticket_type_name: 'GA', status: 'valid', scanned_at: null },
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'cancelled', scanned_at: null }, error: null },
    });

    vi.doMock('@/lib/partner/auth', () => ({
      authenticatePartner: vi.fn().mockResolvedValue({ business: { id: 'b1' }, keyId: 'key-1', supabase: mock }),
    }));
    vi.doMock('@/lib/webhooks/dispatcher', () => ({
      dispatchWebhook: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST } = await import('@/app/api/partner/events/[eventId]/checkin/route');
    const req = new Request('http://localhost/api/partner/events/e1/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_code: 'TK-TEST' }),
    });
    // @ts-expect-error - simplified NextRequest for test
    const res = await POST(req, { params: Promise.resolve({ eventId: 'e1' }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain('cancelled');
    expect(body.error).not.toContain('already checked in');
  });

  it('re-read returns used → 409 duplicate (regression guard)', async () => {
    vi.resetModules();
    const mock = buildTableAwareMock({
      eventData: { id: 'e1', name: 'Evt' },
      ticketData: { id: 'tk-1', ticket_code: 'TK-TEST', guest_name: 'Alice', guest_phone: '+234', ticket_type_name: 'GA', status: 'valid', scanned_at: null },
      updateResult: { data: null, error: null },
      reReadResult: { data: { status: 'used', scanned_at: '2027-01-01T18:00:00Z' }, error: null },
    });

    vi.doMock('@/lib/partner/auth', () => ({
      authenticatePartner: vi.fn().mockResolvedValue({ business: { id: 'b1' }, keyId: 'key-1', supabase: mock }),
    }));
    vi.doMock('@/lib/webhooks/dispatcher', () => ({
      dispatchWebhook: vi.fn().mockResolvedValue(undefined),
    }));

    const { POST } = await import('@/app/api/partner/events/[eventId]/checkin/route');
    const req = new Request('http://localhost/api/partner/events/e1/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_code: 'TK-TEST' }),
    });
    // @ts-expect-error - simplified NextRequest for test
    const res = await POST(req, { params: Promise.resolve({ eventId: 'e1' }) });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.checked_in_at).toBe('2027-01-01T18:00:00Z');
  });
});
