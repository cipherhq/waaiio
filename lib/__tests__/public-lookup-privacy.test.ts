/**
 * Public lookup links show only non-personal details (Owner decision 2026-11-06).
 *
 * Handler-level tests: each test imports the real route handler and stubs only
 * Supabase (service client + session lookup) and the rate limiter. The real
 * isSignedInBusinessMember() and resolveBusinessRole() run against the stub.
 *
 * Covers:
 *   - GET /api/reservations/verify/[code]
 *   - GET /api/tickets/verify/[code]
 *   - GET /api/receipts/image
 *
 * For each: anonymous caller gets no personal fields; the business owner (and an
 * active team member) gets contact details; a signed-in user from another
 * business does not; ?business_id= alone no longer adds contact details.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Hoisted state + module stubs
// ---------------------------------------------------------------------------
const { state } = vi.hoisted(() => ({
  state: {
    /** Signed-in user id for the request, or null for an anonymous caller. */
    userId: null as string | null,
    /** Row returned for the main lookup (reservation / ticket / booking / order). */
    rows: {} as Record<string, any>,
    /** businesses.owner_id per business id. */
    owners: {} as Record<string, string>,
    /** Active business_members as `${businessId}:${userId}`. */
    activeMembers: new Set<string>(),
    /** Every select() column list, per table, to check what was read. */
    selects: [] as Array<{ table: string; columns: string }>,
    /** Element tree passed to ImageResponse. */
    imageTree: null as any,
  },
}));

