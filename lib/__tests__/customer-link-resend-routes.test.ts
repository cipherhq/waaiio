/**
 * Resend ticket / confirmation link (Owner decision 2026-11-18).
 *
 * Handler-level tests: import the real merchant and admin route handlers and
 * the real lib/customer-links.ts (including the in-memory per-record rate
 * limit). Stubbed: Supabase (service client + session lookup), the email
 * sender, the platform-admin check and the admin audit writer. No email is
 * sent and no database is touched.
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

describe('POST /api/customer-links/resend (merchant)', () => {
  it('anonymous caller gets 401 and nothing is sent', async () => {
    const id = addTicket();
    const { status } = await merchant({ kind: 'ticket', id });
    expect(status).toBe(401);
    expect(state.emails).toHaveLength(0);
  });

  it('rejects an unknown kind or a non-UUID id', async () => {
    state.userId = OWNER;
    expect((await merchant({ kind: 'invoice', id: addTicket() })).status).toBe(400);
    expect((await merchant({ kind: 'ticket', id: 'TK-ABC123' })).status).toBe(400);
    expect(state.emails).toHaveLength(0);
  });

  it("another business's owner gets 404 for both check and send, and sees no link", async () => {
    const id = addTicket();
    state.userId = OTHER_OWNER;
    const check = await merchant({ kind: 'ticket', id, check: true });
    expect(check.status).toBe(404);
    expect(JSON.stringify(check.body)).not.toContain('TK-ABC123');
    expect((await merchant({ kind: 'ticket', id })).status).toBe(404);
    expect(state.emails).toHaveLength(0);
  });

  it('a team member who is not the owner gets 404 (owner only)', async () => {
    const id = addTicket();
    state.userId = TEAM;
    expect((await merchant({ kind: 'ticket', id })).status).toBe(404);
    expect(state.emails).toHaveLength(0);
  });

  it('missing record is 404', async () => {
    state.userId = OWNER;
    expect((await merchant({ kind: 'ticket', id: uuid() })).status).toBe(404);
  });

  it('check returns the ticket link and a masked email, and sends nothing', async () => {
    const id = addTicket();
    state.userId = OWNER;
    const { status, body } = await merchant({ kind: 'ticket', id, check: true });
    expect(status).toBe(200);
    expect(body).toEqual({
      link: 'https://app.example.test/tickets/TK-ABC123',
      canEmail: true, reason: null, emailHint: 'a•••@example.test',
    });
    expect(state.emails).toHaveLength(0);
  });

  it('owner sends the ticket link to the booking email, once, with no PDF', async () => {
    const id = addTicket();
    state.userId = OWNER;
    const { status, body } = await merchant({ kind: 'ticket', id });
    expect(status).toBe(200);
    expect(body).toEqual({ sent: true, sentTo: 'a•••@example.test' });
    expect(state.emails).toHaveLength(1);
    const email = state.emails[0];
    expect(email.to).toBe('ada@example.test');
    expect(email.noRetry).toBe(true);
    expect(email.subject).toBe('Your ticket from Sunny Events');
    expect(email.html).toContain('https://app.example.test/tickets/TK-ABC123');
    expect(email.html).toContain('Launch Night');
    expect(email).not.toHaveProperty('attachments');
  });

  it('falls back to the customer profile email when the booking has none', async () => {
    const id = addTicket({ booking: { guest_email: null, user_id: 'cust-1' } });
    state.userId = OWNER;
    expect((await merchant({ kind: 'ticket', id })).status).toBe(200);
    expect(state.emails[0].to).toBe('profile@example.test');
  });

  it('no customer email: check says why, send is 409 and nothing is sent', async () => {
    const id = addTicket({ booking: { guest_email: null, user_id: 'cust-2' } });
    state.userId = OWNER;
    const check = await merchant({ kind: 'ticket', id, check: true });
    expect(check.body).toMatchObject({ canEmail: false, reason: 'No customer email on file.', emailHint: null });
    expect(check.body.link).toBe('https://app.example.test/tickets/TK-ABC123');
    const send = await merchant({ kind: 'ticket', id });
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('No customer email on file.');
    expect(state.emails).toHaveLength(0);
  });

  it('cancelled ticket is not emailed', async () => {
    const id = addTicket({ status: 'cancelled' });
    state.userId = OWNER;
    const send = await merchant({ kind: 'ticket', id });
    expect(send.status).toBe(409);
    expect(send.body.error).toBe('This ticket is cancelled.');
    expect(state.emails).toHaveLength(0);
  });

  it('rate limit: 3 emails per record per hour, then 429; another record is unaffected', async () => {
    const id = addTicket();
    const other = addTicket({ ticket_code: 'TK-ZZZ999' });
    state.userId = OWNER;
    for (let i = 0; i < 3; i++) expect((await merchant({ kind: 'ticket', id })).status).toBe(200);
    const fourth = await merchant({ kind: 'ticket', id });
    expect(fourth.status).toBe(429);
    expect(state.emails).toHaveLength(3);
    expect((await merchant({ kind: 'ticket', id: other })).status).toBe(200);
    // check never counts against the limit
    expect((await merchant({ kind: 'ticket', id, check: true })).status).toBe(200);
  });

  it('provider failure is 502', async () => {
    const id = addTicket();
    state.userId = OWNER;
    state.emailOk = false;
    const { status } = await merchant({ kind: 'ticket', id });
    expect(status).toBe(502);
  });

  it('booking: links to the existing receipt and uses the guest email', async () => {
    const id = uuid();
    state.tables.bookings.push({ id, reference_code: 'BK-REF1', business_id: BIZ, status: 'confirmed', guest_email: 'bo@example.test', user_id: null, services: { name: 'Haircut' } });
    state.userId = OWNER;
    const check = await merchant({ kind: 'booking', id, check: true });
    expect(check.body.link).toBe('https://app.example.test/api/receipts/image?ref=BK-REF1');
    expect((await merchant({ kind: 'booking', id })).status).toBe(200);
    expect(state.emails[0].to).toBe('bo@example.test');
    expect(state.emails[0].subject).toBe('Your booking confirmation from Sunny Events');
  });

  it('order: links to the existing receipt and uses the customer profile email', async () => {
    const id = uuid();
    state.tables.orders.push({ id, reference_code: 'BW-O1234', business_id: BIZ, status: 'confirmed', user_id: 'cust-1' });
    state.userId = OWNER;
    const check = await merchant({ kind: 'order', id, check: true });
    expect(check.body.link).toBe('https://app.example.test/api/receipts/image?ref=BW-O1234');
    expect((await merchant({ kind: 'order', id })).status).toBe(200);
    expect(state.emails[0].to).toBe('profile@example.test');
  });

  it("another business's order is 404", async () => {
    const id = uuid();
    state.tables.orders.push({ id, reference_code: 'BW-O9999', business_id: OTHER_BIZ, status: 'confirmed', user_id: 'cust-1' });
    state.userId = OWNER;
    expect((await merchant({ kind: 'order', id })).status).toBe(404);
    expect(state.emails).toHaveLength(0);
  });
});

describe('POST /api/admin/customer-links/resend (admin)', () => {
  it('non-admin gets 403 and nothing is sent or audited', async () => {
    const id = addTicket();
    const { status } = await admin({ kind: 'ticket', id });
    expect(status).toBe(403);
    expect(state.adminRoles).toEqual(['admin', 'support', 'operations']);
    expect(state.emails).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('check returns the link for any business, without sending or auditing', async () => {
    const id = addTicket({ business_id: OTHER_BIZ });
    state.admin = { userId: 'admin-1' };
    const { status, body } = await admin({ kind: 'ticket', id, check: true });
    expect(status).toBe(200);
    expect(body.link).toBe('https://app.example.test/tickets/TK-ABC123');
    expect(state.emails).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('send emails the link and writes an audit row without the full address', async () => {
    const id = addTicket();
    state.admin = { userId: 'admin-1' };
    const { status, body } = await admin({ kind: 'ticket', id });
    expect(status).toBe(200);
    expect(body).toEqual({ sent: true, sentTo: 'a•••@example.test', auditRecorded: true });
    expect(state.emails).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      actorId: 'admin-1', action: 'resend_customer_link', entityType: 'ticket', entityId: id,
      details: { business_id: BIZ, code: 'TK-ABC123', sent_to: 'a•••@example.test' },
    });
    expect(JSON.stringify(state.audits[0])).not.toContain('ada@example.test');
  });

  it('no customer email is 409, not sent, not audited', async () => {
    const id = addTicket({ booking: { guest_email: null, user_id: null } });
    state.admin = { userId: 'admin-1' };
    const { status } = await admin({ kind: 'ticket', id });
    expect(status).toBe(409);
    expect(state.emails).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it('the per-record rate limit applies to admin sends too: 4th email in the hour is 429', async () => {
    const id = addTicket();
    state.admin = { userId: 'admin-1' };
    for (let i = 0; i < 3; i++) expect((await admin({ kind: 'ticket', id })).status).toBe(200);
    expect((await admin({ kind: 'ticket', id })).status).toBe(429);
    expect(state.emails).toHaveLength(3);
    expect(state.audits).toHaveLength(3);
  });

  it('invalid body is 400', async () => {
    state.admin = { userId: 'admin-1' };
    expect((await admin({ kind: 'ticket', id: 'nope' })).status).toBe(400);
  });
});
