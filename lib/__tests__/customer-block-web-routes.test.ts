/**
 * #1166 r7 F9–F14, F11 (Q7 C, Q14 A), S1(b), S5: every website route a customer
 * uses to start something refuses a blocked phone or a blocked email before its
 * first write, with one neutral message; a clear customer passes; a failed
 * block read lets the request through and is reported (Q10 A).
 *
 * Handler level: the real route handlers and the real lib/customer-block.ts.
 * The two block tables live in the in-memory database (real filtering); every
 * other table, RPC, auth call and storage call goes through a recording fake,
 * so "nothing created before refusal" is checked against every write the
 * route could make. Payment start, email sends, OTP challenges, tax quotes and
 * provider calls are mocks whose calls are counted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { createMemoryDb } from './helpers/memory-db';

const PHONE = '2348012345678';
const EMAIL = 'ann@example.com';
const BIZ = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const TEXT = "This service isn't available. If you think this is a mistake, contact support@waaiio.com";

const h = vi.hoisted(() => ({
  db: null as any,
  rows: {} as Record<string, unknown>,
  rpcs: {} as Record<string, { data: unknown; error: unknown }>,
  writes: [] as Array<{ table: string; op: string; values?: unknown }>,
  reads: [] as string[],
  failUpdate: false,
  initializePayment: vi.fn(),
  sendEmail: vi.fn(),
  generateOtpChallenge: vi.fn(),
  quoteBookingTax: vi.fn(),
  webBeforeBookingForm: vi.fn(),
  createRecurringCheckout: vi.fn(),
  gatewayInit: vi.fn(),
  reportFailure: vi.fn(),
  sendText: vi.fn(),
  logs: [] as Array<{ ctx: Record<string, unknown>; msg: string }>,
}));

/** A query builder for one table: records writes, returns h.rows[table]. */
function builder(table: string) {
  let write: { op: string; values?: unknown } | null = null;
  const result = (single: boolean) => {
    if (write) {
      if (write.op === 'update' && h.failUpdate) return { data: null, error: { message: 'update failed' } };
      return { data: single ? { id: `${table}-new`, access_token: 't' } : [{ id: `${table}-new` }], error: null };
    }
    const row = h.rows[table];
    const value = typeof row === 'function' ? (row as () => unknown)() : row;
    if (single) return { data: Array.isArray(value) ? value[0] ?? null : value ?? null, error: null };
    return { data: Array.isArray(value) ? value : value ? [value] : [], error: null, count: 0 };
  };
  const q: any = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'not', 'or', 'order', 'limit', 'range', 'gte', 'lte', 'gt', 'lt', 'ilike', 'match', 'filter']) {
    q[m] = () => q;
  }
  // Filters on a write are recorded, so a test can assert them.
  q.is = (col: string, value: unknown) => { if (write) (h.writes[h.writes.length - 1] as any).is = [col, value]; return q; };
  for (const op of ['insert', 'update', 'upsert', 'delete']) {
    q[op] = (values?: unknown) => { write = { op, values }; h.writes.push({ table, op, values }); return q; };
  }
  q.single = async () => result(true);
  q.maybeSingle = async () => result(true);
  q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result(false)).then(resolve, reject);
  return q;
}

