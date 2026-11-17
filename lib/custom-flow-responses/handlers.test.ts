// Flow answers API + retention cron (#1085): real route handlers, real role
// resolution and CSV code; the database and Storage are a mocked boundary.
// Row-level isolation itself is proven on real PostgreSQL in
// lib/__tests__/custom-flow-answers-546.pg.test.ts; here the routes must also
// scope every query by business themselves.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/custom-flows/responses/route';
import { GET as retention } from '@/app/api/cron/custom-flow-answers-retention/route';

type Row = Record<string, any>;
const state = vi.hoisted(() => ({ user: 'owner' as string, rows: {} as Record<string, Row[]>, removed: [] as string[], storageError: false, signed: [] as Row[] }));
class Query {
  filters: Array<(row: Row) => boolean> = [];
  max = Infinity; from = 0;
  constructor(private table: string, private operation = 'read') {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push(r => r[k] === v); return this; }
  in(k: string, v: unknown[]) { this.filters.push(r => v.includes(r[k])); return this; }
  lt(k: string, v: string) { this.filters.push(r => r[k] < v); return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  range(a: number, b: number) { this.from = a; this.max = b - a + 1; return this; }
  execute(single = false) {
    const rows = state.rows[this.table] ?? [];
    const matches = rows.filter(r => this.filters.every(f => f(r))).slice(this.from, this.from + this.max);
    if (this.operation === 'delete') state.rows[this.table] = rows.filter(r => !matches.includes(r));
    return { data: structuredClone(single ? matches[0] ?? null : matches), error: null };
  }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  then(resolve: (v: ReturnType<Query['execute']>) => unknown, reject?: (e: unknown) => unknown) { return Promise.resolve(this.execute()).then(resolve, reject); }
}
const storage = { from: (bucket: string) => ({
  remove: async (paths: string[]) => { expect(bucket).toBe('custom-flow-uploads'); if (state.storageError) return { data: null, error: { message: 'down' } }; state.removed.push(...paths); return { data: [], error: null }; },
  createSignedUrl: async (path: string, seconds: number) => { state.signed.push({ bucket, path, seconds }); return { data: { signedUrl: `https://signed/${path}` }, error: null }; },
}) };
const db = { auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) },
  from: (table: string) => ({ select: () => new Query(table), delete: () => new Query(table, 'delete') }), storage };
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));

const biz = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const flow = '33333333-3333-4333-8333-333333333333', otherFlow = '44444444-4444-4444-8444-444444444444';
const r1 = '55555555-5555-4555-8555-555555555555', r2 = '66666666-6666-4666-8666-666666666666';
const fileAnswer = '77777777-7777-4777-8777-777777777777', otherFile = '88888888-8888-4888-8888-888888888888';
const answer = (over: Row): Row => ({ id: crypto.randomUUID(), business_id: biz, flow_id: flow, flow_version: 1, response_id: r1, customer_number: '2348012345678',
  node_id: 'coming', question: 'Are you coming?', answer_type: 'yes_no', value_text: 'Yes', value_date: null, file_path: null, file_mime: null, file_size: null, created_at: '2026-11-10T09:00:00.000Z', ...over });

const get = (q: string) => GET(new NextRequest(`http://localhost/api/custom-flows/responses?businessId=${biz}${q}`));
const post = (body: Row) => POST(new NextRequest('http://localhost/api/custom-flows/responses', { method: 'POST', body: JSON.stringify({ businessId: biz, flowId: flow, ...body }) }));

beforeEach(() => {
  state.user = 'owner'; state.removed = []; state.storageError = false; state.signed = [];
  state.rows = {
    businesses: [{ id: biz, owner_id: 'owner' }, { id: other, owner_id: 'other-owner' }],
    business_members: [
      { business_id: biz, user_id: 'teammate', role: 'staff', status: 'active' },
      { business_id: biz, user_id: 'invited', role: 'admin', status: 'invited' },
    ],
    custom_flows: [{ id: flow, business_id: biz, name: 'Retreat sign-up' }, { id: otherFlow, business_id: other, name: 'Other' }],
    custom_flow_answers: [
      answer({}),
      answer({ node_id: 'day', question: 'Which day?', answer_type: 'date', value_text: null, value_date: '2026-11-21', created_at: '2026-11-10T09:01:00.000Z' }),
      answer({ id: fileAnswer, node_id: 'photo', question: 'Send a photo', answer_type: 'file', value_text: null, file_path: `${biz}/a.jpg`, file_mime: 'image/jpeg', file_size: 2048, created_at: '2026-11-10T09:02:00.000Z' }),
      answer({ response_id: r2, value_text: '=HYPERLINK("http://evil")', created_at: '2026-11-12T09:00:00.000Z' }),
      answer({ id: otherFile, business_id: other, flow_id: otherFlow, response_id: crypto.randomUUID(), answer_type: 'file', value_text: null, file_path: `${other}/b.pdf`, file_mime: 'application/pdf', file_size: 10 }),
    ],
  };
});

