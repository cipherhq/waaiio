/**
 * #1105 GET /api/admin/giving — runs the real handler against an in-memory
 * table store shaped like the staging rows that the old page missed: a
 * 'shop' business taking giving through a giving service and a campaign.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

type Role = 'admin' | 'support' | 'finance' | 'operations';
const m = vi.hoisted(() => ({
  role: null as null | Role,
  db: null as unknown as MemoryDb,
}));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: async (_req: unknown, opts?: { requiredRole?: Role | Role[] }) => {
    if (!m.role) return null;
    const required = opts?.requiredRole ? ([] as Role[]).concat(opts.requiredRole) : null;
    return required && !required.includes(m.role) ? null : { userId: 'admin1', id: 'admin1', role: m.role, email: 'a@example.test' };
  },
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: (t: string) => m.db.from(t) }) }));

import { GET } from '@/app/api/admin/giving/route';

const SHOP = 'b-shop';
const CHURCH_GB = 'b-church-gb';

function get() {
  return GET(new NextRequest('https://staging.waaiio.com/api/admin/giving', { headers: { Origin: 'https://admin-staging.waaiio.com' } }));
}

beforeEach(() => {
  m.role = null;
  m.db = createMemoryDb({
    businesses: [
      { id: SHOP, name: 'TestBiz', category: 'shop', country_code: 'NG' },
      { id: CHURCH_GB, name: 'Grace UK', category: 'church', country_code: 'GB' },
    ],
    countries: [{ code: 'NG', currency_code: 'NGN' }, { code: 'GB', currency_code: 'GBP' }],
    services: [
      { id: 'svc-tithe', business_id: SHOP, name: 'Tithe', service_type: 'giving' },
      { id: 'svc-offering', business_id: CHURCH_GB, name: 'Offering', service_type: 'giving' },
      { id: 'svc-shirt', business_id: SHOP, name: 'T-shirt', service_type: 'service' },
    ],
    bookings: [
      // paid giving, logged-in giver
      { id: 'bk-paid', business_id: SHOP, user_id: 'u1', service_id: 'svc-tithe', flow_type: 'payment', total_amount: 5000, deposit_status: 'paid', status: 'confirmed', guest_name: null, guest_phone: '2348000000001', reference_code: 'PAY-1', notes: null, created_at: '2026-11-02T00:00:00Z' },
      // unpaid giving: listed, not counted
      { id: 'bk-pending', business_id: SHOP, user_id: null, service_id: 'svc-tithe', flow_type: 'payment', total_amount: 9000, deposit_status: 'none', status: 'confirmed', guest_name: 'Guest', guest_phone: '2348000000002', reference_code: 'PAY-2', notes: null, created_at: '2026-11-03T00:00:00Z' },
      // refunded giving: listed as refunded
      { id: 'bk-refunded', business_id: CHURCH_GB, user_id: null, service_id: 'svc-offering', flow_type: 'payment', total_amount: 20, deposit_status: 'refunded', status: 'confirmed', guest_name: 'Pat', guest_phone: '447000000001', reference_code: 'PAY-3', notes: null, created_at: '2026-11-04T00:00:00Z' },
      // paid GBP giving
      { id: 'bk-gbp', business_id: CHURCH_GB, user_id: null, service_id: 'svc-offering', flow_type: 'payment', total_amount: 30, deposit_status: 'paid', status: 'confirmed', guest_name: 'Sam', guest_phone: '447000000002', reference_code: 'PAY-4', notes: null, created_at: '2026-11-05T00:00:00Z' },
      // an ordinary (non-giving) payment: never on the Giving page
      { id: 'bk-shirt', business_id: SHOP, user_id: null, service_id: 'svc-shirt', flow_type: 'payment', total_amount: 25000, deposit_status: 'paid', status: 'confirmed', guest_name: 'Buyer', guest_phone: '2348000000003', reference_code: 'PAY-5', notes: null, created_at: '2026-11-06T00:00:00Z' },
    ],
    payments: [
      { id: 'p-pending-attempt', booking_id: 'bk-paid', status: 'pending', currency: 'NGN', gateway: 'paystack', gateway_reference: 'old', payment_method: 'card' },
      { id: 'p-paid', booking_id: 'bk-paid', status: 'success', currency: 'NGN', gateway: 'paystack', gateway_reference: 'ps_1', payment_method: 'card' },
      { id: 'p-gbp', booking_id: 'bk-gbp', status: 'success', currency: 'GBP', gateway: 'stripe', gateway_reference: 'pi_1', payment_method: 'card' },
      { id: 'p-don', booking_id: null, status: 'success', currency: 'NGN', gateway: 'paystack', gateway_reference: 'ps_2', payment_method: 'card' },
      { id: 'p-don-refunded', booking_id: null, status: 'refunded', currency: 'NGN', gateway: 'paystack', gateway_reference: 'ps_3', payment_method: 'card' },
    ],
    profiles: [{ id: 'u1', first_name: 'Ada', last_name: 'Obi', email: 'ada@example.test' }],
    campaigns: [{ id: 'c1', business_id: SHOP, title: 'Roof Fund' }],
    campaign_donations: [
      { id: 'd-ok', campaign_id: 'c1', business_id: SHOP, payment_id: 'p-don', donor_phone: '2348000000009', donor_name: 'Bola', amount: 1444, currency: 'NGN', status: 'success', reference_code: 'DON-1', created_at: '2026-10-28T00:00:00Z' },
      { id: 'd-failed', campaign_id: 'c1', business_id: SHOP, payment_id: null, donor_phone: '2348000000010', donor_name: null, amount: 700, currency: 'NGN', status: 'failed', reference_code: 'DON-2', created_at: '2026-10-29T00:00:00Z' },
      { id: 'd-refunded', campaign_id: 'c1', business_id: SHOP, payment_id: 'p-don-refunded', donor_phone: '2348000000011', donor_name: 'Chi', amount: 500, currency: 'NGN', status: 'success', reference_code: 'DON-3', created_at: '2026-10-30T00:00:00Z' },
    ],
  });
});

describe('GET /api/admin/giving', () => {
  it('only admin and finance can read it (same roles as the page)', async () => {
    expect((await get()).status).toBe(403);
    for (const role of ['support', 'operations'] as const) {
      m.role = role;
      expect((await get()).status).toBe(403);
    }
    for (const role of ['admin', 'finance'] as const) {
      m.role = role;
      expect((await get()).status).toBe(200);
    }
  });

  it('returns giving at any business category plus campaign donations, never ordinary payments', async () => {
    m.role = 'finance';
    const res = await get();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const { records } = await res.json();
    const ids = records.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['bk-gbp', 'bk-refunded', 'bk-pending', 'bk-paid', 'd-refunded', 'd-failed', 'd-ok']);
    expect(ids).not.toContain('bk-shirt');

    const byId = Object.fromEntries(records.map((r: { id: string }) => [r.id, r]));
    expect(byId['bk-paid']).toMatchObject({
      source: 'giving', business_name: 'TestBiz', business_category: 'shop', status: 'success',
      amount: 5000, currency: 'NGN', giver_name: 'Ada Obi', giver_email: 'ada@example.test',
      purpose: 'Tithe', gateway: 'paystack', gateway_ref: 'ps_1',
    });
    expect(byId['bk-pending']).toMatchObject({ status: 'pending', giver_name: 'Guest' });
    expect(byId['bk-refunded']).toMatchObject({ status: 'refunded', currency: 'GBP' });
    expect(byId['bk-gbp']).toMatchObject({ status: 'success', currency: 'GBP', amount: 30 });
    expect(byId['d-ok']).toMatchObject({ source: 'crowdfunding', status: 'success', amount: 1444, currency: 'NGN', purpose: 'Roof Fund', giver_name: 'Bola' });
    expect(byId['d-failed']).toMatchObject({ status: 'failed', giver_name: 'Anonymous' });
    expect(byId['d-refunded']).toMatchObject({ status: 'refunded' });
  });

  it('pages past the 1000-row server cap instead of silently returning a partial list', async () => {
    m.role = 'admin';
    m.db.tables.campaign_donations = Array.from({ length: 2500 }, (_, i) => ({
      id: `d-${String(i).padStart(5, '0')}`, campaign_id: 'c1', business_id: SHOP, payment_id: null, donor_phone: `p${i}`,
      donor_name: null, amount: 1, currency: 'NGN', status: 'success', reference_code: null, created_at: '2026-10-01T00:00:00Z',
    }));
    // Simulate PostgREST max_rows: a request can never return more than 1000 rows.
    const from = m.db.from.bind(m.db);
    m.db.from = (t: string) => {
      const q = from(t);
      const range = q.range.bind(q);
      q.range = (a: number, b: number) => range(a, Math.min(b, a + 999));
      return q;
    };
    const body = await (await get()).json();
    expect(body.records.filter((r: { source: string }) => r.source === 'crowdfunding')).toHaveLength(2500);
    expect(new Set(body.records.map((r: { id: string }) => r.id)).size).toBe(body.records.length);
    expect(body.truncated).toBe(false);
  });

  it('says truncated when more donations exist than it will read', async () => {
    m.role = 'admin';
    m.db.tables.campaign_donations = Array.from({ length: 20001 }, (_, i) => ({
      id: `d-${String(i).padStart(5, '0')}`, campaign_id: 'c1', business_id: SHOP, payment_id: null, donor_phone: 'p',
      donor_name: null, amount: 1, currency: 'NGN', status: 'success', reference_code: null, created_at: '2026-10-01T00:00:00Z',
    }));
    const body = await (await get()).json();
    expect(body.truncated).toBe(true);
    expect(body.records.filter((r: { source: string }) => r.source === 'crowdfunding')).toHaveLength(20000);
  });

  it('reports a partial refund on a successful payment', async () => {
    m.role = 'admin';
    m.db.tables.payments.find(p => p.id === 'p-paid')!.refund_amount = 1500;
    const { records } = await (await get()).json();
    expect(records.find((r: { id: string }) => r.id === 'bk-paid')).toMatchObject({ status: 'success', amount: 5000, refunded_amount: 1500 });
    expect(records.find((r: { id: string }) => r.id === 'bk-gbp')).toMatchObject({ refunded_amount: 0 });
  });

  it.each(['services', 'bookings', 'campaign_donations', 'payments', 'businesses', 'countries', 'profiles', 'campaigns'])(
    'a failed %s read is an error, not an empty list',
    async table => {
      m.role = 'admin';
      m.db.failReads.add(table);
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Could not load giving records' });
    },
  );
});