const BLOCK_TABLES = new Set(['customer_suspensions', 'customer_email_blocks']);
function service() {
  return {
    from: (table: string) => {
      h.reads.push(table);
      return BLOCK_TABLES.has(table) ? h.db.from(table) : builder(table);
    },
    rpc: (name: string, args: unknown) => {
      h.writes.push({ table: `rpc:${name}`, op: 'rpc', values: args });
      const r = h.rpcs[name] ?? { data: null, error: { message: `rpc ${name} not configured` } };
      const p: any = Promise.resolve(r);
      p.single = async () => r;
      p.maybeSingle = async () => r;
      return p;
    },
    auth: { admin: { createUser: async (args: unknown) => { h.writes.push({ table: 'auth.users', op: 'createUser', values: args }); return { data: { user: { id: 'user-new' } }, error: null }; } } },
    storage: { from: () => ({ upload: async () => { h.writes.push({ table: 'storage', op: 'upload' }); return { error: null }; } }) },
  };
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => service() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => service() }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true }),
  getRateLimitKey: vi.fn().mockReturnValue('rl'),
}));
vi.mock('@/lib/brute-force', () => ({ checkBruteForce: () => ({ blocked: false }), recordFailure: vi.fn(), clearFailures: vi.fn() }));
vi.mock('@/lib/otp-token', () => ({ verifyOtpToken: (t: string) => (t === 'good' ? EMAIL : t.startsWith('as:') ? t.slice(3) : null) }));
vi.mock('@/lib/otp-challenge', () => ({ generateOtpChallenge: h.generateOtpChallenge, verifyOtpChallenge: vi.fn() }));
vi.mock('@/lib/email/client', () => ({ sendEmail: h.sendEmail, sendEmailToEach: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: h.initializePayment }));
vi.mock('@/lib/tax/server-quote', () => ({ quoteBookingTax: h.quoteBookingTax, isSafePurchaseAmount: () => true }));
vi.mock('@/lib/intake/send', () => ({
  webBeforeBookingForm: h.webBeforeBookingForm, findWebIntake: vi.fn(), openBeforeBookingIntake: vi.fn(),
  deliverAfterBookingIntake: vi.fn(), linkIntakeToBooking: vi.fn(),
  toE164: (p: string | null) => (p ? `+${p.replace(/\D/g, '')}` : null),
}));
vi.mock('@/lib/campaigns/public-donation', () => ({
  parseDonationInput: (b: any) => ({ value: { attemptId: ATTEMPT, amount: 1000, phone: b.phone, name: 'Ann', email: b.email ?? '' } }),
  loadPublicCampaign: async () => ({ id: CAMPAIGN, business_id: BIZ, min_donation: 1, max_donation: 100000,
    business: { name: 'Biz', country_code: 'NG', subscription_tier: 'growth', status: 'active' } }),
}));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/payments/gateway-resolver', () => ({ resolveBusinessGateway: async () => ({ gateway: 'stripe', currency: 'USD' }) }));
vi.mock('@/lib/payments/factory', () => ({
  getPaymentGateway: () => ({ initializePayment: h.gatewayInit }),
  getPaymentGatewayByName: () => ({ initializePayment: h.gatewayInit }),
}));
vi.mock('@/lib/payments/stripe-recurring', () => ({ createRecurringCheckout: h.createRecurringCheckout }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner-1' } }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstileToken: async () => ({ ok: true }) }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    async resolveByBusinessId() { return { channel: {}, sender: { sendText: h.sendText, boundBusinessId: BIZ } }; }
    async getSharedChannelForCountry() { return null; }
  },
}));
vi.mock('@/lib/channels/send-with-template', () => ({ sendWithTemplate: vi.fn().mockResolvedValue({ success: true }) }));
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: (...a: unknown[]) => h.reportFailure(...a) }));
vi.mock('@/lib/logger', () => {
  const make = (ctx: Record<string, unknown>): any => ({
    info: (msg: string) => h.logs.push({ ctx, msg }), warn: (msg: string) => h.logs.push({ ctx, msg }),
    error: (msg: string) => h.logs.push({ ctx, msg }), debug: () => {},
    withContext: (more: Record<string, unknown>) => make({ ...ctx, ...more }),
  });
  return { logger: make({}), generateRequestId: () => 'req' };
});
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

process.env.META_APP_SECRET = 'test-secret';

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { open: '08:00', close: '20:00' }]));
const QUOTE = { total: 0, deposit: 0, tax_snapshot: null };