describe('Flow answers API', () => {
  it('denies the signed-out, other owners and invited (not yet active) members', async () => {
    state.user = ''; expect((await get(`&flowId=${flow}`)).status).toBe(401);
    for (const user of ['other-owner', 'invited', 'stranger']) {
      state.user = user;
      expect((await get(`&flowId=${flow}`)).status).toBe(403);
      expect((await post({ action: 'delete_flow_answers' })).status).toBe(403);
    }
    expect(state.rows.custom_flow_answers).toHaveLength(5);
  });

  it('the owner and an active team member see grouped answers without storage paths', async () => {
    for (const user of ['owner', 'teammate']) {
      state.user = user;
      const res = await get(`&flowId=${flow}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.flows.map((f: Row) => f.id)).toEqual([flow]);
      expect(body.canDelete).toBe(user === 'owner');
      expect(body.responses.map((r: Row) => r.response_id)).toEqual([r2, r1]);
      expect(body.responses[1].answers.map((a: Row) => a.node_id)).toEqual(['coming', 'day', 'photo']);
      expect(JSON.stringify(body)).not.toContain('a.jpg');
    }
  });

  it("another business's flow is not found, even by id", async () => {
    expect((await get(`&flowId=${otherFlow}`)).status).toBe(404);
    expect((await get(`&flowId=${otherFlow}&format=csv`)).status).toBe(404);
  });

  it('gives a 5-minute private link only for its own uploaded file', async () => {
    state.user = 'teammate';
    const res = await get(`&file=${fileAnswer}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `https://signed/${biz}/a.jpg`, expiresIn: 300 });
    expect(state.signed).toEqual([{ bucket: 'custom-flow-uploads', path: `${biz}/a.jpg`, seconds: 300 }]);
    expect((await get(`&file=${otherFile}`)).status).toBe(404);
    expect((await get('&file=not-a-uuid')).status).toBe(400);
    expect(state.signed).toHaveLength(1);
  });

  it('CSV: one row per customer, one column per question, formulas neutralised', async () => {
    state.user = 'teammate';
    const res = await get(`&flowId=${flow}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Retreat-sign-up-answers.csv"');
    const lines = (await res.text()).replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Answered on (UTC),Customer WhatsApp,Are you coming?,Which day?,Send a photo');
    expect(lines[1]).toBe(`2026-11-12 09:00,+2348012345678,"'=HYPERLINK(""http://evil"")",,`);
    expect(lines[2]).toBe('2026-11-10 09:02,+2348012345678,Yes,2026-11-21,Photo (open it on the Flow answers page)');
    expect(lines).toHaveLength(3);
  });

  it('only the owner deletes; a team member gets 403 and nothing changes', async () => {
    state.user = 'teammate';
    expect((await post({ action: 'delete_response', responseId: r1 })).status).toBe(403);
    expect(state.rows.custom_flow_answers).toHaveLength(5);
  });

  it('owner deletes one response: its file goes first, then its rows', async () => {
    const res = await post({ action: 'delete_response', responseId: r1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });
    expect(state.removed).toEqual([`${biz}/a.jpg`]);
    expect(state.rows.custom_flow_answers.map(r => r.response_id)).not.toContain(r1);
    expect((await post({ action: 'delete_response', responseId: r1 })).status).toBe(404);
  });

  it("owner deletes all answers for a flow; another business's answers stay", async () => {
    expect(await (await post({ action: 'delete_flow_answers' })).json()).toEqual({ deleted: 4 });
    expect(state.rows.custom_flow_answers.map(r => r.business_id)).toEqual([other]);
    // A foreign flow id deletes nothing.
    expect(await (await post({ action: 'delete_flow_answers', flowId: otherFlow })).json()).toEqual({ deleted: 0 });
    expect(state.rows.custom_flow_answers).toHaveLength(1);
  });

  it('if file removal fails, the rows are kept', async () => {
    state.storageError = true;
    const res = await post({ action: 'delete_response', responseId: r1 });
    expect(res.status).toBe(500);
    expect(state.rows.custom_flow_answers).toHaveLength(5);
  });

  it('rejects unknown actions and bad ids', async () => {
    expect((await post({ action: 'update' })).status).toBe(400);
    expect((await post({ action: 'delete_response', responseId: 'x' })).status).toBe(400);
    expect((await post({ action: 'delete_flow_answers', flowId: 'x' })).status).toBe(400);
  });
});

describe('answers retention cron', () => {
  const cron = (auth = 'Bearer test-secret') => retention(new NextRequest('http://localhost/api/cron/custom-flow-answers-retention', { headers: { authorization: auth } }));
  beforeEach(() => { vi.stubEnv('CRON_SECRET', 'test-secret'); });

  it('needs the cron secret', async () => {
    expect((await cron('Bearer wrong')).status).toBe(401);
    expect(state.rows.custom_flow_answers).toHaveLength(5);
  });

  it('deletes only answers older than 12 months, files first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-11-11T00:00:00.000Z'));
    try {
      // Everything from 2026-11-10 is older than 12 months; 2026-11-12 is not.
      const res = await cron();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, deleted: 4, cutoff: '2026-11-11T00:00:00.000Z' });
      expect(state.removed.sort()).toEqual([`${biz}/a.jpg`, `${other}/b.pdf`]);
      expect(state.rows.custom_flow_answers.map(r => r.response_id)).toEqual([r2]);
    } finally { vi.useRealTimers(); }
  });

  it('keeps rows when Storage fails, so the next run retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-11-11T00:00:00.000Z'));
    try {
      state.storageError = true;
      expect((await cron()).status).toBe(500);
      expect(state.rows.custom_flow_answers).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });
});
