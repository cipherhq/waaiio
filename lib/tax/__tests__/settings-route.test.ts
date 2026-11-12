import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_TAX_SETTINGS } from '../settings';

const h = vi.hoisted(() => ({ user: 'owner', owned: true, settings: null as unknown, error: false, writes: [] as unknown[], filters: [] as unknown[] }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: h.user ? { id: h.user } : null } }) },
  from: (table: string) => ({
    select() { return this; },
    eq(column: string, value: unknown) { h.filters.push([table, column, value]); return this; },
    async maybeSingle() { return table === 'businesses' ? { data: h.owned ? { id: 'business-a' } : null, error: null } : { data: h.settings, error: h.error ? { message: 'db failed' } : null }; },
    async upsert(value: unknown) { h.writes.push(value); return { error: h.error ? { message: 'db failed' } : null }; },
  }),
}) }));
import { GET, PUT } from '@/app/api/businesses/[id]/tax-settings/route';
const context = () => ({ params: Promise.resolve({ id: 'business-a' }) });
const request = (body?: unknown) => new NextRequest('http://localhost/api/businesses/business-a/tax-settings', body === undefined ? undefined : { method: 'PUT', body: JSON.stringify(body) });

describe('merchant tax settings owner boundary', () => {
  beforeEach(() => { h.user = 'owner'; h.owned = true; h.settings = null; h.error = false; h.writes = []; h.filters = []; });
  it('requires authentication for reading and writing', async () => {
    h.user = '';
    expect((await GET(request(), context())).status).toBe(401);
    expect((await PUT(request(DEFAULT_TAX_SETTINGS), context())).status).toBe(401);
    expect(h.writes).toEqual([]);
  });
  it('rejects another owner before accessing settings', async () => {
    h.owned = false;
    expect((await PUT(request(DEFAULT_TAX_SETTINGS), context())).status).toBe(403);
    expect((await GET(request(), context())).status).toBe(403);
    expect(h.filters).toContainEqual(['businesses', 'owner_id', 'owner']);
    expect(h.filters.some(x => (x as string[])[0] === 'merchant_tax_settings')).toBe(false);
    expect(h.writes).toEqual([]);
  });
  it('returns disabled defaults only for a genuinely absent row', async () => {
    expect(await (await GET(request(), context())).json()).toEqual({ settings: DEFAULT_TAX_SETTINGS });
    h.error = true;
    expect((await GET(request(), context())).status).toBe(503);
  });
  it('pins writes to the authorized path and strips injected fields', async () => {
    const response = await PUT(request({ ...DEFAULT_TAX_SETTINGS, business_id: 'other', tax_snapshot: {}, rate_bps: 750 }), context());
    expect(response.status).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ business_id: 'business-a', rate_bps: 750 });
    expect(h.writes[0]).not.toHaveProperty('tax_snapshot');
  });
  it('rejects invalid tax before any write and reports write failure', async () => {
    expect((await PUT(request({ ...DEFAULT_TAX_SETTINGS, rate_bps: -1 }), context())).status).toBe(400);
    expect(h.writes).toEqual([]);
    h.error = true;
    expect((await PUT(request(DEFAULT_TAX_SETTINGS), context())).status).toBe(503);
  });
});