function setRows() {
  h.rows = {
    businesses: { id: BIZ, name: 'Biz', slug: 'biz', country_code: 'NG', operating_hours: HOURS, payment_gateway: 'paystack',
      subscription_tier: 'growth', metadata: {}, owner_id: 'owner-1', recurring_enabled: true, status: 'active', phone: null },
    services: { id: 'svc-1', name: 'Cut', price: 0, deposit_amount: 0, duration_minutes: 30, buffer_minutes: 0, max_capacity: 1,
      metadata: {}, requires_staff: false, staff_ids: [], intake_form_id: null, billing_type: 'recurring' },
    profiles: null,
    events: { id: 'evt-1', name: 'Show', price: 0, total_tickets: 100, tickets_sold: 0, status: 'published', max_per_order: 10,
      date: FUTURE, time: '18:00', venue: 'Hall', business_id: BIZ, invite_message: null,
      businesses: { id: BIZ, name: 'Biz', slug: 'biz', country_code: 'NG', payment_gateway: null } },
    payment_links: { id: 'pl-1', title: 'Pay', amount: 500, currency: 'USD', uses_count: 0, expires_at: null, max_uses: null,
      business_id: BIZ, is_active: true, businesses: { name: 'Biz', country_code: 'NG', payment_gateway: 'stripe', status: 'active' } },
    merchant_tax_settings: null,
    forms: { id: 'form-1', business_id: BIZ, fields: [], is_active: true, settings: {} },
    waiver_templates: { id: 'wt-1', business_id: BIZ, title: 'Waiver', is_active: true },
  };
  h.rpcs = {
    book_slot_authoritative_604: { data: { booking_id: 'bk-1', reference_code: 'REF', slot_available: true, committed_total: 0, committed_deposit: 0 }, error: null },
    purchase_tickets_atomic: { data: [{ booking_id: 'bk-2', reference_code: 'TIX', tickets_available: true }], error: null },
    increment_form_response_count: { data: null, error: null },
  };
}

function seedBlocks(opts: { phones?: string[]; emails?: string[]; fail?: boolean } = {}) {
  h.db = createMemoryDb({
    customer_suspensions: (opts.phones ?? []).map((phone, i) => ({ id: `s-${i}`, phone, reason: 'abuse', last_notified_at: null })),
    customer_email_blocks: (opts.emails ?? []).map((email, i) => ({ id: `e-${i}`, email, reason: 'abuse' })),
  });
  if (opts.fail) { h.db.failReads.add('customer_suspensions'); h.db.failReads.add('customer_email_blocks'); }
}

