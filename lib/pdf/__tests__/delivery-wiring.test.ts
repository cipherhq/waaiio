/**
 * Real caller-level tests proving presentation fields reach generators.
 *
 * Item 5: Non-vacuous runtime assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the PDF generator to intercept calls
const mockGenerateTicketsPdf = vi.fn().mockResolvedValue(Buffer.from('%PDF-test'));
vi.mock('@/lib/pdf/ticket-generator', () => ({
  generateTicketsPdf: (...args: unknown[]) => mockGenerateTicketsPdf(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));


function ticketEmissionRpc() {
  const emissions = new Map<string, { id: string; state: string }>();
  return vi.fn(async (name: string, params: Record<string, any>) => {
    if (name === 'authorize_event_ticket_emission') {
      if (!params.p_booking_id || !['whatsapp', 'email', 'webhook'].includes(params.p_channel) ||
          !/^(document|image:.+|text:.+|ticket|ticket\.purchased|event\.sold_out)$/.test(params.p_emission_key)) {
        throw new Error('Unexpected ticket emission identity');
      }
      const key = [params.p_booking_id, params.p_channel, params.p_emission_key].join(':');
      const existing = emissions.get(key);
      if (existing) return { data: { authorized: false, state: existing.state }, error: null };
      const row = { id: 'emission-' + emissions.size, state: 'attempted' };
      emissions.set(key, row);
      return { data: { authorized: true, emission_id: row.id }, error: null };
    }
    if (name === 'finalize_event_ticket_emission') {
      const row = [...emissions.values()].find(value => value.id === params.p_emission_id);
      if (!row || row.state !== 'attempted' ||
          !['accepted', 'failed', 'ambiguous'].includes(params.p_state) ||
          (params.p_state === 'accepted' && !params.p_provider_message_id)) {
        throw new Error('Unexpected ticket emission finalization');
      }
      row.state = params.p_state;
      return { data: { finalized: true }, error: null };
    }
    throw new Error('Unexpected RPC: ' + name);
  });
}

describe('Real deliverTicketsWhatsApp wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('passes flyer/type/price/country/currency to generateTicketsPdf', async () => {
    const mockSender = {
      sendDocument: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-document' }),
      sendImage: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-image' }),
      sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-text' }),
    };
    const mockSupabase = {
      rpc: ticketEmissionRpc(),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { subscription_tier: 'free' }, error: null }),
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ error: null }),
          createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.url/test.pdf' }, error: null }),
        }),
      },
    };

    const { deliverTicketsWhatsApp } = await import('@/lib/bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: mockSupabase as any,
      sender: mockSender as any,
      businessId: 'biz-1',
      bookingId: 'book-1',
      eventId: 'evt-1',
      eventName: 'Test Event',
      eventDate: 'Jan 1 2026',
      eventTime: '7pm',
      venue: 'Test Venue',
      guestName: 'Guest',
      guestPhone: '+2348012345678',
      referenceCode: 'REF-1',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-XYZ', ticketNumber: 1, totalTickets: 1 }],
      flyerUrl: 'https://example.com/flyer.jpg',
      ticketTypeName: 'VIP',
      ticketPrice: 5000,
      countryCode: 'NG',
      currencyCode: 'NGN',
    } as any);

    expect(mockGenerateTicketsPdf).toHaveBeenCalledWith(expect.objectContaining({
      flyerUrl: 'https://example.com/flyer.jpg',
      ticketType: 'VIP',
      price: 5000,
      countryCode: 'NG',
      currencyCode: 'NGN',
    }));

    // QR verification URL authority unchanged
    expect(mockGenerateTicketsPdf).toHaveBeenCalledWith(expect.objectContaining({
      verifyBaseUrl: expect.stringContaining('/tickets'),
    }));
  });

  it('omitted presentation fields pass through as undefined', async () => {
    const mockSender = {
      sendDocument: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-document' }),
      sendImage: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-image' }),
      sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.fixture-text' }),
    };
    const mockSupabase = {
      rpc: ticketEmissionRpc(),
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { subscription_tier: 'free' }, error: null }),
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ error: null }),
          createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.url/test.pdf' }, error: null }),
        }),
      },
    };

    const { deliverTicketsWhatsApp } = await import('@/lib/bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: mockSupabase as any,
      sender: mockSender as any,
      businessId: 'biz-1',
      bookingId: 'book-1',
      eventId: 'evt-1',
      eventName: 'Free Event',
      eventDate: 'Jan 1',
      venue: 'V',
      guestName: 'G',
      guestPhone: '+234',
      referenceCode: 'R-1',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-FREE', ticketNumber: 1, totalTickets: 1 }],
      // NO presentation fields — should not fabricate anything
    } as any);

    const callArgs = mockGenerateTicketsPdf.mock.calls[0][0];
    expect(callArgs.flyerUrl).toBeUndefined();
    expect(callArgs.ticketType).toBeUndefined();
    expect(callArgs.price).toBeUndefined();
    expect(callArgs.currencyCode).toBeUndefined();
  });
});
