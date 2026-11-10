/**
 * #963 lane 2: the /api/intake/[token] route handlers, run directly with a
 * fake service client. The database function itself is proven by
 * booking-intakes-526.pg.test.ts; this proves the route's lookup, checks,
 * error mapping and that it never returns the phone or the answers.
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  intake: null as Record<string, unknown> | null,
  form: null as Record<string, unknown> | null,
  rpcError: null as { code?: string; message?: string } | null,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      state.queries.push({ table, filters });
      const result = (): { data: Row | null; error: null } => {
        const f = Object.fromEntries(filters);
        if (table === 'booking_intakes') return { data: state.intake && f.token_hash === state.intake.token_hash ? state.intake : null, error: null };
        if (table === 'forms') return { data: state.form, error: null };
        if (table === 'businesses') return { data: { name: 'Healing Labs', logo_url: null }, error: null };
        if (table === 'services') return { data: { name: 'Assessment' }, error: null };
        if (table === 'bookings') return { data: { date: '2026-11-20', time: '10:00:00' }, error: null };
        return { data: null, error: null };
      };
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return q; },
        maybeSingle: async () => result(),
      };
      return q;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      return { data: state.rpcError ? null : { status: 'submitted' }, error: state.rpcError };
    },
  }),
}));

import { GET, POST } from '@/app/api/intake/[token]/route';

const TOKEN = 'a'.repeat(43);
const hash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
const FIELDS = [
  { id: 'concern', label: 'Main concern', type: 'textarea', required: true },
  { id: 'scan', label: 'Scan', type: 'file', required: false },
];
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const get = (token = TOKEN) => GET(new NextRequest(`http://x/api/intake/${token}`), ctx(token));
const post = (body: unknown, token = TOKEN) =>
  POST(new NextRequest(`http://x/api/intake/${token}`, { method: 'POST', body: JSON.stringify(body) }), ctx(token));

beforeEach(() => {
  state.intake = {
    id: 'i1', business_id: 'b1', service_id: 's1', form_id: 'f1', booking_id: 'k1',
    status: 'pending', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    token_hash: hash(TOKEN), customer_phone: '+2348012345678',
  };
  state.form = { title: 'Intake', description: null, fields: FIELDS, is_active: true };
  state.rpcError = null;
  state.rpcCalls = [];
  state.queries = [];
});

describe('GET /api/intake/[token]', () => {
  it('looks the intake up by the sha256 of the token, never the token itself', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const lookup = state.queries.find(q => q.table === 'booking_intakes');
    expect(lookup?.filters).toEqual([['token_hash', hash(TOKEN)]]);
    expect(JSON.stringify(state.queries)).not.toContain(TOKEN);
  });

  it('returns the form without file questions, the phone or any answers', async () => {
    const res = await get();
    const body = await res.json();
    expect(body).toMatchObject({ status: 'pending', title: 'Intake', business_name: 'Healing Labs', service_name: 'Assessment', booking_date: '2026-11-20' });
    expect(body.fields.map((f: { id: string }) => f.id)).toEqual(['concern']);
    expect(JSON.stringify(body)).not.toContain('2348012345678');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('404s a malformed or unknown token', async () => {
    expect((await get('short')).status).toBe(404);
    expect((await get('b'.repeat(43))).status).toBe(404);
  });

  it('reports submitted, expired and inactive forms without the questions', async () => {
    state.intake!.status = 'submitted';
    let body = await (await get()).json();
    expect(body.status).toBe('submitted');
    expect(body.fields).toBeUndefined();

    state.intake!.status = 'pending';
    state.intake!.expires_at = new Date(Date.now() - 1000).toISOString();
    body = await (await get()).json();
    expect(body.status).toBe('expired');
    expect(body.fields).toBeUndefined();

    state.intake!.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    state.form!.is_active = false;
    body = await (await get()).json();
    expect(body.status).toBe('unavailable');
  });
});

describe('POST /api/intake/[token]', () => {
  it('submits checked answers through the service-role function', async () => {
    const res = await post({ answers: { concern: 'Sleep' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'submitted' });
    expect(state.rpcCalls).toEqual([{ fn: 'submit_booking_intake_526', args: { p_token: TOKEN, p_answers: { concern: 'Sleep' } } }]);
  });

  it('400s bad answers without calling the database function', async () => {
    for (const body of [{ answers: {} }, { answers: { concern: 'x', extra: 1 } }, { answers: { concern: 'x', scan: 'https://x' } }, {}]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('410s an expired link and an inactive form; 404s an unknown token', async () => {
    state.intake!.expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await post({ answers: { concern: 'x' } })).status).toBe(410);
    state.intake!.expires_at = new Date(Date.now() + 86_400_000).toISOString();
    state.form!.is_active = false;
    expect((await post({ answers: { concern: 'x' } })).status).toBe(410);
    expect((await post({ answers: { concern: 'x' } }, 'c'.repeat(43))).status).toBe(404);
    expect(state.rpcCalls).toEqual([]);
  });

  it('treats an already submitted link as done without submitting again', async () => {
    state.intake!.status = 'submitted';
    const res = await post({ answers: { concern: 'changed' } });
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toEqual([]);
  });

  it('maps database refusals: 42501 to 404, expiry to 410, other 22023 to 400', async () => {
    state.rpcError = { code: '42501', message: 'Intake unavailable' };
    expect((await post({ answers: { concern: 'x' } })).status).toBe(404);
    state.rpcError = { code: '22023', message: 'Intake link expired' };
    expect((await post({ answers: { concern: 'x' } })).status).toBe(410);
    state.rpcError = { code: '22023', message: 'A required answer is missing' };
    expect((await post({ answers: { concern: 'x' } })).status).toBe(400);
    state.rpcError = { code: 'XX000', message: 'boom' };
    expect((await post({ answers: { concern: 'x' } })).status).toBe(500);
  });
});
