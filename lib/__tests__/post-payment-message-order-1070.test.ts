/**
 * #1070 (Owner decision 2026-11-16, option A): after a paid ticket purchase the
 * customer receives, in order: confirmation text → ticket image → ticket PDF →
 * receipt PDF → later messages (loyalty text, follow-up: card step/opt-in/menu),
 * with a bounded WhatsApp delivery wait after each media group. The order is the
 * same for every gateway because every gateway webhook reaches the shared
 * sendProactiveConfirmation.
 *
 * Real modules: send-confirmation, post-completion, send-tickets, terminal-effects
 * (effect manifest drivers) and delivery-wait. Faked: the database (tables, RPCs,
 * storage), the WhatsApp sender, PDF rendering, and modules that only notify the
 * owner / start the follow-up (recorded as events).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { events, effects, rpcNames } = vi.hoisted(() => ({
  events: [] as string[],
  effects: [] as string[],
  rpcNames: [] as string[],
}));

const dbg = (...a: unknown[]) => { if (process.env.DEBUG_1070) console.log(...a); };
const quiet = { info: vi.fn(), warn: vi.fn(dbg), error: vi.fn(dbg), debug: vi.fn() };
vi.mock('@/lib/logger', () => ({ logger: { ...quiet, withContext: () => quiet } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn((e: unknown) => dbg('SENTRY', e)), captureMessage: vi.fn() }));
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: vi.fn(async () => ({ language: 'en', translate: async (t: string) => t })),
}));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn(async () => ['loyalty']) }));
vi.mock('@/lib/pdf/ticket-generator', () => ({ generateTicketsPdf: vi.fn(async () => Buffer.from('%PDF-ticket')) }));
vi.mock('@/lib/pdf/receipt-generator', () => ({ generateReceiptPdf: vi.fn(async () => Buffer.from('%PDF-receipt')) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewPayment: vi.fn(async () => { events.push('owner:notified'); }),
  notifyOwnerNewBooking: vi.fn(async () => { events.push('owner:notified'); }),
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/merchant-notifications/compatibility', () => ({ hasMerchantNotificationIntent: vi.fn(async () => false) }));
vi.mock('@/lib/bot/automation/sequence-service', () => ({ triggerSequences: vi.fn(async () => undefined) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn(async () => undefined) }));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ runSealedRuleActions: vi.fn(async () => undefined) }));
vi.mock('@/lib/intake/send', () => ({ deliverAfterBookingIntake: vi.fn(async () => undefined) }));
vi.mock('@/lib/bot/transaction-followups', () => ({
  startTransactionFollowup: vi.fn(async () => { events.push('followup:start'); }),
}));
vi.mock('@/lib/payments/transaction-followup', () => ({
  resumePaidTransactionFollowup: vi.fn(async () => { events.push('followup:resume (card step, opt-in, menu)'); }),
}));

/** Customer WhatsApp sender: records each send and returns a Meta-style WAMID. */
let wamidSeq = 0;
const customerSender = {
  sendText: vi.fn(async (m: { text: string }) => {
    events.push(`text:${m.text.split('\n')[0]}`);
    return { success: true, messageId: `wamid.text${++wamidSeq}` };
  }),
  sendDocument: vi.fn(async (m: { filename: string }) => {
    events.push(`document:${m.filename}`);
    return { success: true, messageId: `wamid.doc${++wamidSeq}` };
  }),
  sendImage: vi.fn(async (m: { caption?: string }) => {
    events.push(`image:${/TK-\w+/.exec(m.caption || '')?.[0]}`);
    return { success: true, messageId: `wamid.img${++wamidSeq}` };
  }),
  sendButtons: vi.fn(async () => ({ success: true, messageId: `wamid.btn${++wamidSeq}` })),
  sendList: vi.fn(async () => ({ success: true, messageId: `wamid.list${++wamidSeq}` })),
};
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByChannelIdForBusiness() { return { channel: { id: 'ch-1' }, channelId: 'ch-1', sender: customerSender }; }
    async resolveByBusinessId() { return { channel: { id: 'ch-1' }, channelId: 'ch-1', sender: customerSender }; }
  },
}));

const BUSINESS_ID = 'biz-1070';
const BOOKING = {
  guest_phone: '+2348000001070', guest_email: null, guest_name: 'Ada', quantity: 1, party_size: 1,
  event_id: 'ev-1', reference_code: 'WA-TK-9318', business_id: BUSINESS_ID, date: '2026-12-01', time: '18:00',
  flow_type: 'ticketing', total_amount: 5000, deposit_amount: null, bot_session_id: null, notes: null,
  businesses: { name: 'BalaShop', country_code: 'NG', address: 'Lagos', payment_gateway: 'paystack' },
  services: null,
};

