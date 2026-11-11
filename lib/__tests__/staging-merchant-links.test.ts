/**
 * Permanent merchant links (/m/...) under the staging routing policy
 * (Owner rule 2026-11-10). Calls the real GET handlers with mocked Supabase.
 * Mirrors the TestBiz incident: /m/<id> and /m/<id>/queue must redirect to the
 * designated staging number with the business code (and action) kept.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { STAGING_APP_PROJECT_ID, STAGING_SUPABASE_URL } from '@/lib/staging-test-mode';
import { STAGING_SHARED_WHATSAPP_CHANNEL } from '@/lib/channels/staging-whatsapp-routing';

const BIZ_ID = 'b47d9058-78bc-40a8-90ac-bd9667713710';
const DESIGNATED = STAGING_SHARED_WHATSAPP_CHANNEL.id;

let rows: { businesses: Record<string, unknown> | null; whatsapp_channels: Record<string, unknown> | null };
function chain(table: 'businesses' | 'whatsapp_channels') {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) self[m] = () => self;
  self.maybeSingle = () => Promise.resolve({ data: rows[table], error: null });
  self.single = self.maybeSingle;
  return self;
}
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: (t: 'businesses' | 'whatsapp_channels') => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) }),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: (_r: unknown, p: string) => `${p}:test`,
}));

const { GET: baseGET } = await import('@/app/m/[businessId]/route');
const { GET: actionGET } = await import('@/app/m/[businessId]/[action]/route');
const req = (path: string) => new NextRequest(new URL(path, 'https://staging.waaiio.com'));
const ctx = <T,>(p: T) => ({ params: Promise.resolve(p) });

const biz = (country: string) => ({
  id: BIZ_ID, country_code: country, status: 'active', messaging_suspended: false, bot_code: 'TESTBIZ',
  assigned_channel_id: DESIGNATED, whatsapp_channel_id: null,
});
const designated = (over: Record<string, unknown> = {}) => ({
  id: DESIGNATED, channel_type: 'shared', is_active: true, connection_status: 'active',
  country_code: 'US', business_id: null, phone_number: '12404712139', ...over,
});

const ENV = ['WAAIIO_ENVIRONMENT', 'VERCEL_PROJECT_ID', 'NEXT_PUBLIC_SUPABASE_URL'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.WAAIIO_ENVIRONMENT = 'staging';
  process.env.VERCEL_PROJECT_ID = STAGING_APP_PROJECT_ID;
  process.env.NEXT_PUBLIC_SUPABASE_URL = STAGING_SUPABASE_URL;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('staging merchant links use the designated number for every country', () => {
  it.each(['US', 'NG', 'GB', 'CA', 'GH', 'KE', 'ZA'])('%s business: base and queue links keep the business code', async (cc) => {
    rows = { businesses: biz(cc), whatsapp_channels: designated() };
    const base = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(base.status).toBe(302);
    expect(base.headers.get('location')).toBe('https://wa.me/12404712139?text=TESTBIZ');
    const queue = await actionGET(req(`/m/${BIZ_ID}/queue`), ctx({ businessId: BIZ_ID, action: 'queue' }));
    expect(queue.status).toBe(302);
    expect(queue.headers.get('location')).toBe('https://wa.me/12404712139?text=TESTBIZ%3Aqueue');
  });

  it('the incident shape (shared number owned by a business) still shows WhatsApp Unavailable', async () => {
    rows = { businesses: biz('US'), whatsapp_channels: designated({ business_id: 'edabed68-8b91-407e-a7f8-28e1d3c37e0d' }) };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('WhatsApp Unavailable');
  });

  it.each([
    ['inactive', { is_active: false }],
    ['disconnected', { connection_status: 'disconnected' }],
    ['another US number', { id: '00000000-0000-4000-8000-000000000001', phone_number: '12025550100' }],
    ['a local NG number', { id: '00000000-0000-4000-8000-000000000002', phone_number: '2348000000000', country_code: 'NG' }],
  ])('assigned to %s: 503, no redirect', async (_l, over) => {
    rows = { businesses: biz('NG'), whatsapp_channels: designated(over) };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
  });

  it('production identity: NG business on the US number is still refused', async () => {
    process.env.WAAIIO_ENVIRONMENT = 'production';
    process.env.VERCEL_PROJECT_ID = 'prj_PRODUCTION';
    rows = { businesses: biz('NG'), whatsapp_channels: designated() };
    const res = await baseGET(req(`/m/${BIZ_ID}`), ctx({ businessId: BIZ_ID }));
    expect(res.status).toBe(503);
  });
});