beforeEach(() => {
  setRows();
  seedBlocks();
  h.writes = []; h.reads = []; h.logs = []; h.failUpdate = false;
  for (const m of [h.initializePayment, h.sendEmail, h.generateOtpChallenge, h.quoteBookingTax, h.webBeforeBookingForm,
    h.createRecurringCheckout, h.gatewayInit, h.reportFailure, h.sendText]) m.mockReset();
  h.initializePayment.mockResolvedValue({ url: 'https://pay.test/x', reference: 'ref' });
  h.generateOtpChallenge.mockResolvedValue({ code: '123456', challengeId: 'ch-1' });
  h.sendEmail.mockResolvedValue({ success: true });
  h.quoteBookingTax.mockResolvedValue(QUOTE);
  h.webBeforeBookingForm.mockResolvedValue(null);
  h.createRecurringCheckout.mockResolvedValue({ url: 'https://stripe.test/c', id: 'cs_1' });
  h.gatewayInit.mockResolvedValue({ url: 'https://paystack.test/x', reference: 'r' });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(`https://app.test${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

/** Every write, RPC, account creation, upload, payment start, email and code, made by the route. */
function sideEffects() {
  return {
    writes: h.writes.filter(w => !BLOCK_TABLES.has(w.table)),
    payments: h.initializePayment.mock.calls.length + h.gatewayInit.mock.calls.length + h.createRecurringCheckout.mock.calls.length,
    emails: h.sendEmail.mock.calls.length,
    codes: h.generateOtpChallenge.mock.calls.length,
  };
}
const NOTHING = { writes: [], payments: 0, emails: 0, codes: 0 };

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: TEXT, code: 'customer_unavailable' });
  expect(sideEffects()).toEqual(NOTHING);
}

interface RouteCase {
  name: string;
  call: (who: { phone?: string; email?: string }) => Promise<Response>;
  /** Did the request get past the gate? */
  passed: () => boolean;
  phone: boolean;
  email: boolean;
}

const bookingBody = (who: { phone?: string; email?: string }) => ({
  businessSlug: 'biz', serviceId: 'svc-1', date: FUTURE, time: '10:00', guestName: 'Ann',
  guestEmail: who.email ?? 'clear@example.com', guestPhone: who.phone ?? '2348099999999',
  otpToken: `as:${(who.email ?? 'clear@example.com').toLowerCase().trim()}`,
  expectedTerms: { price: 0, deposit: 0, country: 'NG', quantity: 1, tax_snapshot: null },
});

const ROUTES: RouteCase[] = [
  {
    name: 'POST /api/bookings/public/create', phone: true, email: true,
    call: async who => (await import('@/app/api/bookings/public/create/route')).POST(post('/api/bookings/public/create', bookingBody(who))),
    passed: () => h.quoteBookingTax.mock.calls.length > 0,
  },
  {
    name: 'POST /api/bookings/public/intake', phone: true, email: true,
    call: async who => (await import('@/app/api/bookings/public/intake/route')).POST(post('/api/bookings/public/intake', {
      businessSlug: 'biz', serviceId: '44444444-4444-4444-8444-444444444444',
      guestEmail: who.email ?? 'clear@example.com', guestPhone: who.phone ?? '2348099999999',
      otpToken: `as:${(who.email ?? 'clear@example.com').toLowerCase().trim()}`,
    })),
    passed: () => h.webBeforeBookingForm.mock.calls.length > 0,
  },
  {
    name: 'POST /api/events/purchase', phone: true, email: true,
    call: async who => (await import('@/app/api/events/purchase/route')).POST(post('/api/events/purchase', {
      eventSlug: 'show', quantity: 1, guestName: 'Ann', guestEmail: who.email ?? 'clear@example.com',
      guestPhone: who.phone ?? '2348099999999', otpToken: `as:${(who.email ?? 'clear@example.com').toLowerCase().trim()}`,
    })),
    passed: () => h.writes.some(w => w.table === 'rpc:purchase_tickets_atomic'),
  },
  {
    name: 'POST /api/campaigns/[id]/donate', phone: true, email: true,
    call: async who => (await import('@/app/api/campaigns/[id]/donate/route')).POST(
      post(`/api/campaigns/${CAMPAIGN}/donate`, { phone: who.phone ?? '+2348099999999', email: who.email }),
      { params: Promise.resolve({ id: CAMPAIGN }) }),
    passed: () => h.initializePayment.mock.calls.length > 0,
  },
  {
    name: 'POST /api/pay-link/pay', phone: true, email: true,
    call: async who => (await import('@/app/api/pay-link/pay/route')).POST(post('/api/pay-link/pay', {
      token: 'tok', amount: 500, customer_name: 'Ann', customer_email: who.email ?? 'clear@example.com',
      customer_phone: who.phone ?? '+2348099999999',
    })),
    passed: () => h.writes.some(w => w.table === 'payments' && w.op === 'insert'),
  },
  {
    name: 'POST /api/recurring/setup', phone: true, email: true,
    call: async who => {
      h.rows.businesses = { ...(h.rows.businesses as object), country_code: 'US' };
      return (await import('@/app/api/recurring/setup/route')).POST(post('/api/recurring/setup', {
        businessId: BIZ, serviceId: 'svc-1', amount: '50', frequency: 'monthly', customerName: 'Ann',
        customerEmail: who.email ?? 'clear@example.com', customerPhone: who.phone ?? '+12025550100', channel: 'web',
      }));
    },
    passed: () => h.createRecurringCheckout.mock.calls.length > 0,
  },
  {
    name: 'POST /api/forms/submit (public link)', phone: true, email: true,
    call: async who => (await import('@/app/api/forms/submit/route')).POST(post('/api/forms/submit', {
      token: 'form-token', answers: {}, customer_name: 'Ann', customer_email: who.email, customer_phone: who.phone, turnstileToken: 'ok',
    })),
    passed: () => h.writes.some(w => w.table === 'form_responses'),
  },
  {
    name: 'POST /api/invite-optin', phone: true, email: true,
    call: async who => (await import('@/app/api/invite-optin/route')).POST(post('/api/invite-optin', {
      eventId: 'evt-1', name: 'Ann', phone: who.phone, email: who.email ?? (who.phone ? undefined : 'clear@example.com'),
    })),
    passed: () => h.writes.some(w => w.op === 'insert'),
  },
  {
    name: 'POST /api/checkin', phone: true, email: true,
    call: async who => (await import('@/app/api/checkin/route')).POST(post('/api/checkin', {
      business_id: BIZ, customer_name: 'Ann', customer_phone: who.phone, customer_email: who.email,
    })),
    passed: () => h.writes.some(w => w.op === 'insert'),
  },
  {
    name: 'POST /api/waivers/sign', phone: true, email: true,
    call: async who => (await import('@/app/api/waivers/sign/route')).POST(post('/api/waivers/sign', {
      token: 'wt', first_name: 'Ann', last_name: 'B', customer_phone: who.phone, customer_email: who.email,
      send_via: 'none', signature: 'data:image/png;base64,AAAA',
    })),
    passed: () => h.writes.some(w => w.table === 'storage'),
  },
];

describe.each(ROUTES)('$name', route => {
  it('a clear customer passes the check', async () => {
    seedBlocks({ phones: ['2348011111111'], emails: ['other@example.com'] });
    const res = await route.call({ phone: route.name.includes('recurring') ? '+12025550123' : '+2348099999999', email: 'clear@example.com' });
    expect(res.status).not.toBe(403);
    expect(route.passed()).toBe(true);
  });

  it('a blocked phone is refused with the neutral message before anything is created or charged', async () => {
    const phone = route.name.includes('recurring') ? '12025550123' : PHONE;
    seedBlocks({ phones: [phone] });
    await expectRefused(await route.call({ phone: `+${phone}`, email: 'clear@example.com' }));
    expect(route.passed()).toBe(false);
  });

  it('a blocked email is refused, whatever its letter case', async () => {
    // Padded values are covered by normalizeBlockEmail's unit test; several of
    // these routes reject a padded email as malformed before the check (400).
    seedBlocks({ emails: [EMAIL] });
    await expectRefused(await route.call({ phone: route.name.includes('recurring') ? '+12025550123' : '+2348099999999', email: 'Ann@Example.COM' }));
    expect(route.passed()).toBe(false);
  });

  it('logs customer_block.refused without the phone or email', async () => {
    seedBlocks({ emails: [EMAIL] });
    await route.call({ phone: route.name.includes('recurring') ? '+12025550123' : '+2348099999999', email: EMAIL });
    const refused = h.logs.filter(l => l.msg === 'customer_block.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].ctx).toMatchObject({ business_id: BIZ, matched: 'email' });
    expect(JSON.stringify(h.logs)).not.toContain(EMAIL);
  });

  it('a failed block read lets the request through and is reported (Q10 A)', async () => {
    seedBlocks({ fail: true });
    const res = await route.call({ phone: route.name.includes('recurring') ? '+12025550123' : `+${PHONE}`, email: EMAIL });
    expect(res.status).not.toBe(403);
    expect(route.passed()).toBe(true);
    expect(h.reportFailure).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ area: 'customer_block', op: 'web_checkout_check', businessId: BIZ }));
    expect(JSON.stringify(h.reportFailure.mock.calls)).not.toContain(EMAIL);
  });
});

describe('phones sent as JSON numbers and local formats are still checked', () => {
  it('POST /api/checkin with a numeric phone', async () => {
    seedBlocks({ phones: [PHONE] });
    const { POST } = await import('@/app/api/checkin/route');
    await expectRefused(await POST(post('/api/checkin', { business_id: BIZ, customer_name: 'Ann', customer_phone: Number(PHONE) })));
  });
  it('POST /api/invite-optin with a numeric phone', async () => {
    seedBlocks({ phones: [PHONE] });
    const { POST } = await import('@/app/api/invite-optin/route');
    await expectRefused(await POST(post('/api/invite-optin', { eventId: 'evt-1', name: 'Ann', phone: Number(PHONE) })));
  });
  it('POST /api/bookings/public/intake with a local-format phone', async () => {
    seedBlocks({ phones: [PHONE] });
    const { POST } = await import('@/app/api/bookings/public/intake/route');
    await expectRefused(await POST(post('/api/bookings/public/intake', {
      businessSlug: 'biz', serviceId: '44444444-4444-4444-8444-444444444444', guestEmail: 'clear@example.com',
      guestPhone: '08012345678', otpToken: 'as:clear@example.com',
    })));
  });
});

describe('POST /api/bookings/public/create: phone forms, no hint, S1(b)', () => {
  const create = async (body: unknown) => (await import('@/app/api/bookings/public/create/route')).POST(post('/api/bookings/public/create', body));

  it.each(['+2348012345678', '2348012345678', '08012345678', '0801 234 5678', '00234 801 234 5678', '+234 (801) 234-5678'])(
    'refuses the blocked number typed as %s', async phone => {
      seedBlocks({ phones: [PHONE] });
      await expectRefused(await create({ ...bookingBody({}), guestPhone: phone }));
    });

  it('the refusal is the same whether the phone or the email matched', async () => {
    seedBlocks({ phones: [PHONE], emails: [EMAIL] });
    const phoneRes = await create(bookingBody({ phone: PHONE }));
    const emailRes = await create(bookingBody({ email: EMAIL }));
    expect([phoneRes.status, emailRes.status]).toEqual([403, 403]);
    expect(await phoneRes.json()).toEqual(await emailRes.json());
  });

  it('a block that lands between page load and submit refuses the submit', async () => {
    expect((await create(bookingBody({ phone: PHONE }))).status).toBe(200);
    seedBlocks({ phones: [PHONE] });
    h.writes = [];
    await expectRefused(await create(bookingBody({ phone: PHONE })));
  });

  it('marks the booking as proved with a code (service role update, first proof kept)', async () => {
    const res = await create(bookingBody({}));
    expect(res.status).toBe(200);
    const mark = h.writes.find(w => w.table === 'bookings' && w.op === 'update') as any;
    expect(mark?.values).toEqual({ email_verified_at: expect.any(String) });
    // Only when not yet marked: the first proof is kept.
    expect(mark?.is).toEqual(['email_verified_at', null]);
  });

  it('a failed mark write is logged without the address and the booking still succeeds', async () => {
    h.failUpdate = true;
    const res = await create(bookingBody({ email: 'proof@example.com' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(h.logs.some(l => l.msg === 'customer_block.email_proof_not_saved')).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('proof@example.com');
  });
});

describe('POST /api/events/purchase: S1(b)', () => {
  it('marks the ticket booking as proved with a code', async () => {
    const res = await (await import('@/app/api/events/purchase/route')).POST(post('/api/events/purchase', {
      eventSlug: 'show', quantity: 1, guestName: 'Ann', guestEmail: 'clear@example.com', otpToken: 'as:clear@example.com',
    }));
    expect(res.status).toBe(200);
    expect(h.writes.find(w => w.table === 'bookings' && w.op === 'update')?.values).toEqual({ email_verified_at: expect.any(String) });
  });
});

describe('POST /api/auth/email-otp (F13)', () => {
  const send = async (email: string) => (await import('@/app/api/auth/email-otp/route')).POST(post('/api/auth/email-otp', { email }));

  it('refuses a code for a blocked email: no challenge, no email', async () => {
    seedBlocks({ emails: [EMAIL] });
    await expectRefused(await send('ANN@Example.com'));
  });

  it('sends the code to a clear email', async () => {
    seedBlocks({ emails: [EMAIL] });
    const res = await send('clear@example.com');
    expect(res.status).toBe(200);
    expect(h.generateOtpChallenge).toHaveBeenCalledWith('email', 'clear@example.com');
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed block read still sends the code and is reported (Q10 A)', async () => {
    seedBlocks({ fail: true });
    expect((await send(EMAIL)).status).toBe(200);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.reportFailure).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ area: 'customer_block' }));
  });
});

describe('POST /api/whatsapp/flow-callback, booking completion (F11)', () => {
  const complete = async (phone: string) => {
    const raw = JSON.stringify({ action: 'complete', flow_token: 'ft', data: {
      flow_type: 'booking', business_id: BIZ, customer_phone: phone, service_id: 'svc-1', date: FUTURE, time: '10:00', customer_name: 'Ann',
    } });
    const sig = `sha256=${createHmac('sha256', 'test-secret').update(raw).digest('hex')}`;
    const { POST } = await import('@/app/api/whatsapp/flow-callback/route');
    return POST(new NextRequest('https://app.test/api/whatsapp/flow-callback', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': sig } }));
  };

  it('creates the booking for a clear number', async () => {
    await complete('2348099999999');
    expect(h.writes.some(w => w.table === 'bookings' && w.op === 'insert')).toBe(true);
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it('a blocked number gets no booking and the WhatsApp neutral reply, once per 24 hours', async () => {
    seedBlocks({ phones: [PHONE] });
    await complete(PHONE);
    await complete(PHONE);
    expect(h.writes.filter(w => !BLOCK_TABLES.has(w.table))).toEqual([]);
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE, text: "This service isn't available for this number. If you think this is a mistake, contact support@waaiio.com",
    }));
  });

  it('a blocked number gets no booking even when the channel cannot be resolved', async () => {
    seedBlocks({ phones: [PHONE] });
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const spy = vi.spyOn(ChannelResolver.prototype, 'resolveByBusinessId').mockRejectedValueOnce(new Error('no channel'));
    const res = await complete(PHONE);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(h.writes.filter(w => !BLOCK_TABLES.has(w.table))).toEqual([]);
    expect(h.sendText).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a failed block read lets the booking through and is reported', async () => {
    seedBlocks({ fail: true });
    await complete(PHONE);
    expect(h.writes.some(w => w.table === 'bookings' && w.op === 'insert')).toBe(true);
    expect(h.reportFailure).toHaveBeenCalled();
  });
});

describe('POST /api/forms/submit: every form is refused for a blocked customer (Q15 revised A)', () => {
  const submit = async () => (await import('@/app/api/forms/submit/route')).POST(post('/api/forms/submit', {
    token: 'form-token', answers: {}, customer_name: 'Ann', customer_phone: `+${PHONE}`, turnstileToken: 'ok',
  }));

  it('even when an old pending "sent" record exists for that number, nothing is written', async () => {
    seedBlocks({ phones: [PHONE] });
    h.rows.form_responses = { id: 'resp-sent' };
    await expectRefused(await submit());
  });
});

describe('Q7 C / Q14 A: replies to things the merchant created are not checked', () => {
  it.each([
    ['/api/rsvp/[token]', '@/app/api/rsvp/[token]/route'],
    ['/api/intake/[token]', '@/app/api/intake/[token]/route'],
  ])('%s never reads the block and never refuses with the block message', async (path, mod) => {
    seedBlocks({ phones: [PHONE], emails: [EMAIL] });
    const { POST } = await import(mod);
    const res: Response = await POST(post(path.replace('[token]', 'tok'), { status: 'attending', phone: PHONE, email: EMAIL, answers: {} }),
      { params: Promise.resolve({ token: 'tok' }) });
    expect(h.reads.filter(t => BLOCK_TABLES.has(t))).toEqual([]);
    const body = await res.json().catch(() => ({}));
    expect(body.code).not.toBe('customer_unavailable');
    expect(body.error).not.toBe(TEXT);
  });
});

describe('S10 / S5: money is untouched on both custody routes', () => {
  const create = async (body: unknown) => (await import('@/app/api/bookings/public/create/route')).POST(post('/api/bookings/public/create', body));
  const withDeposit = () => {
    h.quoteBookingTax.mockResolvedValue({ total: 5000, deposit: 1000, tax_snapshot: null });
    h.rpcs.book_slot_authoritative_604 = { data: { booking_id: 'bk-1', reference_code: 'REF', slot_available: true, committed_total: 5000, committed_deposit: 1000 }, error: null };
  };
  const ROUTES_BY_CUSTODY = [
    // Merchant-connected: the business's own provider account (Paystack subaccount / Stripe Connect).
    ['merchant-connected', { payment_gateway: 'paystack', metadata: { paystack_subaccount_code: 'ACCT_x' } }],
    // Waaiio-owned: no own provider; Waaiio's account holds the money.
    ['Waaiio-owned', { payment_gateway: null, metadata: {} }],
  ] as const;

  it.each(ROUTES_BY_CUSTODY)('%s: a refused checkout starts no payment, writes no payment row, and retries change nothing', async (_route, biz) => {
    h.rows.businesses = { ...(h.rows.businesses as object), ...biz };
    withDeposit();
    seedBlocks({ emails: [EMAIL] });
    const body = { ...bookingBody({ email: EMAIL }), expectedTerms: { price: 0, deposit: 0, country: 'NG', quantity: 1, tax_snapshot: null } };
    for (let i = 0; i < 3; i++) await expectRefused(await create(body));
    expect(h.initializePayment).not.toHaveBeenCalled();
  });

  it.each(ROUTES_BY_CUSTODY)('%s: a clear customer’s deposit starts exactly one payment with the same arguments as before', async (_route, biz) => {
    h.rows.businesses = { ...(h.rows.businesses as object), ...biz };
    withDeposit();
    seedBlocks({ emails: [EMAIL] }); // someone else is blocked
    const res = await create(bookingBody({ email: 'clear@example.com' }));
    expect(res.status).toBe(200);
    expect(h.initializePayment).toHaveBeenCalledTimes(1);
    expect(h.initializePayment.mock.calls[0][1]).toMatchObject({
      bookingId: 'bk-1', amount: 1000, businessId: BIZ, userEmail: 'clear@example.com',
      gatewayOverride: (biz as { payment_gateway: string | null }).payment_gateway,
    });
  });
});
