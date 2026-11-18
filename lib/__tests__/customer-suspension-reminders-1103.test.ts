/**
 * #1103 follow-up: a suspended customer's number gets no reminder, automation
 * message or after-payment follow-up (Owner decision 2026-11-17: blocked from
 * ALL bots; money untouched). Reminders fail closed.
 *
 * Real modules over an in-memory database: the booking/reservation/event
 * reminder cron, the balance-reminder cron, the automation rules engine (live
 * and sealed after-payment paths) and the after-payment follow-up (saved-card
 * and recurring offers, opt-in, menu). Faked: the WhatsApp sender, email, SMS,
 * cron auth and the conversation limit.
 *
 * Covered elsewhere: party reminders (party-reminders-preview-490), intake
 * reminders (intake-send-963), Edge Function campaigns and reminders
 * (customer-suspension-edge-1103), and the payment confirmation still sending
 * (post-payment-message-order-1070).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

const h = vi.hoisted(() => {
  const sent: Array<{ to: string; text?: string; kind: string }> = [];
  const record = (kind: string) => async (m: { to: string; text?: string }) => {
    sent.push({ to: m.to, text: m.text, kind });
    return { success: true, messageId: `wamid.${kind}` };
  };
  return {
    sent,
    advance: [] as Array<{ ruleId: string; state: string }>,
    quiet: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sender: { sendText: record('text'), sendButtons: record('buttons'), sendList: record('list'), sendTemplate: record('template') },
  };
});
const { sender } = h;
vi.mock('@/lib/logger', () => ({ logger: { ...h.quiet, withContext: () => h.quiet } }));
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: vi.fn() }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/sms/bulksms-ng', () => ({ sendSms: vi.fn(async () => ({ sent: true })), isSmsEligible: () => false }));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })), trackOutboundMessage: vi.fn(),
}));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn(async () => null) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId() { return { channel: { id: 'ch-1', channel_type: 'dedicated', phone_number_id: 'pn-1' }, sender: h.sender }; }
    async resolveByChannelIdForBusiness() { return { channel: { id: 'ch-1', channel_type: 'dedicated', phone_number_id: 'pn-1' }, sender: h.sender }; }
  },
}));
// Sealed after-payment rule actions: the frozen manifest lives in RPCs; record the state moves.
vi.mock('@/lib/payments/terminal-effects', () => ({
  readRuleActionManifest: vi.fn(async () => ({ ok: true, exists: true, actionCount: 2 })),
  readFrozenRuleActions: vi.fn(async () => ({
    ok: true,
    rows: [
      { rule_id: 'r-customer', action_type: 'send_message', action_payload: { message: 'Thanks {customer_name}!' }, status: 'pending' },
      { rule_id: 'r-owner', action_type: 'notify_owner', action_payload: { message: 'New payment' }, status: 'pending' },
    ].map(row => ({ ...row, status: h.advance.find(a => a.ruleId === row.rule_id && a.state !== 'sending')?.state ?? row.status })),
  })),
  advanceRuleAction: vi.fn(async (_db: unknown, _pay: string, ruleId: string, state: string) => { h.advance.push({ ruleId, state }); return { ok: true }; }),
  sealRuleActions: vi.fn(),
}));

import { blocksReminder, proactiveSuspensionStatus } from '@/lib/customer-suspension';

const BIZ = '11111111-1111-4111-8111-111111111111';
const SUSPENDED = '2348012345678';
const CLEAR = '2348099999999';
const NOW = new Date('2026-11-18T10:00:00Z');
const day = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * 86_400_000).toISOString().split('T')[0];
const suspension = { id: 'sus-1', phone: SUSPENDED, reason: 'abuse', suspended_by: 'admin-1', suspended_at: '2026-11-17T00:00:00Z', last_notified_at: null };
const req = () => new Request('http://localhost/api/cron') as never;

beforeEach(() => {
  h.sent.length = 0; h.advance.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('blocksReminder / proactiveSuspensionStatus', () => {
  it('blocks a suspended number in any format, clears others, fails closed on a read error', async () => {
    const db: any = createMemoryDb({ customer_suspensions: [suspension] });
    expect(await blocksReminder(db, SUSPENDED)).toBe(true);
    expect(await blocksReminder(db, `+${SUSPENDED}`)).toBe(true);
    expect(await blocksReminder(db, '+234 801 234 5678')).toBe(true);
    expect(await blocksReminder(db, CLEAR)).toBe(false);
    db.failReads.add('customer_suspensions');
    expect(await blocksReminder(db, CLEAR)).toBe(true);
    expect(await proactiveSuspensionStatus(db, CLEAR)).toBe('unknown');
  });

  it('a number that is not E.164 digits can never match a suspension key, so it is clear', async () => {
    const db: any = createMemoryDb({ customer_suspensions: [suspension] });
    db.failReads.add('customer_suspensions');
    expect(await proactiveSuspensionStatus(db, '08012345678')).toBe('clear');
    expect(await blocksReminder(db, '')).toBe(false);
  });
});

describe('reminders cron (/api/cron/reminders)', () => {
  function world() {
    const business = { name: 'Lagos Barbers' };
    return createMemoryDb({
      businesses: [{ id: BIZ, metadata: { reminder_hours: [24] }, subscription_tier: 'growth' }],
      bookings: [SUSPENDED, CLEAR].map(phone => ({
        id: `bk-${phone}`, business_id: BIZ, date: day(1), time: null, status: 'confirmed', guest_name: 'Ada',
        guest_phone: phone, guest_email: null, user_id: null, reference_code: `REF-${phone.slice(-4)}`,
        reminder_24h_sent: false, reminder_2h_sent: true, businesses: business, services: { name: 'Haircut' },
      })),
      reservations: [SUSPENDED, CLEAR].map(phone => ({
        id: `rs-${phone}`, business_id: BIZ, check_in: day(1), status: 'confirmed', guest_name: 'Ada',
        guest_phone: phone, guest_email: null, reference_code: 'RES', businesses: business,
      })),
      events: [{ id: 'ev-1', business_id: BIZ, name: 'AfroFest', date: day(1), time: '18:00', venue: 'Lagos', status: 'published', businesses: { name: 'AfroFest', country_code: 'NG' } }],
      event_tickets: [SUSPENDED, CLEAR].map(phone => ({
        id: `tk-${phone}`, event_id: 'ev-1', status: 'valid', reminder_sent: false, guest_name: 'Ada', guest_phone: phone, guest_email: null,
      })),
      parties: [], invoices: [], customer_profiles: [], orders: [],
      customer_suspensions: [suspension],
    });
  }

  it('sends booking, reservation and event reminders only to the customer who is not suspended', async () => {
    const db: any = world();
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/reminders/route');
    const res = await GET(req());
    expect(res.status).toBe(200);

    expect(h.sent.map(s => s.to)).toEqual([CLEAR, CLEAR, CLEAR]);
    expect(h.sent.map(s => s.text)).toEqual([
      expect.stringContaining('Haircut'), expect.stringContaining('check-in'), expect.stringContaining('AfroFest'),
    ]);
    // The suspended customer's reminder stays unsent, so it is not marked sent either.
    expect(db.tables.bookings.find((b: any) => b.guest_phone === SUSPENDED).reminder_24h_sent).toBe(false);
    expect(db.tables.bookings.find((b: any) => b.guest_phone === CLEAR).reminder_24h_sent).toBe(true);
    expect(db.tables.event_tickets.find((t: any) => t.guest_phone === SUSPENDED).reminder_sent).toBe(false);
    expect(db.tables.event_tickets.find((t: any) => t.guest_phone === CLEAR).reminder_sent).toBe(true);
  });

  it('sends no reminder at all when the suspension status cannot be read (fails closed)', async () => {
    const db: any = world();
    db.failReads.add('customer_suspensions');
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/reminders/route');
    await GET(req());
    expect(h.sent).toEqual([]);
  });
});

describe('balance-reminder cron (/api/cron/balance-reminder)', () => {
  it('sends the reservation and booking balance reminders only to the customer who is not suspended; read failure sends none', async () => {
    const world = () => createMemoryDb({
      reservations: [SUSPENDED, CLEAR].map(phone => ({
        id: `rs-${phone}`, business_id: BIZ, check_in: day(1), status: 'confirmed', deposit_status: 'paid',
        total_amount: 50000, deposit_amount: 10000, guest_phone: phone, guest_name: 'Ada', reference_code: 'RES',
        businesses: { name: 'Lagos Suites', country_code: 'NG', payment_gateway: 'paystack' },
      })),
      bookings: [SUSPENDED, CLEAR].map(phone => ({
        id: `bk-${phone}`, business_id: BIZ, date: day(1), status: 'confirmed', deposit_status: 'paid',
        total_amount: 20000, deposit_amount: 5000, guest_phone: phone, guest_name: 'Ada', reference_code: 'BK',
        businesses: { name: 'Lagos Spa', country_code: 'NG', payment_gateway: 'paystack' },
      })),
      whatsapp_config: [], profiles: [], customer_profiles: [], orders: [],
      customer_suspensions: [suspension],
    });
    for (const failRead of [false, true]) {
      h.sent.length = 0;
      const db: any = world();
      if (failRead) db.failReads.add('customer_suspensions');
      vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
      vi.resetModules();
      const { GET } = await import('@/app/api/cron/balance-reminder/route');
      await GET(req());
      expect(h.sent.map(s => s.to)).toEqual(failRead ? [] : [CLEAR, CLEAR]);
      if (!failRead) expect(h.sent[0].text).toContain('Balance Reminder');
    }
  });
});

describe('subscription-reminders cron (/api/cron/subscription-reminders)', () => {
  it('no setup reminder or expiry notice to a suspended customer; the stale setup still expires', async () => {
    const db: any = createMemoryDb({
      customer_subscriptions: [SUSPENDED, CLEAR].flatMap(phone => [
        { id: `remind-${phone}`, business_id: BIZ, customer_phone: phone, customer_name: 'Ada', customer_email: null, status: 'pending', gateway: 'stripe', created_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString(), businesses: { name: 'Lagos Gym' } },
        { id: `expire-${phone}`, business_id: BIZ, customer_phone: phone, customer_name: 'Ada', customer_email: null, status: 'pending', gateway: 'stripe', created_at: new Date(NOW.getTime() - 80 * 3_600_000).toISOString(), businesses: { name: 'Lagos Gym' } },
      ]),
      customer_profiles: [], bookings: [], orders: [],
      customer_suspensions: [suspension],
    });
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/subscription-reminders/route');
    await GET(req());
    expect(h.sent.map(s => s.to)).toEqual([CLEAR, CLEAR]);
    expect(db.tables.customer_subscriptions.find((r: any) => r.id === `expire-${SUSPENDED}`).status).toBe('failed');
  });
});

describe('automation rules (merchant-authored messages)', () => {
  const rules = [
    { id: 'r-customer', business_id: BIZ, name: 'Thank you', trigger_event: 'payment_received', is_active: true, conditions: [], action_type: 'send_message', action_payload: { message: 'Thanks {customer_name}!' }, priority: 3 },
    { id: 'r-template', business_id: BIZ, name: 'Promo', trigger_event: 'payment_received', is_active: true, conditions: [], action_type: 'send_template', action_payload: { template_name: 'promo_v1' }, priority: 2 },
    { id: 'r-owner', business_id: BIZ, name: 'Tell owner', trigger_event: 'payment_received', is_active: true, conditions: [], action_type: 'notify_owner', action_payload: { message: 'New payment' }, priority: 1 },
  ];
  const world = () => createMemoryDb({
    bot_rules: rules, businesses: [{ id: BIZ, phone: '+2348000000001', owner_id: null }], customer_suspensions: [suspension],
  });
  const run = async (db: any, phone: string) => {
    const { evaluateRules } = await import('@/lib/bot/automation/rules-engine');
    const sendMessage = vi.fn(async (to: string, text: string) => { h.sent.push({ to, text, kind: 'text' }); });
    const sendTemplate = vi.fn(async (to: string) => { h.sent.push({ to, kind: 'template' }); });
    await evaluateRules(db, BIZ, 'payment_received', { customer_phone: `+${phone}`, customer_name: 'Ada' }, sendMessage, sendTemplate);
  };

  it('a suspended customer gets no rule message or template; the owner is still notified', async () => {
    await run(world(), SUSPENDED);
    expect(h.sent).toEqual([{ to: '2348000000001', text: expect.stringContaining('New payment'), kind: 'text' }]);
  });

  it('a customer who is not suspended gets both, as before', async () => {
    await run(world(), CLEAR);
    expect(h.sent.map(s => [s.to, s.kind])).toEqual([[CLEAR, 'text'], [CLEAR, 'template'], ['2348000000001', 'text']]);
  });

  it('a customer whose number is stored in local format (cannot match a suspension) is still messaged', async () => {
    const { evaluateRules } = await import('@/lib/bot/automation/rules-engine');
    const sendMessage = vi.fn(async (to: string, text: string) => { h.sent.push({ to, text, kind: 'text' }); });
    await evaluateRules(world() as any, BIZ, 'payment_received', { customer_phone: '08099999999', customer_name: 'Ada' }, sendMessage, vi.fn(async () => {}));
    expect(sendMessage.mock.calls.map(c => c[0])).toContain('08099999999');
  });

  it('an unreadable suspension status sends no customer message (fails closed)', async () => {
    const db: any = world();
    db.failReads.add('customer_suspensions');
    await run(db, CLEAR);
    expect(h.sent.map(s => s.to)).toEqual(['2348000000001']);
  });

  it('sealed after-payment actions: the suspended customer\'s message settles as failed before the sending fence', async () => {
    const { runSealedRuleActions } = await import('@/lib/bot/automation/sealed-rule-actions');
    const db: any = world();
    await runSealedRuleActions({
      supabase: db, paymentId: 'pay-1', businessId: BIZ, event: 'payment_received',
      context: { customer_phone: `+${SUSPENDED}`, customer_name: 'Ada' }, sender: sender as never,
    });
    expect(h.advance.filter(a => a.ruleId === 'r-customer')).toEqual([{ ruleId: 'r-customer', state: 'failed' }]);
    expect(h.advance.filter(a => a.ruleId === 'r-owner').map(a => a.state)).toEqual(['sending', 'completed']);
    expect(h.sent.map(s => s.to)).toEqual(['2348000000001']);
  });
});

describe('after-payment follow-up (saved-card and recurring offers, opt-in, menu)', () => {
  const PAY = 'pay-1103';
  const world = (state: string) => createMemoryDb({
    transaction_followups: [{
      id: 'fu-1', completion_key: `payment:${PAY}`, business_id: BIZ, phone: `+${SUSPENDED}`, channel_id: 'ch-1',
      payment_id: PAY, kind: 'payment', lang: 'en', state, response: null, responded_at: null, acknowledgment: null,
      includes_waaiio: null, claim_token: null, claim_until: null, updated_at: '2026-11-18T09:00:00Z',
    }],
    payments: [{ id: PAY, business_id: BIZ, status: 'success', gateway: 'paystack', amount: 5000, booking_id: null, confirmation_sent_at: '2026-11-18T09:00:00Z', metadata: { payment_origin: 'platform' } }],
    payment_confirmation_deliveries: [{ id: 'd1', payment_id: PAY, delivery_status: 'accepted' }],
    payment_saved_card_offers: [], bot_sessions: [],
    businesses: [{ id: BIZ, name: 'Lagos Barbers', subscription_tier: 'growth', is_whitelabel: false }],
    customer_suspensions: [suspension],
  });

  it('right after the confirmation: no card offer or anything else is sent, and the follow-up is retired', async () => {
    const db: any = world('waiting_card');
    const { resumePaidTransactionFollowup } = await import('@/lib/payments/transaction-followup');
    await resumePaidTransactionFollowup(db, PAY);
    expect(h.sent).toEqual([]);
    expect(db.tables.transaction_followups[0].state).toBe('done');
    expect(db.tables.payment_saved_card_offers).toEqual([]);
  });

  it('recovery cron: a queued opt-in or menu (which carries the recurring offer) is retired unsent', async () => {
    for (const state of ['ready', 'card_resolved', 'menu_ready']) {
      h.sent.length = 0;
      const db: any = world(state);
      const { recoverTransactionFollowups } = await import('@/lib/bot/transaction-followups');
      await recoverTransactionFollowups(db, 10);
      expect(h.sent, state).toEqual([]);
      expect(db.tables.transaction_followups[0].state, state).toBe('done');
    }
  });

  it('an unreadable suspension status sends nothing and leaves the follow-up for a later run', async () => {
    const db: any = world('waiting_card');
    db.failReads.add('customer_suspensions');
    const { resumePaidTransactionFollowup } = await import('@/lib/payments/transaction-followup');
    await resumePaidTransactionFollowup(db, PAY);
    expect(h.sent).toEqual([]);
    expect(db.tables.transaction_followups[0].state).toBe('waiting_card');
  });
});
