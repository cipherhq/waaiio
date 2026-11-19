/**
 * Property stay confirmation link (follow-up to #1121; Owner decision 2026-11-18).
 *
 * Handler-level tests with the real route handlers and the real
 * lib/customer-links.ts (including the in-memory rate limits):
 *   - GET /api/stays/[code]: the customer page's data, opened only by the
 *     secret confirmation code (M552), read-only, no guest personal data;
 *   - POST /api/customer-links/resend and /api/admin/customer-links/resend
 *     with kind 'stay': link, email, ownership, no-email, audit.
 * Stubbed: Supabase, the email sender, the platform-admin check and the
 * admin audit writer. No email is sent and no database is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { state } = vi.hoisted(() => ({
  state: {
    userId: null as string | null,
    tables: {} as Record<string, Array<Record<string, any>>>,
    emails: [] as Array<{ to: string; subject: string; html: string; noRetry?: boolean }>,
    emailOk: true,
    admin: null as { userId: string } | null,
    adminRoles: null as unknown,
    audits: [] as Array<Record<string, any>>,
  },
}));

function makeService() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        maybeSingle: () => {
          const row = (state.tables[table] || []).find(r => Object.entries(filters).every(([k, v]) => r[k] === v));
          return Promise.resolve({ data: row ?? null, error: null });
        },
      };
      chain.single = chain.maybeSingle;
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => makeService() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId, email: 'x@example.test' } : null } }) },
  }),
}));
vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn(async (opts: { to: string; subject: string; html: string; noRetry?: boolean }) => {
    state.emails.push(opts);
    return state.emailOk ? { success: true, id: 'e1' } : { success: false, error: 'provider down' };
  }),
}));
vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async (_req: unknown, opts: { requiredRole: unknown }) => {
    state.adminRoles = opts.requiredRole;
    return state.admin;
  }),
}));
vi.mock('@/lib/admin-audit', () => ({
  logAdminAudit: vi.fn(async (entry: Record<string, any>) => {
    state.audits.push(entry);
    return {};
  }),
}));

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-user';
const OTHER_OWNER = 'other-owner';
const TEAM = 'team-user';
let seq = 0;
/** Fresh UUIDs per test so the per-record rate limit never leaks between tests. */
function uuid(): string {
  seq++;
  return `33333333-3333-4333-8333-${String(seq).padStart(12, '0')}`;
}

function seed() {
  state.tables = {
    businesses: [
      { id: BIZ, owner_id: OWNER, name: 'Sunny Events', subscription_tier: 'free' },
      { id: OTHER_BIZ, owner_id: OTHER_OWNER, name: 'Other Biz', subscription_tier: 'free' },
    ],
    business_members: [{ business_id: BIZ, user_id: TEAM, status: 'active', role: 'staff' }],
    profiles: [{ id: 'cust-1', email: 'profile@example.test' }, { id: 'cust-2', email: null }],
    event_tickets: [],
    bookings: [],
    orders: [],
    reservations: [],
  };
}

function addTicket(overrides: Record<string, any> = {}) {
  const id = uuid();
  state.tables.event_tickets.push({
    id, ticket_code: 'TK-ABC123', business_id: BIZ, status: 'valid',
    event: { name: 'Launch Night' },
    booking: { guest_email: 'ada@example.test', user_id: 'cust-1' },
    ...overrides,
  });
  return id;
}