/** In-memory database. Statuses of awaited WAMIDs are delivered by the time they are read. */
function fakeDb(gateway: string, origin: string, amount = 5000) {
  const waits = new Map<string, string>();
  const tableData = (table: string, op: string, sel: string): unknown => {
    switch (table) {
      case 'payments':
        if (sel.includes('currency')) return { currency: 'NGN', campaign_id: null };
        if (sel.includes('refund_amount')) return [{ amount: 5000, refund_amount: 0 }]; // fully paid
        return { gateway, metadata: { _inbound_channel_id: 'ch-1', _confirmation_origin: 'whatsapp', payment_origin: origin } };
      case 'bookings': return BOOKING;
      case 'businesses': return {
        name: 'BalaShop', subscription_tier: 'free', is_whitelabel: false, country_code: 'NG', logo_url: null, owner_id: null,
        metadata: { loyalty_earning_enabled: true, loyalty_reward_threshold: 100 },
      };
      case 'event_ticket_types': return [];
      case 'events': return { id: 'ev-1', name: 'AfroFest', date: '2026-12-01', time: '18:00', venue: 'Lagos', image_url: null, price: 5000 };
      case 'payment_receipt_applications':
        return op === 'select' ? { file_path: `receipts/${BUSINESS_ID}/pay-1070.pdf`, generation_state: 'completed' } : null;
      case 'payment_loyalty_applications': return { points_awarded: 10 };
      case 'loyalty_points': return { points_balance: 10 };
      case 'payment_confirmation_deliveries': return [{ delivery_status: 'accepted' }];
      default: return null;
    }
  };

  function from(table: string) {
    let op = 'select';
    let sel = '';
    let ids: string[] = [];
    let payload: Record<string, unknown> | undefined;
    const b: Record<string, unknown> = {};
    for (const m of ['eq', 'neq', 'is', 'not', 'or', 'order', 'limit', 'like', 'gte', 'lte', 'gt', 'lt', 'filter', 'match', 'range', 'contains']) {
      b[m] = () => b;
    }
    b.in = (_c: string, v: string[]) => { ids = v; return b; };
    b.select = (s = '') => { if (op === 'select') sel = s; return b; };
    b.insert = (p: Record<string, unknown>) => { op = 'insert'; payload = p; return b; };
    b.update = (p: Record<string, unknown>) => { op = 'update'; payload = p; return b; };
    b.upsert = (p: Record<string, unknown>) => { op = 'upsert'; payload = p; return b; };
    b.delete = () => { op = 'delete'; return b; };
    const resolve = () => {
      if (table === 'whatsapp_delivery_waits') {
        if (op === 'upsert') { const w = String(payload!.wamid); if (!waits.has(w)) waits.set(w, 'sent'); }
        if (op === 'select') {
          // The Meta status webhook has delivered them by the time we read.
          return { data: ids.filter(id => waits.has(id)).map(id => ({ wamid: id, status: 'delivered' })), error: null };
        }
        if (op === 'delete') { events.push(`delivered:${ids.join(',')}`); ids.forEach(id => waits.delete(id)); }
        return { data: null, error: null };
      }
      return { data: tableData(table, op, sel), error: null };
    };
    b.single = () => Promise.resolve(resolve());
    b.maybeSingle = () => Promise.resolve(resolve());
    b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, ko);
    return b;
  }

  const rpcData: Record<string, unknown> = {
    claim_payment_confirmation: { claimed: true, claim_token: 'tok-1070', payment_id: 'pay-1070', amount, booking_id: 'bk-1070', payment_authority_version: 1 },
    renew_payment_confirmation_claim: { renewed: true },
    terminate_cancelled_event_confirmation: { terminated: false, reason: 'not_cancelled' },
    initialize_terminal_effects: { initialized: true },
    reserve_terminal_effect: { reserved: true, effect_token: 'eff-tok' },
    begin_terminal_external_emission: { authorized: true },
    complete_internal_effect: { completed: true },
    complete_external_effect: { completed: true },
    skip_optional_effect: { skipped: true },
    claim_confirmation_delivery: { claimed: true, attempt_id: 'att-1', claim_token: 'del-tok' },
    begin_confirmation_send: { authorized: true },
    complete_confirmation_send: { completed: true },
    finalize_free_ticket_booking: { success: true },
    converge_event_ticket_booking: { success: true, outcome: 'issued', tickets: [{ ticketCode: 'TK-1', ticketNumber: 1, totalTickets: 1 }] },
    authorize_event_ticket_emission: { authorized: true, emission_id: 'em-1' },
    finalize_event_ticket_emission: { finalized: true },
    apply_payment_customer_visit_once: { applied: false },
    apply_payment_loyalty_once: { applied: true, points_awarded: 10 },
    finalize_payment_confirmation: { finalized: true },
  };

  return {
    from,
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      if (name === 'reserve_terminal_effect') effects.push(String(args.p_effect_key));
      return { data: rpcData[name] ?? null, error: null };
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.invalid/${bucket}/${path}` }, error: null }),
      }),
    },
  };
}

beforeEach(() => {
  events.length = 0;
  effects.length = 0;
  rpcNames.length = 0;
  wamidSeq = 0;
  vi.clearAllMocks();
});

const EXPECTED_ORDER = [
  'text:✅ *Ticket Confirmed!*',
  'image:TK-1',
  'document:AfroFest - Tickets.pdf',
  'delivered:wamid.img2,wamid.doc3',
  'document:receipt-WA-TK-9318.pdf',
  'delivered:wamid.doc4',
];

describe('#1070 post-payment message order — shared sendProactiveConfirmation', () => {
  for (const [gateway, origin] of [
    ['paystack', 'platform'], // Waaiio-owned Paystack
    ['paystack', 'byo'], // merchant's own Paystack
    ['paystack', 'connect'], // merchant-connected Paystack subaccount
    ['stripe', 'platform'],
    ['stripe', 'connect'],
    ['flutterwave', 'platform'],
    ['square', 'platform'],
  ] as const) {
    it(`${gateway}/${origin}: confirmation → ticket image → ticket PDF → receipt → later messages → follow-up`, async () => {
      const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
      const result = await sendProactiveConfirmation(fakeDb(gateway, origin) as never, { id: 'pay-1070', amount: 5000, booking_id: 'bk-1070' } as never);

      expect(result).toEqual({ status: 'completed' });
      const customerEvents = events.filter(e => e !== 'owner:notified');
      expect(customerEvents.slice(0, EXPECTED_ORDER.length)).toEqual(EXPECTED_ORDER);
      // Later customer messages (here the loyalty text) wait for the receipt; the follow-up comes last.
      expect(customerEvents.slice(EXPECTED_ORDER.length)).toEqual([
        expect.stringMatching(/^text:/),
        'followup:start',
        'followup:resume (card step, opt-in, menu)',
      ]);

      // Effect manifest: same effects, each reserved once; ticket delivery now precedes the receipt.
      expect(new Set(effects).size).toBe(effects.length);
      expect(effects.indexOf('ticket_delivery_whatsapp')).toBeGreaterThan(-1);
      expect(effects.indexOf('ticket_delivery_whatsapp')).toBeLessThan(effects.indexOf('receipt_pdf_delivery'));
      expect(effects.indexOf('ticket_row_creation')).toBeLessThan(effects.indexOf('ticket_delivery_whatsapp'));
      // Finalization still happens only after everything, exactly once.
      expect(rpcNames.filter(n => n === 'finalize_payment_confirmation')).toHaveLength(1);
      expect(rpcNames.lastIndexOf('finalize_payment_confirmation')).toBeGreaterThan(rpcNames.lastIndexOf('reserve_terminal_effect'));
    });
  }
});

describe('#1070 paid confirmation copy — receipt hint only when no receipt is sent automatically', () => {
  const confirmationText = () => String((customerSender.sendText.mock.calls[0]?.[0] as { text: string } | undefined)?.text);

  it.each([['paystack', 'platform'], ['stripe', 'platform'], ['stripe', 'connect']] as const)(
    '%s/%s paid amount: receipt PDF follows, so the confirmation has no "Type receipt" line', async (gateway, origin) => {
      const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
      await sendProactiveConfirmation(fakeDb(gateway, origin) as never, { id: 'pay-1070', amount: 5000, booking_id: 'bk-1070' } as never);
      expect(confirmationText()).toMatch(/Ticket Confirmed/);
      expect(confirmationText()).not.toContain('Type *receipt*');
      expect(events).toContain('document:receipt-WA-TK-9318.pdf');
    });

  it('zero amount: no automatic receipt, so the hint stays', async () => {
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    await sendProactiveConfirmation(fakeDb('paystack', 'platform', 0) as never, { id: 'pay-1070', amount: 0, booking_id: 'bk-1070' } as never);
    expect(confirmationText()).toContain('Type *receipt* to get your receipt');
    expect(events.some(e => e.startsWith('document:receipt-'))).toBe(false);
  });
});
