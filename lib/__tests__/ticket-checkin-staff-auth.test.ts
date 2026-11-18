/**
 * Ticket check-in needs business staff (Owner decision 2026-11-18).
 *
 * Handler-level tests: imports the real POST /api/tickets/verify/[code] handler
 * and stubs only Supabase (service client + session lookup) and the rate
 * limiter. The real isSignedInBusinessMember() and resolveBusinessRole() run
 * against the stub.
 *
 * Covers: anonymous caller refused (with or without a business_id in the body),
 * a signed-in user of another business refused, the owner and an active team
 * member succeed, an already-used ticket is still refused, and a lost race
 * (another scanner checked it in first) is still reported as a duplicate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { state } = vi.hoisted(() => ({
  state: {
    /** Signed-in user id for the request, or null for an anonymous caller. */
    userId: null as string | null,
    /** The ticket row the lookup returns. */
    ticket: null as any,
    /** What the conditional UPDATE returns (null = race lost). */
    updateResult: { data: { id: 't1' }, error: null } as { data: any; error: any },
    /** Row the race-loss re-read returns. */
    reRead: null as any,
    /** businesses.owner_id per business id. */
    owners: {} as Record<string, string>,
    /** Active business_members as `${businessId}:${userId}`. */
    activeMembers: new Set<string>(),
    /** Every update() payload sent to event_tickets. */
    updates: [] as any[],
  },
}));

function makeService() {
  let ticketReads = 0;
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const resolve = () => {
        if (table === 'businesses') {
          const id = filters.id as string;
          return state.owners[id] === filters.owner_id
            ? { data: { id }, error: null }
            : { data: null, error: null };
        }
        if (table === 'business_members') {
          const key = `${filters.business_id}:${filters.user_id}`;
          return filters.status === 'active' && state.activeMembers.has(key)
            ? { data: { role: 'staff' }, error: null }
            : { data: null, error: null };
        }
        ticketReads++;
        if (ticketReads === 1) {
          return state.ticket ? { data: state.ticket, error: null } : { data: null, error: { message: 'not found' } };
        }
        return { data: state.reRead, error: state.reRead ? null : { message: 'not found' } };
      };
      const chain: any = {
        select: () => chain,
        eq(col: string, val: unknown) {
          filters[col] = val;
          return chain;
        },
        single: () => Promise.resolve(resolve()),
        maybeSingle: () => Promise.resolve(resolve()),
        update(payload: unknown) {
          state.updates.push(payload);
          const upd: any = {
            eq: () => upd,
            select: () => upd,
            maybeSingle: () => Promise.resolve(state.updateResult),
          };
          return upd;
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

const BIZ = '11111111-1111-1111-1111-111111111111';
const OTHER_BIZ = '22222222-2222-2222-2222-222222222222';
const OWNER = 'owner-user';
const TEAM = 'team-user';
const STRANGER = 'other-business-owner';

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    status: 'valid',
    scanned_at: null,
    scanned_by: null,
    guest_name: 'Ada Guest',
    // date null skips the event-day window so the auth rule is what is tested
    event: { date: null, time: null, business_id: BIZ },
    ...overrides,
  };
}

async function checkIn(body?: Record<string, unknown>) {
  const { POST } = await import('@/app/api/tickets/verify/[code]/route');
  const req = new NextRequest(new URL('/api/tickets/verify/TK-ABC123', 'http://localhost'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await POST(req, { params: Promise.resolve({ code: 'tk-abc123' }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  state.userId = null;
  state.ticket = ticket();
  state.updateResult = { data: { id: 't1' }, error: null };
  state.reRead = null;
  state.owners = { [BIZ]: OWNER, [OTHER_BIZ]: STRANGER };
  state.activeMembers = new Set([`${BIZ}:${TEAM}`]);
  state.updates = [];
});

describe('POST /api/tickets/verify/[code]: business staff only', () => {
  it('anonymous caller with no body is refused and nothing is written', async () => {
    const { status, body } = await checkIn();
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it('anonymous caller with the right business_id in the body is refused', async () => {
    const { status } = await checkIn({ business_id: BIZ, scanned_by: 'Door' });
    expect(status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it('signed-in user of another business is refused', async () => {
    state.userId = STRANGER;
    const { status } = await checkIn({ business_id: BIZ });
    expect(status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it('a removed (not active) team member is refused', async () => {
    state.userId = 'former-staff';
    const { status } = await checkIn({ business_id: BIZ });
    expect(status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it('the business owner checks the ticket in', async () => {
    state.userId = OWNER;
    const { status, body } = await checkIn({ business_id: BIZ, scanned_by: 'Sunny Events' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ status: 'used', scanned_by: 'Sunny Events' });
  });

  it('an active team member checks the ticket in', async () => {
    state.userId = TEAM;
    const { status } = await checkIn({ business_id: BIZ });
    expect(status).toBe(200);
    expect(state.updates).toHaveLength(1);
  });

  it('a business_id that is not the event business is still refused', async () => {
    state.userId = STRANGER;
    const { status, body } = await checkIn({ business_id: OTHER_BIZ });
    expect(status).toBe(403);
    expect(body.error).toContain('not for your event');
    expect(state.updates).toHaveLength(0);
  });

  it('own staff scanning an already-used ticket gets 409 and nothing is written', async () => {
    state.userId = OWNER;
    state.ticket = ticket({ status: 'used', scanned_at: '2026-12-01T18:00:00Z', scanned_by: 'Door' });
    const { status, body } = await checkIn({ business_id: BIZ });
    expect(status).toBe(409);
    expect(body.scanned_by).toBe('Door');
    expect(state.updates).toHaveLength(0);
  });

  it('own staff losing a race to another scanner gets 409 duplicate', async () => {
    state.userId = TEAM;
    state.updateResult = { data: null, error: null };
    state.reRead = { status: 'used', scanned_at: '2026-12-01T18:00:00Z', scanned_by: 'Gate 2' };
    const { status, body } = await checkIn({ business_id: BIZ });
    expect(status).toBe(409);
    expect(body.scanned_by).toBe('Gate 2');
  });

  it('unknown ticket is 404', async () => {
    state.ticket = null;
    const { status } = await checkIn({ business_id: BIZ });
    expect(status).toBe(404);
  });
});
