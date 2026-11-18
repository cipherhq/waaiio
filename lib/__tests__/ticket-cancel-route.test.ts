/**
 * POST /api/tickets/[id]/cancel (Owner decision 2026-11-18): the merchant
 * "Cancel Ticket" button cancels through a server route that only the
 * ticket business's owner or an active team member may use. Status change
 * only: no refund, payment, booking or seat-count write.
 *
 * Real handler, real authenticateRequest and resolveBusinessRole; stubbed
 * Supabase (service client + session lookup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { state } = vi.hoisted(() => ({
  state: {
    userId: null as string | null,
    ticket: null as Record<string, any> | null,
    owners: {} as Record<string, string>,
    activeMembers: new Set<string>(),
    writes: [] as Array<{ table: string; payload: unknown; filters: Record<string, unknown> }>,
  },
}));

function makeService() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let payload: Record<string, unknown> | null = null;
      const resolve = () => {
        if (table === 'businesses') {
          return { data: state.owners[filters.id as string] === filters.owner_id ? { id: filters.id } : null, error: null };
        }
        if (table === 'business_members') {
          const ok = filters.status === 'active' && state.activeMembers.has(`${filters.business_id}:${filters.user_id}`);
          return { data: ok ? { role: 'staff' } : null, error: null };
        }
        if (payload) {
          state.writes.push({ table, payload, filters: { ...filters } });
          const t = state.ticket;
          if (t && t.id === filters.id && t.business_id === filters.business_id && t.status === filters.status) {
            Object.assign(t, payload);
            return { data: { id: t.id, status: t.status }, error: null };
          }
          return { data: null, error: null };
        }
        const t = state.ticket;
        return { data: t && t.id === filters.id ? { ...t } : null, error: null };
      };
      const chain: any = {
        select: () => chain,
        update: (p: Record<string, unknown>) => { payload = p; return chain; },
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        maybeSingle: () => Promise.resolve(resolve()),
        single: () => Promise.resolve(resolve()),
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => makeService() }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.userId ? { id: state.userId } : null } }) },
  }),
}));

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

async function cancel(id = ID) {
  const { POST } = await import('@/app/api/tickets/[id]/cancel/route');
  const req = new NextRequest(new URL(`/api/tickets/${id}/cancel`, 'http://localhost'), { method: 'POST' });
  const res = await POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  state.userId = null;
  state.ticket = { id: ID, business_id: BIZ, status: 'valid' };
  state.owners = { [BIZ]: 'owner', [OTHER_BIZ]: 'other-owner' };
  state.activeMembers = new Set([`${BIZ}:team`]);
  state.writes = [];
});

describe('POST /api/tickets/[id]/cancel', () => {
  it('anonymous caller gets 401 and nothing is written', async () => {
    expect((await cancel()).status).toBe(401);
    expect(state.writes).toEqual([]);
  });

  it("another business's owner gets 404 and nothing is written", async () => {
    state.userId = 'other-owner';
    expect((await cancel()).status).toBe(404);
    expect(state.writes).toEqual([]);
    expect(state.ticket!.status).toBe('valid');
  });

  it('a removed team member gets 404', async () => {
    state.userId = 'former-staff';
    expect((await cancel()).status).toBe(404);
    expect(state.writes).toEqual([]);
  });

  it('the owner cancels: only event_tickets.status changes, conditionally on valid', async () => {
    state.userId = 'owner';
    const { status, body } = await cancel();
    expect(status).toBe(200);
    expect(body).toEqual({ ticket: { id: ID, status: 'cancelled' } });
    expect(state.writes).toEqual([{
      table: 'event_tickets', payload: { status: 'cancelled' },
      filters: { id: ID, business_id: BIZ, status: 'valid' },
    }]);
  });

  it('an active team member cancels', async () => {
    state.userId = 'team';
    expect((await cancel()).status).toBe(200);
  });

  it('an already-used ticket is not cancelled (409 with its status)', async () => {
    state.userId = 'owner';
    state.ticket!.status = 'used';
    const { status, body } = await cancel();
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Ticket is used, so it was not cancelled.', status: 'used' });
    expect(state.ticket!.status).toBe('used');
  });

  it('bad id is 400; missing ticket is 404', async () => {
    state.userId = 'owner';
    expect((await cancel('not-a-uuid')).status).toBe(400);
    state.ticket = null;
    expect((await cancel()).status).toBe(404);
  });
});
