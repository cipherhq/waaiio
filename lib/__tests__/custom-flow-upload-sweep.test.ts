// Custom Flow orphaned-upload sweep (#1085): the real cron route handler,
// with Storage and the answers table as an in-memory mocked boundary that
// behaves like Supabase (list() returns one folder level, folders have id null).
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  objects: new Map<string, string | null>(), // path -> created_at
  answers: [] as Row[],
  buckets: new Set<string>(),
  listCalls: 0,
  failRemovePrefix: '',
  failLookup: false,
  failListPrefix: null as string | null,
  removeCalls: [] as string[][],
  reports: [] as Row[],
  logs: [] as unknown[],
}));

function list(prefix: string, opts: { limit: number; offset: number }) {
  state.listCalls++;
  if (state.failListPrefix !== null && prefix === state.failListPrefix) return { data: null, error: { message: 'down' } };
  const base = prefix ? `${prefix}/` : '';
  const children = new Map<string, Row>();
  for (const [path, created] of state.objects) {
    if (!path.startsWith(base)) continue;
    const [name, ...rest] = path.slice(base.length).split('/');
    children.set(name, rest.length ? { name, id: null, created_at: null } : { name, id: `id-${path}`, created_at: created });
  }
  const sorted = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  return { data: sorted.slice(opts.offset, opts.offset + opts.limit), error: null };
}

const service = {
  storage: { from: (bucket: string) => {
    state.buckets.add(bucket);
    return {
      list: async (prefix: string, opts: { limit: number; offset: number }) => list(prefix, opts),
      remove: async (paths: string[]) => {
        state.removeCalls.push(paths);
        if (state.failRemovePrefix && paths.some(p => p.startsWith(state.failRemovePrefix))) return { data: null, error: { message: 'down' } };
        const removed = paths.filter(p => state.objects.delete(p)).map(name => ({ name }));
        return { data: removed, error: null };
      },
    };
  } },
  from: (table: string) => {
    expect(table).toBe('custom_flow_answers');
    const filters: Array<(r: Row) => boolean> = [];
    let max = Infinity;
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push(r => r[k] === v); return q; },
      like: (k: string, pattern: string) => {
        expect(pattern.endsWith('/%')).toBe(true);
        const prefix = pattern.slice(0, -1);
        expect(prefix).not.toMatch(/[%_]/);
        filters.push(r => typeof r[k] === 'string' && r[k].startsWith(prefix));
        return q;
      },
      limit: (n: number) => { max = n; return q; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(state.failLookup
        ? { data: null, error: { message: 'db down' } }
        : { data: state.answers.filter(r => filters.every(f => f(r))).slice(0, max).map(r => ({ file_path: r.file_path })), error: null }).then(resolve),
    };
    return q;
  },
};
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => service }));
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: (error: unknown, ctx: Row) => { state.reports.push(ctx); } }));
vi.mock('@/lib/logger', () => ({ logger: { info: (...a: unknown[]) => state.logs.push(a), error: (...a: unknown[]) => state.logs.push(a), warn: (...a: unknown[]) => state.logs.push(a) } }));

import { GET } from '@/app/api/cron/custom-flow-upload-sweep/route';
import { SWEEP_LIMITS } from '@/lib/custom-flow-responses/upload-sweep';
const DEFAULT_LIMITS = { ...SWEEP_LIMITS };

const run = (auth = 'Bearer test-secret') => GET(new NextRequest('http://localhost/api/cron/custom-flow-upload-sweep', { headers: { authorization: auth } }));
const uuid = () => crypto.randomUUID();
const OLD = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
const JUST_OVER = new Date(Date.now() - 24 * 3600_000 - 60_000).toISOString();
const RECENT = new Date(Date.now() - 2 * 3600_000).toISOString();
const biz = uuid(), other = uuid(), flow = uuid(), session = uuid(), session2 = uuid();
// The engine names files <node id>-<uuid>.<ext>; a short label like 'q1-a.jpg'
// becomes node 'q1' plus a stable uuid per label, so tests stay readable.
const labels = new Map<string, string>();
const fileName = (label: string) => {
  const [stem, ext] = label.split('.');
  if (!labels.has(stem)) labels.set(stem, uuid());
  return `${stem.split('-')[0]}-${labels.get(stem)}.${ext}`;
};
const path = (b: string, label: string, f = flow, s = session) => `${b}/${f}/${s}/${fileName(label)}`;
const reference = (p: string, business = p.split('/')[0]) => state.answers.push({ business_id: business, file_path: p });

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  Object.assign(SWEEP_LIMITS, DEFAULT_LIMITS);
  state.objects = new Map(); state.answers = []; state.buckets = new Set(); state.listCalls = 0;
  state.failRemovePrefix = ''; state.failLookup = false; state.failListPrefix = null;
  state.removeCalls = []; state.reports = []; state.logs = [];
});

