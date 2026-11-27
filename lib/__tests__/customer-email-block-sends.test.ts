/**
 * #1166 r7 F15, F16, F17, F21, F22: customer emails on the Owner's skip list
 * (S9 "skip") are not sent to a blocked email, and their email copy is not
 * sent for a blocked phone; money and transactional emails (S9 "always send")
 * still go to a blocked email. A failed block read skips (fails closed, as
 * #1103's sends do). Skips are logged without the address.
 *
 * Real modules over an in-memory database: sendOrEmail, the reminders,
 * balance-reminder and subscription-reminders crons, the waitlist notify
 * route, the native-form email broadcast, the intake link email and the
 * party follow-up preview. Faked: the WhatsApp sender, the email provider,
 * SMS, cron auth, auth and the conversation limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

const h = vi.hoisted(() => ({
  emails: [] as Array<{ to: string; subject?: string }>,
  wa: [] as Array<{ to: string; text?: string }>,
  waFails: false,
  sms: vi.fn(),
  logs: [] as Array<{ ctx: Record<string, unknown>; msg: string }>,
  reportFailure: vi.fn(),
  db: null as any,
}));
const sender = {
  sendText: async (m: { to: string; text?: string }) => {
    h.wa.push(m);
    return h.waFails ? { success: false } : { success: true, messageId: 'wamid.1' };
  },
  sendTemplate: async (m: { to: string }) => { h.wa.push(m); return h.waFails ? { success: false } : { success: true, messageId: 'wamid.t' }; },
  sendButtons: async (m: { to: string }) => { h.wa.push(m); return { success: true }; },
};
vi.mock('@/lib/logger', () => {
  const make = (ctx: Record<string, unknown>): any => ({
    info: (msg: string) => h.logs.push({ ctx, msg }), warn: (msg: string) => h.logs.push({ ctx, msg }),
    error: (msg: string) => h.logs.push({ ctx, msg }), debug: () => {},
    withContext: (more: Record<string, unknown>) => make({ ...ctx, ...more }),
  });
  return { logger: make({}) };
});
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: (...a: unknown[]) => h.reportFailure(...a) }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(async (m: { to: string; subject?: string }) => { h.emails.push(m); return { success: true, id: 'em-1' }; }),
  sendEmailToEach: vi.fn(),
}));
vi.mock('@/lib/sms/send', () => ({ sendBusinessSms: (...a: unknown[]) => h.sms(...a) }));
vi.mock('@/lib/sms/bulksms-ng', () => ({ sendSms: vi.fn(async () => ({ sent: true })), isSmsEligible: () => false, isSmsConfigured: () => false }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: vi.fn(async () => ({ allowed: true })), trackOutboundMessage: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn(async () => null) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId() { return { channel: { id: 'ch-1', channel_type: 'dedicated', phone_number_id: 'pn-1', provider: 'meta_cloud', waba_id: 'w' }, sender }; }
  },
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner-1' }, service: h.db }) }));
vi.mock('@/lib/whatsapp-forms/release-gate', () => ({ nativeFormsEnabled: () => true }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));

import { sendOrEmail } from '@/lib/channels/send-or-email';

const BIZ = '11111111-1111-4111-8111-111111111111';
const BLOCKED_PHONE = '2348012345678';
const CLEAR_PHONE = '2348099999999';
const BLOCKED_EMAIL = 'ann@example.com';
const CLEAR_EMAIL = 'clear@example.com';
const NOW = new Date('2026-11-18T10:00:00Z');
const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().split('T')[0];

function blocks(extra: Record<string, unknown[]> = {}, opts: { fail?: boolean } = {}) {
  const db: any = createMemoryDb({
    customer_suspensions: [{ id: 's1', phone: BLOCKED_PHONE, reason: 'abuse', suspended_at: '2026-11-17T00:00:00Z', last_notified_at: null }],
    customer_email_blocks: [{ id: 'e1', email: BLOCKED_EMAIL, reason: 'abuse', blocked_at: '2026-11-17T00:00:00Z' }],
    ...extra,
  });
  if (opts.fail) db.failReads.add('customer_email_blocks');
  h.db = db;
  return db;
}
const emailed = () => h.emails.map(e => e.to);
const skipLogs = () => h.logs.filter(l => l.msg === 'customer_block.email_skipped').map(l => l.ctx);

beforeEach(() => {
  h.emails.length = 0; h.wa.length = 0; h.logs.length = 0; h.waFails = false;
  h.sms.mockReset().mockResolvedValue({ status: 'sent' });
  h.reportFailure.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('sendOrEmail (F15, F16, F17)', () => {
  const base = (to: string, address: string, extra: Record<string, unknown> = {}) => sendOrEmail({
    supabase: h.db, sender: sender as never, to, text: 'Hi', businessName: 'Biz', alwaysEmail: true,
    email: { address, subject: 'S', html: '<p>x</p>' }, ...extra,
  });

  it('a skip-list send does not email a blocked address; WhatsApp still goes; logged without the address', async () => {
    blocks();
    const r = await base(CLEAR_PHONE, ' Ann@Example.com', { emailBlock: { send: 'booking_reminder', businessId: BIZ } });
    expect(r).toEqual({ whatsapp: 'sent', email: 'skipped' });
    expect(emailed()).toEqual([]);
    expect(skipLogs()).toEqual([{ op: 'customer_block.email_skipped', send: 'booking_reminder', business_id: BIZ }]);
    expect(JSON.stringify(h.logs)).not.toMatch(/ann@example\.com/i);
  });

  it('a blocked phone skips the email copy to an unblocked address (F16), in local format with the business country', async () => {
    blocks();
    await base(BLOCKED_PHONE, CLEAR_EMAIL, { emailBlock: { send: 'booking_reminder', businessId: BIZ } });
    await base('08012345678', CLEAR_EMAIL, { emailBlock: { send: 'balance_reminder', businessId: BIZ, countryCode: 'NG' } });
    expect(emailed()).toEqual([]);
  });

  it('a clear customer still gets the email', async () => {
    blocks();
    await base(CLEAR_PHONE, CLEAR_EMAIL, { emailBlock: { send: 'booking_reminder', businessId: BIZ } });
    expect(emailed()).toEqual([CLEAR_EMAIL]);
  });

  it('money and transactional sends (no emailBlock) still email a blocked address (F17)', async () => {
    blocks();
    await base(BLOCKED_PHONE, BLOCKED_EMAIL);
    expect(emailed()).toEqual([BLOCKED_EMAIL]);
  });

  it('fails closed: an unreadable block skips the email and is reported', async () => {
    blocks({}, { fail: true });
    const r = await base(CLEAR_PHONE, CLEAR_EMAIL, { emailBlock: { send: 'booking_reminder', businessId: BIZ } });
    expect(r.email).toBe('skipped');
    expect(emailed()).toEqual([]);
    expect(h.reportFailure).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ area: 'customer_block', op: 'email_send_check' }));
  });

  it('a blocked email is not a delivery failure: no SMS stands in for it', async () => {
    blocks();
    h.waFails = true;
    await base(CLEAR_PHONE, BLOCKED_EMAIL, { emailBlock: { send: 'booking_reminder', businessId: BIZ }, smsFallback: { businessId: BIZ, idempotencyKey: 'k' } });
    expect(emailed()).toEqual([]);
    expect(h.sms).not.toHaveBeenCalled();
  });
});

describe('reminders cron (/api/cron/reminders): booking, reservation, event and overdue invoice', () => {
  const business = { name: 'Lagos Barbers' };
  function world() {
    return blocks({
      businesses: [{ id: BIZ, metadata: { reminder_hours: [24] }, subscription_tier: 'growth' }],
      bookings: [
        // With a clear phone: WhatsApp goes, the blocked email copy does not.
        { id: 'bk-1', business_id: BIZ, date: day(1), time: null, status: 'confirmed', guest_name: 'Ada', guest_phone: CLEAR_PHONE,
          guest_email: BLOCKED_EMAIL, user_id: null, reference_code: 'R1', reminder_24h_sent: false, reminder_2h_sent: true, businesses: business, services: { name: 'Haircut' } },
        // Email only (no phone): blocked → nothing; clear → email.
        { id: 'bk-2', business_id: BIZ, date: day(1), time: null, status: 'confirmed', guest_name: 'Ada', guest_phone: null,
          guest_email: 'ANN@example.com', user_id: null, reference_code: 'R2', reminder_24h_sent: false, reminder_2h_sent: true, businesses: business, services: { name: 'Haircut' } },
        { id: 'bk-3', business_id: BIZ, date: day(1), time: null, status: 'confirmed', guest_name: 'Bo', guest_phone: null,
          guest_email: CLEAR_EMAIL, user_id: null, reference_code: 'R3', reminder_24h_sent: false, reminder_2h_sent: true, businesses: business, services: { name: 'Haircut' } },
      ],
      reservations: [
        { id: 'rs-1', business_id: BIZ, check_in: day(1), status: 'confirmed', guest_name: 'Ada', guest_phone: null, guest_email: BLOCKED_EMAIL, reference_code: 'RES', businesses: business },
        // With a clear phone: WhatsApp goes, the blocked email copy does not.
        { id: 'rs-2', business_id: BIZ, check_in: day(1), status: 'confirmed', guest_name: 'Ada', guest_phone: CLEAR_PHONE, guest_email: BLOCKED_EMAIL, reference_code: 'RES2', businesses: business },
      ],
      events: [{ id: 'ev-1', business_id: BIZ, name: 'AfroFest', date: day(1), time: '18:00', venue: 'Lagos', status: 'published', businesses: { name: 'AfroFest', country_code: 'NG' } }],
      event_tickets: [{ id: 'tk-1', event_id: 'ev-1', status: 'valid', reminder_sent: false, guest_name: 'Ada', guest_phone: CLEAR_PHONE, guest_email: BLOCKED_EMAIL }],
      parties: [],
      invoices: [
        { id: 'inv-1', business_id: BIZ, status: 'overdue', customer_email: BLOCKED_EMAIL, customer_name: 'Ada', total_amount: 100, due_date: day(-3), businesses: business },
        { id: 'inv-2', business_id: BIZ, status: 'overdue', customer_email: CLEAR_EMAIL, customer_name: 'Bo', total_amount: 100, due_date: day(-3), businesses: business },
        // A clear email on an invoice whose phone is blocked (F16), stored in local format.
        { id: 'inv-3', business_id: BIZ, status: 'overdue', customer_email: 'third@example.com', customer_phone: '08012345678', customer_name: 'Cy', total_amount: 100, due_date: day(-3), businesses: { name: 'Lagos Barbers', country_code: 'NG' } },
      ],
      customer_profiles: [], orders: [], profiles: [],
    });
  }

  it('skips every reminder email to a blocked address; WhatsApp to clear phones and clear emails still go', async () => {
    world();
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/reminders/route');
    expect((await GET(new Request('http://localhost/api/cron') as never)).status).toBe(200);
    expect(h.wa.map(w => w.to)).toEqual([CLEAR_PHONE, CLEAR_PHONE, CLEAR_PHONE]); // booking, reservation and event, all clear phones
    expect(emailed().sort()).toEqual([CLEAR_EMAIL, CLEAR_EMAIL]); // bk-3 reminder + inv-2 overdue
    expect(emailed()).not.toContain(BLOCKED_EMAIL);
    expect(emailed()).not.toContain('third@example.com');
    expect(new Set(skipLogs().map(l => l.send))).toEqual(new Set(['booking_reminder', 'reservation_reminder', 'event_reminder', 'invoice_overdue_reminder']));
  });

  it('after unblock nothing is replayed: the next run sends only what is due then (F21)', async () => {
    const db = world();
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/reminders/route');
    await GET(new Request('http://localhost/api/cron') as never);
    db.tables.customer_email_blocks = [];
    h.emails.length = 0;
    // The overdue-invoice reminder is a daily repeat by design; no other blocked email is caught up.
    vi.setSystemTime(new Date(NOW.getTime() + 3 * 86_400_000));
    await GET(new Request('http://localhost/api/cron') as never);
    // Only the daily overdue-invoice repeat reaches the now-unblocked address: no reminder from the blocked period is replayed.
    expect(emailed().filter(e => e === BLOCKED_EMAIL)).toEqual([BLOCKED_EMAIL]);
  });
});

describe('balance-reminder and subscription-reminders crons', () => {
  it.each([[BLOCKED_EMAIL, []], [CLEAR_EMAIL, [CLEAR_EMAIL, CLEAR_EMAIL]]])('balance reminders (reservation and booking) with email %s: emails %j, WhatsApp still goes', async (address, expected) => {
    blocks({
      // Both loops: the reservation balance reminder and the booking balance reminder.
      reservations: [{ id: 'rs-1', business_id: BIZ, check_in: day(1), status: 'confirmed', deposit_status: 'paid', total_amount: 50000, deposit_amount: 10000,
        guest_phone: CLEAR_PHONE, guest_name: 'Ada', reference_code: 'RES', businesses: { name: 'Lagos Suites', country_code: 'NG', payment_gateway: 'paystack' } }],
      bookings: [{ id: 'bk-1', business_id: BIZ, date: day(1), status: 'confirmed', deposit_status: 'paid', total_amount: 20000, deposit_amount: 5000,
        guest_phone: CLEAR_PHONE, guest_name: 'Ada', guest_email: address, reference_code: 'BK', businesses: { name: 'Lagos Spa', country_code: 'NG', payment_gateway: 'paystack' } }],
      whatsapp_config: [], profiles: [], orders: [],
      customer_profiles: [{ business_id: BIZ, phone: `+${CLEAR_PHONE}`, email: address }],
    });
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/balance-reminder/route');
    await GET(new Request('http://localhost/api/cron') as never);
    expect(h.wa.map(w => w.to)).toEqual([CLEAR_PHONE, CLEAR_PHONE]);
    expect(emailed()).toEqual(expected);
  });

  it.each([[BLOCKED_EMAIL, []], [CLEAR_EMAIL, [CLEAR_EMAIL, CLEAR_EMAIL]]])('subscription setup reminder and expiry notice with email %s: emails %j', async (address, expected) => {
    h.waFails = true; // the email goes as the fallback here
    blocks({
      customer_subscriptions: [{ id: 'remind-1', business_id: BIZ, customer_phone: CLEAR_PHONE, customer_name: 'Ada', customer_email: address,
        status: 'pending', gateway: 'stripe', created_at: new Date(NOW.getTime() - 30 * 3_600_000).toISOString(), businesses: { name: 'Lagos Gym' } },
        // Older than the setup window: the expiry notice path.
        { id: 'expire-1', business_id: BIZ, customer_phone: CLEAR_PHONE, customer_name: 'Ada', customer_email: address,
        status: 'pending', gateway: 'stripe', created_at: new Date(NOW.getTime() - 80 * 3_600_000).toISOString(), businesses: { name: 'Lagos Gym' } }],
      customer_profiles: [], bookings: [], orders: [],
    });
    vi.resetModules();
    const { GET } = await import('@/app/api/cron/subscription-reminders/route');
    await GET(new Request('http://localhost/api/cron') as never);
    expect(h.wa.map(w => w.to)).toEqual([CLEAR_PHONE, CLEAR_PHONE]);
    expect(emailed()).toEqual(expected);
  });
});

describe('native-form email broadcast (F22: counted as skipped, like no permission)', () => {
  it('a blocked email or phone is skipped; the clear one is sent', async () => {
    process.env.RESEND_API_KEY = 'test';
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.waaiio.com';
    process.env.FLOW_TOKEN_SECRET = process.env.FLOW_TOKEN_SECRET || 'flow-token-secret-for-tests-only-0123456789';
    blocks({
      form_responses: [
        { id: 'r1', business_id: BIZ, submission_source: 'native', customer_email: BLOCKED_EMAIL, customer_phone: '+2348011111111' },
        { id: 'r2', business_id: BIZ, submission_source: 'native', customer_email: 'other@example.com', customer_phone: `+${BLOCKED_PHONE}` },
        { id: 'r3', business_id: BIZ, submission_source: 'native', customer_email: CLEAR_EMAIL, customer_phone: '+2348022222222' },
      ],
      native_form_email_batches: [], native_form_email_unsubscribes: [], messaging_opt_outs: [],
      customer_consents: ['+2348011111111', `+${BLOCKED_PHONE}`, '+2348022222222'].map((phone, i) => ({
        id: `c${i}`, business_id: BIZ, phone, channel: 'email', purpose: 'marketing', status: 'granted', expires_at: null, created_at: '2026-11-01T00:00:00Z',
      })),
    });
    h.db.rpc = async () => ({ data: null, error: null });
    vi.resetModules();
    const consent = await import('@/lib/whatsapp-forms/email-consent');
    vi.spyOn(consent, 'hasEmailMarketingPermission').mockResolvedValue(true);
    const { dispatchNativeFormEmails } = await import('@/lib/whatsapp-forms/email-broadcast');
    const result = await dispatchNativeFormEmails({ db: h.db, businessId: BIZ, businessName: 'Biz', requestId: '55555555-5555-4555-8555-555555555555',
      responseIds: ['r1', 'r2', 'r3'], message: 'News' } as never);
    expect(result).toMatchObject({ accepted: 1, skipped: 2, total: 3 });
    expect(emailed()).toEqual([CLEAR_EMAIL]);
  });
});

describe('waitlist "a spot opened" (POST /api/waitlist/notify)', () => {
  it.each([[BLOCKED_EMAIL, []], [CLEAR_EMAIL, [CLEAR_EMAIL]]])('email fallback to %s: sent %j', async (address, expected) => {
    blocks({
      businesses: [{ id: BIZ, owner_id: 'owner-1', name: 'Biz', country_code: 'NG' }],
      waitlist_entries: [{ id: 'w1', business_id: BIZ, customer_phone: CLEAR_PHONE, customer_name: 'Ada', status: 'waiting', position: 1, created_at: '2026-11-01' }],
      customer_profiles: [{ business_id: BIZ, phone: CLEAR_PHONE, email: address }],
      bookings: [], orders: [],
    });
    h.waFails = true; // WhatsApp unavailable → the email would be the fallback
    vi.resetModules();
    const { POST } = await import('@/app/api/waitlist/notify/route');
    const { NextRequest } = await import('next/server');
    await POST(new NextRequest('https://app.test/api/waitlist/notify', { method: 'POST', body: JSON.stringify({ businessId: BIZ, entryId: 'w1' }) }));
    expect(emailed()).toEqual(expected);
  });
});