function makeService() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const resolve = () => {
        if (table === 'businesses') {
          const id = filters.id as string;
          if ('owner_id' in filters) {
            return state.owners[id] === filters.owner_id
              ? { data: { id }, error: null }
              : { data: null, error: null };
          }
          return { data: { name: 'Sunny Stays' }, error: null };
        }
        if (table === 'business_members') {
          const key = `${filters.business_id}:${filters.user_id}`;
          return filters.status === 'active' && state.activeMembers.has(key)
            ? { data: { role: 'staff' }, error: null }
            : { data: null, error: null };
        }
        const row = state.rows[table];
        return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
      };
      const chain: any = {
        select(cols: string) {
          state.selects.push({ table, columns: cols });
          return chain;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        single: () => Promise.resolve(resolve()),
        maybeSingle: () => {
          const r = resolve();
          return Promise.resolve(r.error ? { data: null, error: null } : r);
        },
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => makeService(),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));
// Session lookup used by isSignedInBusinessMember (lib/api-auth.ts)
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
  }),
}));
// Session lookup used by the reservation POST handler (not exercised here)
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }),
    },
  }),
}));
vi.mock('next/og', () => ({
  ImageResponse: class {
    constructor(tree: any) {
      state.imageTree = tree;
    }
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const BIZ = '11111111-1111-1111-1111-111111111111';
const OTHER_BIZ = '22222222-2222-2222-2222-222222222222';
const OWNER = 'owner-user';
const TEAM = 'team-user';
const STRANGER = 'other-business-owner';

const RESERVATION = {
  id: 'r1',
  reference_code: 'RES-ABC123',
  guest_name: 'Ada Guest',
  guest_phone: '+2348000000001',
  guest_email: 'ada@example.com',
  check_in: '2026-12-01',
  check_out: '2026-12-03',
  nights: 2,
  guests: 2,
  status: 'confirmed',
  checked_in_at: null,
  checked_in_by: null,
  checked_out_at: null,
  total_amount: 50000,
  nightly_rate: 25000,
  special_requests: 'Late arrival, ground floor please',
  business_id: BIZ,
  property: { id: 'p1', name: 'Lagoon Flat', address: '1 Lagoon Rd' },
};

const TICKET = {
  id: 't1',
  ticket_code: 'TK-ABC123',
  ticket_number: 1,
  guest_name: 'Ada Guest',
  guest_phone: '+2348000000001',
  status: 'valid',
  scanned_at: null,
  scanned_by: null,
  created_at: '2026-11-01T00:00:00Z',
  booking_id: 'b1',
  event: {
    id: 'e1', name: 'Launch Night', date: '2026-12-01', time: '18:00', venue: 'Hall A',
    image_url: null, self_checkin_enabled: false, business_id: BIZ,
    businesses: { subscription_tier: 'growth' },
  },
  booking: { quantity: 1, reference_code: 'BK-ABC123' },
};

const PERSONAL_RESERVATION_FIELDS = [
  'guest_name', 'guest_phone', 'guest_email', 'special_requests', 'total_amount', 'checked_in_by',
];

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost'));
}

beforeEach(() => {
  state.userId = null;
  state.rows = {};
  state.owners = { [BIZ]: OWNER, [OTHER_BIZ]: STRANGER };
  state.activeMembers = new Set([`${BIZ}:${TEAM}`]);
  state.selects = [];
  state.imageTree = null;
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------
describe('GET /api/reservations/verify/[code]', () => {
  async function call(url: string) {
    state.rows.reservations = RESERVATION;
    const { GET } = await import('@/app/api/reservations/verify/[code]/route');
    const res = await GET(req(url), { params: Promise.resolve({ code: 'res-abc123' }) });
    return { status: res.status, body: await res.json() };
  }

  it('anonymous caller gets only non-personal details', async () => {
    const { status, body } = await call('/api/reservations/verify/res-abc123');
    expect(status).toBe(200);
    for (const f of PERSONAL_RESERVATION_FIELDS) expect(body.reservation).not.toHaveProperty(f);
    expect(JSON.stringify(body)).not.toContain('Ada Guest');
    expect(JSON.stringify(body)).not.toContain('+2348000000001');
    // Existing public links keep working
    expect(body.valid).toBe(true);
    expect(body.reservation).toMatchObject({
      reference_code: 'RES-ABC123',
      status: 'confirmed',
      check_in: '2026-12-01',
      check_out: '2026-12-03',
      property_name: 'Lagoon Flat',
      property_id: 'p1',
      business_name: 'Sunny Stays',
    });
  });

  it('?business_id= alone no longer adds guest details', async () => {
    const { status, body } = await call(`/api/reservations/verify/res-abc123?business_id=${BIZ}`);
    expect(status).toBe(200);
    for (const f of PERSONAL_RESERVATION_FIELDS) expect(body.reservation).not.toHaveProperty(f);
  });

  it('signed-in owner of the business gets contact details', async () => {
    state.userId = OWNER;
    const { body } = await call(`/api/reservations/verify/res-abc123?business_id=${BIZ}`);
    expect(body.reservation).toMatchObject({
      guest_name: 'Ada Guest',
      guest_phone: '+2348000000001',
      guest_email: 'ada@example.com',
      special_requests: 'Late arrival, ground floor please',
      total_amount: 50000,
    });
  });

  it('signed-in owner gets contact details even without ?business_id=', async () => {
    state.userId = OWNER;
    const { body } = await call('/api/reservations/verify/res-abc123');
    expect(body.reservation.guest_phone).toBe('+2348000000001');
  });

  it('active team member of the business gets contact details', async () => {
    state.userId = TEAM;
    const { body } = await call(`/api/reservations/verify/res-abc123?business_id=${BIZ}`);
    expect(body.reservation.guest_email).toBe('ada@example.com');
  });

  it('signed-in user of another business does not get contact details', async () => {
    state.userId = STRANGER;
    const { body } = await call(`/api/reservations/verify/res-abc123?business_id=${BIZ}`);
    for (const f of PERSONAL_RESERVATION_FIELDS) expect(body.reservation).not.toHaveProperty(f);
  });

  it('mismatched ?business_id= still returns 403 (unchanged)', async () => {
    const { status } = await call(`/api/reservations/verify/res-abc123?business_id=${OTHER_BIZ}`);
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
describe('GET /api/tickets/verify/[code]', () => {
  async function call(url: string) {
    state.rows.event_tickets = TICKET;
    const { GET } = await import('@/app/api/tickets/verify/[code]/route');
    const res = await GET(req(url), { params: Promise.resolve({ code: 'tk-abc123' }) });
    return { status: res.status, body: await res.json() };
  }

  it('anonymous caller does not get the guest phone', async () => {
    const { status, body } = await call('/api/tickets/verify/tk-abc123');
    expect(status).toBe(200);
    expect(body.ticket.guest_phone).toBeUndefined();
    expect(body.valid).toBe(true);
    expect(body.ticket.event_name).toBe('Launch Night');
  });

  it('?business_id= alone no longer unmasks the guest phone', async () => {
    const { status, body } = await call(`/api/tickets/verify/tk-abc123?business_id=${BIZ}`);
    expect(status).toBe(200);
    expect(body.ticket.guest_phone).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('+2348000000001');
  });

  it('signed-in owner of the event business gets the guest phone', async () => {
    state.userId = OWNER;
    const { body } = await call(`/api/tickets/verify/tk-abc123?business_id=${BIZ}`);
    expect(body.ticket.guest_phone).toBe('+2348000000001');
  });

  it('active team member of the event business gets the guest phone', async () => {
    state.userId = TEAM;
    const { body } = await call(`/api/tickets/verify/tk-abc123?business_id=${BIZ}`);
    expect(body.ticket.guest_phone).toBe('+2348000000001');
  });

  it('signed-in user of another business does not get the guest phone', async () => {
    state.userId = STRANGER;
    const { body } = await call(`/api/tickets/verify/tk-abc123?business_id=${BIZ}`);
    expect(body.ticket.guest_phone).toBeUndefined();
  });

  it('mismatched ?business_id= still returns 403 (unchanged)', async () => {
    const { status } = await call(`/api/tickets/verify/tk-abc123?business_id=${OTHER_BIZ}`);
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Receipt image
// ---------------------------------------------------------------------------
function treeText(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(' ');
  if (node.props) return treeText(node.props.children);
  return '';
}

describe('GET /api/receipts/image', () => {
  it('booking receipt shows status, date, business and service, but no customer name or amount', async () => {
    state.rows.bookings = {
      reference_code: 'BK-ABC123', date: '2026-12-01', total_amount: 75000, status: 'confirmed',
      guest_name: 'Ada Guest', quantity: 2,
      services: { name: 'Haircut' },
      businesses: { name: 'Sunny Salon', logo_url: null, country_code: 'NG', subscription_tier: 'free' },
    };
    const { GET } = await import('@/app/api/receipts/image/route');
    await GET(req('/api/receipts/image?ref=BK-ABC123'));
    const text = treeText(state.imageTree);

    expect(text).toContain('Booking Receipt');
    expect(text).toContain('Sunny Salon');
    expect(text).toContain('Haircut');
    expect(text).toContain('Confirmed');
    expect(text).toContain('BK-ABC123');
    expect(text).toContain('2026');
    expect(text).not.toContain('Ada Guest');
    expect(text).not.toContain('Customer');
    expect(text).not.toContain('Amount Paid');
    expect(text).not.toMatch(/75,?000/);

    const bookingSelect = state.selects.find(s => s.table === 'bookings')!.columns;
    expect(bookingSelect).not.toContain('guest_name');
    expect(bookingSelect).not.toContain('total_amount');
  });

  it('order receipt does not read or show the customer profile or amount', async () => {
    state.rows.orders = {
      reference_code: 'OR-ABC123', total_amount: 12000, status: 'delivered', created_at: '2026-11-01T10:00:00Z',
      businesses: { name: 'Sunny Shop', logo_url: null, country_code: 'NG', subscription_tier: 'free' },
      user: { first_name: 'Ada', last_name: 'Guest' },
    };
    const { GET } = await import('@/app/api/receipts/image/route');
    await GET(req('/api/receipts/image?ref=OR-ABC123'));
    const text = treeText(state.imageTree);

    expect(text).toContain('Order Receipt');
    expect(text).toContain('Sunny Shop');
    expect(text).toContain('Delivered');
    expect(text).not.toContain('Ada');
    expect(text).not.toContain('Amount Paid');
    expect(text).not.toMatch(/12,?000/);

    const orderSelect = state.selects.find(s => s.table === 'orders')!.columns;
    expect(orderSelect).not.toContain('profiles');
    expect(orderSelect).not.toContain('total_amount');
  });

  it('unknown ref still returns 404 (unchanged)', async () => {
    const { GET } = await import('@/app/api/receipts/image/route');
    const res = await GET(req('/api/receipts/image?ref=NOPE'));
    expect((res as Response).status).toBe(404);
  });
});