async function merchant(body: unknown) {
  const { POST } = await import('@/app/api/customer-links/resend/route');
  const req = new NextRequest(new URL('/api/customer-links/resend', 'http://localhost'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

async function admin(body: unknown) {
  const { POST } = await import('@/app/api/admin/customer-links/resend/route');
  const req = new NextRequest(new URL('/api/admin/customer-links/resend', 'http://localhost'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://localhost:8083' }, body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  seed();
  state.userId = null;
  state.emails = [];
  state.emailOk = true;
  state.admin = null;
  state.adminRoles = null;
  state.audits = [];
});

const CODE = '0123456789abcdef0123456789abcdef';
const OTHER_CODE = 'fedcba9876543210fedcba9876543210';

function addStay(overrides: Record<string, any> = {}) {
  const id = uuid();
  state.tables.reservations.push({
    id, reference_code: 'WA-RS-1234', confirmation_code: CODE, business_id: BIZ, status: 'confirmed',
    check_in: '2026-12-01', check_out: '2026-12-04', nights: 3, guests: 2,
    nightly_rate: 25000, total_amount: 75000, deposit_amount: 10000,
    guest_name: 'Sade Stayer', guest_phone: '+2348012345678', guest_email: 'sade@example.test',
    special_requests: 'Late arrival, door code please', user_id: 'cust-1', notes: 'VIP',
    property: { name: 'Lagoon Flat', address: '12 Marina Road' },
    business: { name: 'Sunny Stays', country_code: 'NG', subscription_tier: 'free' },
    ...overrides,
  });
  return id;
}

let ipSeq = 0;
async function page(code: string, ip = `10.0.0.${++ipSeq}`) {
  const { GET } = await import('@/app/api/stays/[code]/route');
  const req = new NextRequest(new URL(`/api/stays/${code}`, 'http://localhost'), { headers: { 'x-forwarded-for': ip } });
  const res = await GET(req, { params: Promise.resolve({ code }) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

describe('GET /api/stays/[code] (customer page data)', () => {
  it('opens by the secret confirmation code with the WhatsApp confirmation details', async () => {
    addStay();
    const { status, body, headers } = await page(CODE);
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(body.stay).toMatchObject({
      reference_code: 'WA-RS-1234', business_name: 'Sunny Stays', property_name: 'Lagoon Flat',
      property_address: '12 Marina Road', check_in: '2026-12-01', check_out: '2026-12-04',
      nights: 3, guests: 2, status: 'confirmed', subscription_tier: 'free',
    });
    expect(body.stay.total).toContain('75,000');
    expect(body.stay.nightly_rate).toContain('25,000');
    expect(body.stay.deposit).toContain('10,000');
  });

  it('never returns the guest name, phone, email, special requests, notes or ids', async () => {
    addStay();
    const text = JSON.stringify((await page(CODE)).body);
    for (const secret of ['Sade Stayer', '+2348012345678', 'sade@example.test', 'door code', 'VIP', BIZ, 'cust-1', CODE]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys((await page(CODE)).body.stay).sort()).toEqual([
      'business_name', 'check_in', 'check_out', 'deposit', 'guests', 'nightly_rate', 'nights',
      'property_address', 'property_name', 'reference_code', 'status', 'subscription_tier', 'total',
    ]);
  });

  it('upper-case code still opens (links are case-insensitive)', async () => {
    addStay();
    expect((await page(CODE.toUpperCase())).status).toBe(200);
  });

  it('the short reference code does not open the page', async () => {
    addStay();
    const res = await page('WA-RS-1234');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Lagoon Flat');
  });

  it('an unknown or malformed code is 404 with no details', async () => {
    addStay();
    for (const code of [OTHER_CODE, CODE.slice(0, 31), `${CODE}0`, 'not-a-code']) {
      const res = await page(code);
      expect(res.status).toBe(404);
      expect(res.body.stay).toBeUndefined();
    }
  });

  it('no deposit shows no deposit line', async () => {
    addStay({ deposit_amount: 0 });
    expect((await page(CODE)).body.stay.deposit).toBeNull();
  });

  it('is rate-limited per IP: 30 a minute, then 429', async () => {
    addStay();
    for (let i = 0; i < 30; i++) expect((await page(CODE, '10.9.9.9')).status).toBe(200);
    expect((await page(CODE, '10.9.9.9')).status).toBe(429);
    expect((await page(CODE, '10.9.9.10')).status).toBe(200);
  });
});

describe('resend a stay confirmation link (merchant)', () => {
  it('check returns the /stays link with the secret code, not the reference code', async () => {
    const id = addStay();
    state.userId = OWNER;
    const { status, body } = await merchant({ kind: 'stay', id, check: true });
    expect(status).toBe(200);
    expect(body).toEqual({
      link: `https://app.example.test/stays/${CODE}`,
      canEmail: true, reason: null, emailHint: 's•••@example.test',
    });
    expect(state.emails).toHaveLength(0);
  });

  it('owner emails the link to the guest email, once, with no PDF', async () => {
    const id = addStay();
    state.userId = OWNER;
    const { status, body } = await merchant({ kind: 'stay', id });
    expect(status).toBe(200);
    expect(body).toEqual({ sent: true, sentTo: 's•••@example.test' });
    const email = state.emails[0];
    expect(email.to).toBe('sade@example.test');
    expect(email.noRetry).toBe(true);
    expect(email.subject).toBe('Your stay confirmation from Sunny Events');
    expect(email.html).toContain(`https://app.example.test/stays/${CODE}`);
    expect(email.html).toContain('Lagoon Flat');
    expect(email.html).toContain('WA-RS-1234');
    expect(email).not.toHaveProperty('attachments');
  });

  it("another business's owner gets 404 for check and send, and sees no link", async () => {
    const id = addStay();
    state.userId = OTHER_OWNER;
    const check = await merchant({ kind: 'stay', id, check: true });
    expect(check.status).toBe(404);
    expect(JSON.stringify(check.body)).not.toContain(CODE);
    expect((await merchant({ kind: 'stay', id })).status).toBe(404);
    expect(state.emails).toHaveLength(0);
  });

  it('a team member who is not the owner gets 404; anonymous gets 401', async () => {
    const id = addStay();
    expect((await merchant({ kind: 'stay', id })).status).toBe(401);
    state.userId = TEAM;
    expect((await merchant({ kind: 'stay', id })).status).toBe(404);
    expect(state.emails).toHaveLength(0);
  });

  it('falls back to the customer profile email', async () => {
    const id = addStay({ guest_email: null });
    state.userId = OWNER;
    expect((await merchant({ kind: 'stay', id })).status).toBe(200);
    expect(state.emails[0].to).toBe('profile@example.test');
  });

  it('no customer email: check gives the reason and still the link; send is 409', async () => {
    const id = addStay({ guest_email: null, user_id: 'cust-2' });
    state.userId = OWNER;
    const check = await merchant({ kind: 'stay', id, check: true });
    expect(check.body).toEqual({
      link: `https://app.example.test/stays/${CODE}`, canEmail: false, reason: 'No customer email on file.', emailHint: null,
    });
    const send = await merchant({ kind: 'stay', id });
    expect(send.status).toBe(409);
    expect(state.emails).toHaveLength(0);
  });

  it('a cancelled stay is not emailed', async () => {
    const id = addStay({ status: 'cancelled' });
    state.userId = OWNER;
    const send = await merchant({ kind: 'stay', id });
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('This stay is cancelled.');
    expect(state.emails).toHaveLength(0);
  });

  it('a stay without a confirmation code is 404 (never links by reference code)', async () => {
    const id = addStay({ confirmation_code: null });
    state.userId = OWNER;
    expect((await merchant({ kind: 'stay', id, check: true })).status).toBe(404);
  });

  it('rate limit: 3 emails per stay per hour, shared with admin', async () => {
    const id = addStay();
    state.userId = OWNER;
    for (let i = 0; i < 2; i++) expect((await merchant({ kind: 'stay', id })).status).toBe(200);
    state.admin = { userId: 'admin-1' };
    expect((await admin({ kind: 'stay', id })).status).toBe(200);
    expect((await merchant({ kind: 'stay', id })).status).toBe(429);
    expect((await admin({ kind: 'stay', id })).status).toBe(429);
    expect(state.emails).toHaveLength(3);
  });
});

describe('resend a stay confirmation link (admin)', () => {
  it('non-admin gets 403', async () => {
    const id = addStay();
    expect((await admin({ kind: 'stay', id })).status).toBe(403);
    expect(state.adminRoles).toEqual(['admin', 'support', 'operations']);
    expect(state.emails).toHaveLength(0);
  });

  it('send emails the link and writes one audit row with the masked address', async () => {
    const id = addStay({ business_id: OTHER_BIZ });
    state.admin = { userId: 'admin-1' };
    const { status, body } = await admin({ kind: 'stay', id });
    expect(status).toBe(200);
    expect(body).toEqual({ sent: true, sentTo: 's•••@example.test', auditRecorded: true });
    expect(state.audits).toEqual([expect.objectContaining({
      actorId: 'admin-1', action: 'resend_customer_link', entityType: 'stay', entityId: id,
      details: { business_id: OTHER_BIZ, code: 'WA-RS-1234', sent_to: 's•••@example.test' },
    })]);
    expect(JSON.stringify(state.audits)).not.toContain('sade@example.test');
  });

  it('no customer email is 409, not sent, not audited', async () => {
    const id = addStay({ guest_email: null, user_id: null });
    state.admin = { userId: 'admin-1' };
    expect((await admin({ kind: 'stay', id })).status).toBe(409);
    expect(state.emails).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});