describe('custom flow upload sweep', () => {
  it('rejects calls without the cron secret and touches no Storage', async () => {
    state.objects.set(path(biz, 'q1-a.jpg'), OLD);
    expect((await run('Bearer wrong')).status).toBe(401);
    expect((await run('')).status).toBe(401);
    expect(state.listCalls).toBe(0);
    expect(state.objects.size).toBe(1);
  });

  it('keeps referenced files of any age, keeps recent ones, deletes old unreferenced ones', async () => {
    const live = path(biz, 'q1-live.jpg'), orphan = path(biz, 'q1-orphan.jpg'), fresh = path(biz, 'q1-fresh.jpg');
    const edge = path(biz, 'q2-edge.pdf'), noDate = path(biz, 'q3-nodate.png'), otherLive = path(other, 'q1-x.jpg', uuid(), uuid());
    state.objects.set(live, OLD).set(orphan, OLD).set(fresh, RECENT).set(edge, JUST_OVER).set(noDate, null).set(otherLive, OLD);
    reference(live); reference(otherLive);
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect([...state.objects.keys()].sort()).toEqual([live, fresh, noDate, otherLive].sort());
    expect(body).toMatchObject({ ok: true, deleted: 2, kept_referenced: 2, kept_recent: 2, failed: 0, complete: true, businesses: 2 });
  });

  it('a reference from another business does not keep a file, and never deletes the other business’s file', async () => {
    const mine = path(biz, 'q1-a.jpg');
    state.objects.set(mine, OLD);
    // A row in another business pointing at this path cannot exist (M546 CHECK), but the lookup is scoped anyway.
    state.answers.push({ business_id: other, file_path: mine });
    await run();
    expect(state.objects.has(mine)).toBe(false);
  });

  it('only sweeps the engine’s exact folder shape in the custom-flow-uploads bucket', async () => {
    const keep = [
      'root-file.jpg',
      `${biz}/direct.jpg`,
      `${biz}/${flow}/flat.jpg`,
      `${biz}/${flow}/${session}/deeper/x.jpg`,
      `not-a-uuid/${flow}/${session}/x.jpg`,
      `${biz}/not-a-uuid/${session}/x.jpg`,
      `${biz}/${flow}/not-a-uuid/x.jpg`,
      `${biz}/${flow}/${session}/notes.txt`,
      `${biz}/${flow}/${session}/q1-${uuid()}.exe`,
      `${biz}/${flow}/${session}/q1-not-a-uuid.jpg`,
      `${biz}/${flow}/${session}/bad id-${uuid()}.jpg`,
    ];
    for (const p of keep) state.objects.set(p, OLD);
    state.objects.set(path(biz, 'q1-orphan.jpg'), OLD);
    const body = await (await run()).json();
    expect([...state.objects.keys()].sort()).toEqual([...keep].sort());
    expect(body.deleted).toBe(1);
    expect(state.buckets).toEqual(new Set(['custom-flow-uploads']));
    for (const call of state.removeCalls) for (const p of call) expect(p).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^/]+$/);
  });

  it('pages through more than one page of business folders and of files in a session', async () => {
    // 1,000 entries per page: 1,001 business folders, and 1,001 files in one session.
    SWEEP_LIMITS.maxDeletes = 10_000; // this test is about paging, not the cap
    const businesses = Array.from({ length: 1001 }, uuid);
    for (const b of businesses) state.objects.set(path(b, 'q1-a.jpg', flow, session), OLD);
    for (let i = 0; i < 1001; i++) state.objects.set(path(biz, `q1-${String(i).padStart(4, '0')}.jpg`, flow, session2), OLD);
    const keepOne = path(biz, 'q1-1000.jpg', flow, session2);
    reference(keepOne);
    const body = await (await run()).json();
    expect(body).toMatchObject({ ok: true, complete: true, businesses: 1002, deleted: 2001, kept_referenced: 1 });
    expect([...state.objects.keys()]).toEqual([keepOne]);
  });

  it('a Storage delete failure for one business is reported and the others are still swept', async () => {
    const stuck = path(biz, 'q1-a.jpg'), gone = path(other, 'q1-b.jpg', uuid(), uuid());
    state.objects.set(stuck, OLD).set(gone, OLD);
    state.failRemovePrefix = `${biz}/`;
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: 'sweep_failed', failed: 1, deleted: 1 });
    expect(state.objects.has(stuck)).toBe(true);
    expect(state.objects.has(gone)).toBe(false);
    expect(state.reports).toEqual([{ area: 'cron', op: 'remove', job: 'custom-flow-upload-sweep', businessId: biz, level: 'warning' }]);
  });

  it('fails closed: if the answers lookup errors, nothing is deleted', async () => {
    state.objects.set(path(biz, 'q1-a.jpg'), OLD).set(path(other, 'q1-b.jpg', uuid(), uuid()), OLD);
    state.failLookup = true;
    const res = await run();
    expect(res.status).toBe(500);
    expect(state.objects.size).toBe(2);
    expect(state.removeCalls).toEqual([]);
    expect(state.reports.map(r => r.op)).toEqual(['lookup', 'lookup']);
  });

  it('fails closed: if the lookup could be cut short, nothing in that folder is deleted', async () => {
    const orphan = path(biz, 'q1-orphan.jpg');
    state.objects.set(orphan, OLD);
    for (let i = 0; i < 1000; i++) state.answers.push({ business_id: biz, file_path: path(biz, `ref-${i}.jpg`) });
    const res = await run();
    expect(res.status).toBe(500);
    expect(state.objects.has(orphan)).toBe(true);
    expect(state.removeCalls).toEqual([]);
  });

  it('a listing failure for one business is reported and the run carries on', async () => {
    const gone = path(other, 'q1-b.jpg', uuid(), uuid());
    state.objects.set(path(biz, 'q1-a.jpg'), OLD).set(gone, OLD);
    state.failListPrefix = biz;
    const res = await run();
    expect(res.status).toBe(500);
    expect(state.objects.has(gone)).toBe(false);
    expect(state.objects.has(path(biz, 'q1-a.jpg'))).toBe(true);
    expect(state.reports).toEqual([expect.objectContaining({ op: 'list_business', businessId: biz })]);
  });

  it('a listing failure at flow or session level is reported, skips only that folder, and returns 500', async () => {
    const flow2 = uuid();
    for (const [failing, op] of [[`${biz}/${flow2}`, 'list_flow'], [`${biz}/${flow}/${session2}`, 'list_session']] as const) {
      const inFailing = op === 'list_flow' ? path(biz, 'q1-a.jpg', flow2, session) : path(biz, 'q1-b.jpg', flow, session2);
      const gone = path(biz, 'q1-c.jpg');
      state.objects = new Map([[inFailing, OLD], [gone, OLD]]);
      state.failListPrefix = failing; state.reports = [];
      const res = await run();
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ ok: false, failed: 1, deleted: 1 });
      expect(state.reports).toEqual([expect.objectContaining({ op, businessId: biz })]);
      expect([...state.objects.keys()]).toEqual([inFailing]);
    }
  });

  it('an unexpected throw is reported without its message and returns 500', async () => {
    state.objects.set(path(biz, 'q1-a.jpg'), OLD);
    const spy = vi.spyOn(service.storage, 'from').mockImplementation(() => { throw new Error(`boom ${biz}`); });
    const res = await run();
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'sweep_crashed' });
    expect(state.reports).toEqual([{ area: 'cron', op: 'run', job: 'custom-flow-upload-sweep' }]);
    expect(state.objects.size).toBe(1);
  });

  it('a root listing failure deletes nothing and returns 500', async () => {
    state.objects.set(path(biz, 'q1-a.jpg'), OLD);
    state.failListPrefix = '';
    const res = await run();
    expect(res.status).toBe(500);
    expect(state.objects.size).toBe(1);
    expect(state.reports).toEqual([expect.objectContaining({ op: 'list_root', job: 'custom-flow-upload-sweep' })]);
  });

  it('is idempotent: a second run deletes nothing more', async () => {
    const live = path(biz, 'q1-live.jpg');
    state.objects.set(live, OLD).set(path(biz, 'q1-orphan.jpg'), OLD);
    reference(live);
    expect((await (await run()).json()).deleted).toBe(1);
    state.removeCalls = [];
    const second = await (await run()).json();
    expect(second).toMatchObject({ ok: true, deleted: 0, kept_referenced: 1 });
    expect(state.removeCalls).toEqual([]);
    expect([...state.objects.keys()]).toEqual([live]);
  });

  it('logs and returns counts only, never paths or ids', async () => {
    state.objects.set(path(biz, 'q1-a.jpg'), OLD).set(path(biz, 'q1-b.jpg'), RECENT);
    const res = await run();
    const text = JSON.stringify(await res.json()) + JSON.stringify(state.logs);
    for (const secret of [biz, flow, session, fileName('q1-a.jpg'), fileName('q1-b.jpg')]) expect(text).not.toContain(secret);
  });

  it('stops at the per-run delete cap, says so, and the next run finishes the job', async () => {
    SWEEP_LIMITS.maxDeletes = 1;
    state.objects.set(path(biz, 'q1-a.jpg'), OLD).set(path(other, 'q1-b.jpg', uuid(), uuid()), OLD);
    const first = await (await run()).json();
    expect(first).toMatchObject({ ok: true, deleted: 1, complete: false });
    expect(state.objects.size).toBe(1);
    const second = await (await run()).json();
    expect(second).toMatchObject({ ok: true, deleted: 1, complete: true });
    expect(state.objects.size).toBe(0);
  });

  it('stops at the listing budget without deleting anything it did not check', async () => {
    SWEEP_LIMITS.maxListCalls = 1;
    state.objects.set(path(biz, 'q1-a.jpg'), OLD);
    const body = await (await run()).json();
    expect(body).toMatchObject({ ok: true, deleted: 0, complete: false });
    expect(state.listCalls).toBe(1);
    expect(state.objects.size).toBe(1);
  });

  it('an empty bucket is a clean no-op', async () => {
    const res = await run();
    expect(await res.json()).toMatchObject({ ok: true, deleted: 0, businesses: 0, complete: true });
  });
});
