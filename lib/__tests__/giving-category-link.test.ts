/**
 * Giving-category share links (Owner request 2026-11-18).
 *
 * 1. Link builder, ref and prefill helpers (lib/giving-category-link.ts).
 * 2. The real /m/{businessId}/giving/{categoryId} GET handler with a mocked
 *    Supabase: redirect target, no-store, shared + dedicated numbers, and the
 *    existing business/channel guards from app/m/resolve.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  buildGivingCategoryLink,
  buildGivingCategoryPrefill,
  givingCategoryRef,
  parseGivingCategoryPrefill,
  resolveGivingCategoryRef,
} from '@/lib/giving-category-link';
import { canonicalPublicOrigin } from '@/lib/url';

const BIZ_ID = '550e8400-e29b-41d4-a716-446655440000';
const CAT_ID = '3f2a9c1d-1b2c-4d3e-8f40-123456789abc';
const PHONE = '+12025551234';

describe('giving-category link helpers', () => {
  it('builds the permanent /m/{business}/giving/{category} link', () => {
    expect(buildGivingCategoryLink(BIZ_ID, CAT_ID)).toBe(`${canonicalPublicOrigin()}/m/${BIZ_ID}/giving/${CAT_ID}`);
  });

  it('uses the first 8 hex characters of the category id as the ref', () => {
    expect(givingCategoryRef(CAT_ID)).toBe('3f2a9c1d');
    expect(givingCategoryRef(CAT_ID.toUpperCase())).toBe('3f2a9c1d');
    expect(givingCategoryRef('not-a-uuid')).toBeNull();
  });

  it('builds and parses the WhatsApp prefill', () => {
    const prefill = buildGivingCategoryPrefill('GRACE-CHAPEL', CAT_ID);
    expect(prefill).toBe('GRACE-CHAPEL:giving:3f2a9c1d');
    expect(parseGivingCategoryPrefill(prefill!)).toEqual({ botCode: 'GRACE-CHAPEL', ref: '3f2a9c1d' });
    expect(parseGivingCategoryPrefill('  grace:GIVING:3F2A9C1D ')).toEqual({ botCode: 'grace', ref: '3f2a9c1d' });
  });

  it('refuses a missing or unsafe bot code and rejects other text', () => {
    expect(buildGivingCategoryPrefill('', CAT_ID)).toBeNull();
    expect(buildGivingCategoryPrefill('BAD CODE', CAT_ID)).toBeNull();
    expect(buildGivingCategoryPrefill('GRACE', 'nope')).toBeNull();
    for (const t of ['GRACE', 'GRACE:giving', 'GRACE:payment', 'GRACE:giving:3f2a9c1', 'GRACE:giving:3f2a9c1dz', 'pay tithe 5000', 'a b:giving:3f2a9c1d']) {
      expect(parseGivingCategoryPrefill(t)).toBeNull();
    }
  });

  it('resolves a ref only among the business\'s active, non-deleted giving categories', async () => {
    const eqs: Array<[string, unknown]> = [];
    const iss: Array<[string, unknown]> = [];
    const rows = [{ id: CAT_ID, name: 'Tithe' }, { id: '9b1e0000-0000-4000-8000-000000000001', name: 'Offering' }];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (c: string, v: unknown) => { eqs.push([c, v]); return chain; };
    chain.is = (c: string, v: unknown) => { iss.push([c, v]); return chain; };
    chain.then = (r: (v: unknown) => void) => r({ data: rows, error: null });
    const supabase = { from: () => chain } as never;

    expect(await resolveGivingCategoryRef(supabase, BIZ_ID, '3f2a9c1d')).toEqual({ id: CAT_ID, name: 'Tithe' });
    expect(await resolveGivingCategoryRef(supabase, BIZ_ID, 'deadbeef')).toBeNull();
    expect(eqs).toContainEqual(['business_id', BIZ_ID]);
    expect(eqs).toContainEqual(['service_type', 'giving']);
    expect(eqs).toContainEqual(['is_active', true]);
    expect(iss).toContainEqual(['deleted_at', null]);
  });
});

// ── Route handler ──
type QR = { data: unknown; error: null };
let mockResults: Record<string, QR>;
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => {
      const self: Record<string, unknown> = {};
      self.select = () => self;
      self.eq = () => self;
      self.maybeSingle = () => Promise.resolve(mockResults[t] ?? { data: null, error: null });
      return self;
    },
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: (_r: unknown, p: string) => `${p}:test`,
}));

const { GET } = await import('@/app/m/[businessId]/giving/[categoryId]/route');

function business(overrides: Record<string, unknown> = {}) {
  return { id: BIZ_ID, country_code: 'US', status: 'active', messaging_suspended: false, bot_code: 'GRACE', assigned_channel_id: 'ch-1', whatsapp_channel_id: null, ...overrides };
}
function channel(type: 'shared' | 'dedicated') {
  return { id: 'ch-1', channel_type: type, is_active: true, connection_status: 'active', country_code: 'US', business_id: type === 'dedicated' ? BIZ_ID : null, phone_number: PHONE };
}
const call = (path: string, businessId = BIZ_ID, categoryId = CAT_ID) =>
  GET(new NextRequest(new URL(path, 'https://www.waaiio.com')), { params: Promise.resolve({ businessId, categoryId }) });

describe('/m/{businessId}/giving/{categoryId} route', () => {
  beforeEach(() => {
    mockResults = { businesses: { data: business(), error: null }, whatsapp_channels: { data: channel('shared'), error: null } };
  });

  it('shared number: redirects to WhatsApp with CODE:giving:ref, no-store', async () => {
    const res = await call(`/m/${BIZ_ID}/giving/${CAT_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://wa.me/12025551234?text=${encodeURIComponent('GRACE:giving:3f2a9c1d')}`);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('dedicated number: uses the same prefill so the category is still preselected', async () => {
    mockResults.whatsapp_channels = { data: channel('dedicated'), error: null };
    const res = await call(`/m/${BIZ_ID}/giving/${CAT_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://wa.me/12025551234?text=${encodeURIComponent('GRACE:giving:3f2a9c1d')}`);
  });

  it('works by bot code as well as by business id', async () => {
    const res = await call(`/m/GRACE/giving/${CAT_ID}`, 'GRACE');
    expect(res.status).toBe(302);
  });

  it('rejects a malformed category id and any query parameters', async () => {
    expect((await call(`/m/${BIZ_ID}/giving/abc`, BIZ_ID, 'abc')).status).toBe(400);
    expect((await call(`/m/${BIZ_ID}/giving/${CAT_ID}?x=1`)).status).toBe(400);
  });

  it('keeps the existing business guards (inactive, suspended, no routing code)', async () => {
    mockResults.businesses = { data: business({ status: 'suspended' }), error: null };
    expect((await call(`/m/${BIZ_ID}/giving/${CAT_ID}`)).status).toBe(503);
    mockResults.businesses = { data: business({ messaging_suspended: true }), error: null };
    expect((await call(`/m/${BIZ_ID}/giving/${CAT_ID}`)).status).toBe(503);
    mockResults.businesses = { data: business({ bot_code: null }), error: null };
    expect((await call(`/m/${BIZ_ID}/giving/${CAT_ID}`)).status).toBe(503);
    mockResults.businesses = { data: null, error: null };
    expect((await call(`/m/${BIZ_ID}/giving/${CAT_ID}`)).status).toBe(404);
  });
});
