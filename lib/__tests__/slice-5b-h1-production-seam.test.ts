/**
 * Slice 5B H1-H3 — Production-seam executable tests (#524)
 *
 * H1: resolvePdfLabels (production helper used by all 3 callers) resolves
 *     language → deterministic bundle / English fallback
 * H2: Authoritative values (refs, names, amounts) survive exactly through the
 *     production ticket caller to the generator
 * H3: Localization failure does not suppress delivery or introduce extra mutation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock proactive localization resolver ──
const mockResolveProactive = vi.fn();
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: (...a: unknown[]) => mockResolveProactive(...a),
}));

// ── Mock email localization resolver (preserving other exports) ──
const mockResolveEmail = vi.fn();
vi.mock('@/lib/email/localize-email', async () => {
  const actual = await vi.importActual('@/lib/email/localize-email');
  return { ...actual as object, resolveEmailLocalization: (...a: unknown[]) => mockResolveEmail(...a) };
});

// ── Mock ticket PDF generator (H2/H3 arg capture) ──
const mockGenerateTicketsPdf = vi.fn();
vi.mock('@/lib/pdf/ticket-generator', () => ({
  generateTicketsPdf: (...a: unknown[]) => mockGenerateTicketsPdf(...a),
}));

// ── Mock logger (suppress output) ──
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function createMockSupabase() {
  const singleMock = vi.fn().mockResolvedValue({ data: { subscription_tier: 'growth' }, error: null });
  const eqMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
  const fromMock = vi.fn().mockReturnValue({ select: selectMock });

  const uploadMock = vi.fn().mockResolvedValue({ error: null });
  const createSignedUrlMock = vi.fn().mockResolvedValue({
    data: { signedUrl: 'https://mock.storage/doc.pdf' }, error: null,
  });
  const storageFromMock = vi.fn().mockReturnValue({
    upload: uploadMock,
    createSignedUrl: createSignedUrlMock,
  });

  return { from: fromMock, storage: { from: storageFromMock } } as any;
}

function createMockSender() {
  return {
    sendDocument: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-doc' }),
    sendImage: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-img' }),
    sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'msg-txt' }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProactive.mockResolvedValue({
    language: 'en', translationContext: {} as any, translate: async (t: string) => t,
  });
  mockResolveEmail.mockResolvedValue({
    language: 'en', translationContext: {} as any, translate: async (t: string) => t,
  });
  mockGenerateTicketsPdf.mockResolvedValue(Buffer.from('%PDF-1.4 mock'));
});

// ═══════════════════════════════════════════════════════════════
// H1 — resolvePdfLabels production seam
// ═══════════════════════════════════════════════════════════════

describe('H1 — resolvePdfLabels production seam', () => {
  it('invoice: French → bundle.invoice via email resolver', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    mockResolveEmail.mockResolvedValueOnce({
      language: 'fr', translationContext: {} as any, translate: async (t: string) => t,
    });

    const labels = await resolvePdfLabels({} as any, '+2341234567890', 'biz-1', 'invoice', 'email');

    expect(labels).toBeDefined();
    expect(labels!.title).toBe('FACTURE');
    expect(labels!.lblBillTo).toBe('FACTURER À');
    expect(labels!.lblPaid).toBe('PAYÉ');
    expect(mockResolveEmail).toHaveBeenCalledWith({}, '+2341234567890', 'biz-1');
    expect(mockResolveProactive).not.toHaveBeenCalled();
  });

  it('ticket: Pidgin → bundle.ticket via proactive resolver', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    mockResolveProactive.mockResolvedValueOnce({
      language: 'pcm', translationContext: {} as any, translate: async (t: string) => t,
    });

    const labels = await resolvePdfLabels({} as any, '+2341234567890', 'biz-1', 'ticket', 'proactive');

    expect(labels).toBeDefined();
    expect(labels!.lblAttendee).toBe('PERSON');
    expect(labels!.lblDate).toBe('DATE');
    expect(labels!.footer).toBe('Waaiio power am');
    expect(mockResolveProactive).toHaveBeenCalledWith({}, '+2341234567890', 'biz-1');
  });

  it('receipt: French → bundle.receipt via proactive resolver', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    mockResolveProactive.mockResolvedValueOnce({
      language: 'fr', translationContext: {} as any, translate: async (t: string) => t,
    });

    const labels = await resolvePdfLabels({} as any, '+2341234567890', 'biz-1', 'receipt', 'proactive');

    expect(labels).toBeDefined();
    expect(labels!.title).toBe('REÇU');
    expect(labels!.lblTotal).toBe('Total');
    expect(labels!.statusLabels.paid).toBe('Payé');
  });

  it('English → undefined (generator uses built-in defaults)', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    // Default mock already returns 'en'
    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'receipt', 'proactive');
    expect(labels).toBeUndefined();
  });

  it('resolver failure → undefined (fail-closed English)', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    mockResolveProactive.mockRejectedValueOnce(new Error('DB unavailable'));

    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'ticket', 'proactive');
    expect(labels).toBeUndefined();
  });

  it('unknown language → English bundle labels returned', async () => {
    const { resolvePdfLabels, DEFAULT_RECEIPT_LABELS } = await import('../pdf/localize-pdf');
    mockResolveProactive.mockResolvedValueOnce({
      language: 'xx', translationContext: {} as any, translate: async (t: string) => t,
    });

    // 'xx' !== 'en' so the helper enters the bundle path;
    // getPdfLocalizationBundle('xx') returns the English bundle
    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'receipt', 'proactive');
    expect(labels).toBeDefined();
    expect(labels!.title).toBe(DEFAULT_RECEIPT_LABELS.title);
  });

  it('free/non-entitled → English (undefined) + zero translate calls', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    const mockTranslate = vi.fn();
    mockResolveProactive.mockResolvedValueOnce({
      language: 'en',
      translationContext: { entitlement: { allowedLanguages: ['en'], llmAllowed: false } } as any,
      translate: mockTranslate,
    });

    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'receipt', 'proactive');

    expect(labels).toBeUndefined();
    // PDF bundles are static — translate() is never called
    expect(mockTranslate).not.toHaveBeenCalled();
  });

  it('labels contain only Waaiio chrome, not authoritative data', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    mockResolveProactive.mockResolvedValueOnce({
      language: 'fr', translationContext: {} as any, translate: async (t: string) => t,
    });

    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'receipt', 'proactive');
    const labelsStr = JSON.stringify(labels);
    expect(labelsStr).not.toContain('WA-BK');
    expect(labelsStr).not.toContain('₦');
    expect(labelsStr).not.toContain('5000');
  });
});

// ═══════════════════════════════════════════════════════════════
// H2 — Authoritative values through production ticket caller
// ═══════════════════════════════════════════════════════════════

describe('H2 — authoritative values through production ticket caller', () => {
  it('non-English: authoritative refs/names/venues pass exactly to generator with French labels', async () => {
    mockResolveProactive.mockResolvedValue({
      language: 'fr', translationContext: {} as any, translate: async (t: string) => t,
    });

    const { deliverTicketsWhatsApp } = await import('../bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: createMockSupabase(),
      sender: createMockSender(),
      businessId: 'biz-H2',
      bookingId: 'book-H2',
      eventId: 'evt-H2',
      eventName: 'Afrobeats Festival 2026',
      eventDate: 'Dec 1, 2026',
      venue: 'Eko Convention Centre',
      guestName: 'Ade Johnson',
      guestPhone: '+2341234567890',
      referenceCode: 'WA-TK-EXACT-5678',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-EXACT-ABC', ticketNumber: 1, totalTickets: 1 }],
      translate: async (t: string) => t,
    });

    expect(mockGenerateTicketsPdf).toHaveBeenCalledOnce();
    const args = mockGenerateTicketsPdf.mock.calls[0][0];
    // Authoritative values survive exactly
    expect(args.eventName).toBe('Afrobeats Festival 2026');
    expect(args.referenceCode).toBe('WA-TK-EXACT-5678');
    expect(args.guestName).toBe('Ade Johnson');
    expect(args.venue).toBe('Eko Convention Centre');
    expect(args.eventDate).toBe('Dec 1, 2026');
    expect(args.tickets[0].ticketCode).toBe('TK-EXACT-ABC');
    // French labels passed alongside authoritative values
    expect(args.labels).toBeDefined();
    expect(args.labels.lblAttendee).toBe('PARTICIPANT');
    expect(args.labels.footer).toBe('Propulsé par Waaiio');
  });

  it('English: authoritative values pass exactly + labels undefined', async () => {
    // Default mock returns 'en'
    const { deliverTicketsWhatsApp } = await import('../bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: createMockSupabase(),
      sender: createMockSender(),
      businessId: 'biz-H2-en',
      bookingId: 'book-H2-en',
      eventId: 'evt-H2-en',
      eventName: 'Concert Night',
      eventDate: 'Jan 15, 2027',
      venue: 'Main Hall',
      guestName: 'John Doe',
      guestPhone: '+2341234567890',
      referenceCode: 'WA-TK-EN-1234',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-EN-XYZ', ticketNumber: 1, totalTickets: 1 }],
      translate: async (t: string) => t,
    });

    expect(mockGenerateTicketsPdf).toHaveBeenCalledOnce();
    const args = mockGenerateTicketsPdf.mock.calls[0][0];
    expect(args.eventName).toBe('Concert Night');
    expect(args.referenceCode).toBe('WA-TK-EN-1234');
    expect(args.guestName).toBe('John Doe');
    expect(args.venue).toBe('Main Hall');
    expect(args.tickets[0].ticketCode).toBe('TK-EN-XYZ');
    // English → labels undefined (generator uses built-in defaults)
    expect(args.labels).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// H3 — Localization failure does not suppress send
// ═══════════════════════════════════════════════════════════════

describe('H3 — localization failure does not suppress send or mutate state', () => {
  it('resolver failure → generator still called with English + sender still delivers', async () => {
    mockResolveProactive.mockRejectedValue(new Error('DB unavailable'));

    const sender = createMockSender();
    const { deliverTicketsWhatsApp } = await import('../bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: createMockSupabase(),
      sender,
      businessId: 'biz-H3',
      bookingId: 'book-H3',
      eventId: 'evt-H3',
      eventName: 'Afrobeats Festival 2026',
      eventDate: 'Dec 1, 2026',
      venue: 'Eko Convention Centre',
      guestName: 'Ade Johnson',
      guestPhone: '+2341234567890',
      referenceCode: 'WA-TK-FAIL-9999',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-FAIL-ABC', ticketNumber: 1, totalTickets: 1 }],
      translate: async (t: string) => t,
    });

    // Generator was still called — delivery not suppressed
    expect(mockGenerateTicketsPdf).toHaveBeenCalledOnce();
    const args = mockGenerateTicketsPdf.mock.calls[0][0];
    // Labels undefined → generator uses English defaults
    expect(args.labels).toBeUndefined();
    // Authoritative values survive despite failure
    expect(args.referenceCode).toBe('WA-TK-FAIL-9999');
    expect(args.guestName).toBe('Ade Johnson');
    expect(args.eventName).toBe('Afrobeats Festival 2026');

    // Sender called — PDF document + QR images delivered
    expect(sender.sendDocument).toHaveBeenCalled();
    expect(sender.sendImage).toHaveBeenCalled();
  });

  it('resolver failure does not introduce extra provider/financial mutation', async () => {
    mockResolveProactive.mockRejectedValue(new Error('DB error'));

    const supabase = createMockSupabase();
    const { deliverTicketsWhatsApp } = await import('../bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase,
      sender: createMockSender(),
      businessId: 'biz-H3-mut',
      bookingId: 'book-H3-mut',
      eventId: 'evt-H3-mut',
      eventName: 'Test Event',
      eventDate: 'Dec 1, 2026',
      venue: 'Test Venue',
      guestName: 'Test Guest',
      guestPhone: '+2341234567890',
      referenceCode: 'WA-TK-MUT-0001',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-MUT-AAA', ticketNumber: 1, totalTickets: 1 }],
      translate: async (t: string) => t,
    });

    // Only standard operations: subscription tier lookup (supabase.from)
    // No payment, invoice, or financial table mutations
    const tableNames = supabase.from.mock.calls.map((c: any[]) => c[0]);
    expect(tableNames).toContain('businesses');
    expect(tableNames).not.toContain('payments');
    expect(tableNames).not.toContain('platform_fees');
    expect(tableNames).not.toContain('invoices');

    // Generator was called (not suppressed)
    expect(mockGenerateTicketsPdf).toHaveBeenCalledOnce();
  });

  it('no-translate path → zero resolver calls + generator uses English', async () => {
    const { deliverTicketsWhatsApp } = await import('../bot/flows/shared/send-tickets');
    await deliverTicketsWhatsApp({
      supabase: createMockSupabase(),
      sender: createMockSender(),
      businessId: 'biz-H3-notrans',
      bookingId: 'book-H3-notrans',
      eventId: 'evt-H3-notrans',
      eventName: 'Free Event',
      eventDate: 'Dec 1, 2026',
      venue: 'Free Venue',
      guestName: 'Free Guest',
      guestPhone: '+2341234567890',
      referenceCode: 'WA-TK-FREE-0001',
      quantity: 1,
      tickets: [{ ticketCode: 'TK-FREE-BBB', ticketNumber: 1, totalTickets: 1 }],
      // No translate function → free/non-entitled path
    });

    // Resolver never called (no translate → no localization attempt)
    expect(mockResolveProactive).not.toHaveBeenCalled();
    // Generator still called with English defaults
    expect(mockGenerateTicketsPdf).toHaveBeenCalledOnce();
    expect(mockGenerateTicketsPdf.mock.calls[0][0].labels).toBeUndefined();
    expect(mockGenerateTicketsPdf.mock.calls[0][0].referenceCode).toBe('WA-TK-FREE-0001');
  });
});
