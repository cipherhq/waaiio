// #1166 r7 F2 (Owner Q8 A): the emails an admin may tick when blocking a
// customer. lib/customer-email-candidates.ts over an in-memory database, and
// the admin-only route GET /api/admin/customers/suspension/candidates with the
// real requirePlatformAdmin.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';

const f = vi.hoisted(() => ({ role: 'admin' as string, db: null as any }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async () => ({ data: { claims: { sub: 'admin-1', aal: 'aal2', session_id: 'sess-1' } } }),
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    throw new Error(`unexpected rpc ${name}`);
  },
  from: (table: string) => f.db.from(table),
}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));

import { customerEmailCandidates } from '@/lib/customer-email-candidates';
import { GET } from '@/app/api/admin/customers/suspension/candidates/route';

const PHONE = '2348012345678';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const PHONE_USER = '33333333-3333-4333-8333-333333333333';
const NG = 'biz-ng';
const GB = 'biz-gb';

const booking = (over: Record<string, unknown>) => ({
  id: `bk-${Math.random()}`, user_id: null, business_id: NG, guest_phone: '08012345678', guest_email: null,
  channel: 'whatsapp', email_verified_at: null, created_at: '2026-11-01T10:00:00Z', ...over,
});

function seed(extra: { bookings?: any[]; profiles?: any[]; blocks?: string[] } = {}) {
  f.db = createMemoryDb({
    businesses: [{ id: NG, country_code: 'NG' }, { id: GB, country_code: 'GB' }],
    bookings: extra.bookings ?? [],
    profiles: extra.profiles ?? [],
    customer_email_blocks: (extra.blocks ?? []).map(email => ({ email, reason: 'x' })),
  });
}

beforeEach(() => { f.role = 'admin'; seed(); });

describe('customerEmailCandidates (F2)', () => {
  it('labels each booking email by its proof mark or channel, and lists every phone form of the number', async () => {
    seed({ bookings: [
      booking({ guest_email: 'proved@example.com', email_verified_at: '2026-11-20T10:00:00Z', channel: 'web', guest_phone: '+234 801 234 5678' }),
      booking({ guest_email: 'site@example.com', channel: 'web', guest_phone: '2348012345678' }),
      booking({ guest_email: 'biz@example.com', channel: 'dashboard', guest_phone: '0801 234 5678' }),
      booking({ guest_email: 'api@example.com', channel: 'api', guest_phone: '00234 8012345678' }),
      booking({ guest_email: 'wa@example.com', channel: 'whatsapp' }),
      booking({ guest_email: 'none@example.com', channel: null }),
      // Another number, and the same local digits read in another country: not this customer.
      booking({ guest_email: 'other@example.com', guest_phone: '08099999999' }),
      booking({ guest_email: 'uk@example.com', business_id: GB, guest_phone: '08012345678' }),
      // Placeholder login email: never listed.
      booking({ guest_email: '2348012345678@phone.waaiio.com' }),
    ] });
    const list = await customerEmailCandidates(f.db, { phone: PHONE, userId: null });
    expect(Object.fromEntries(list.map(c => [c.email, c.source]))).toEqual({
      'proved@example.com': 'proved', 'site@example.com': 'web', 'biz@example.com': 'dashboard',
      'api@example.com': 'api', 'wa@example.com': 'unrecorded', 'none@example.com': 'unrecorded',
    });
    expect(list.every(c => c.blocked === false)).toBe(true);
    expect(list[0].email).toBe('proved@example.com'); // strongest first
  });

  it('lists account emails: the given user, users on the number’s bookings, and profiles with this phone', async () => {
    seed({
      bookings: [
        booking({ user_id: OTHER_USER, guest_email: null, created_at: '2026-11-05T10:00:00Z' }),
        booking({ user_id: USER, guest_phone: null, created_at: '2026-11-06T10:00:00Z' }),
      ],
      profiles: [
        { id: USER, email: 'Me@Example.com', phone: null },
        { id: OTHER_USER, email: 'other.user@example.com', phone: null },
        { id: PHONE_USER, email: 'phone.match@example.com', phone: '+2348012345678' },
        { id: 'p-local', email: 'local.match@example.com', phone: '08012345678' },
        { id: 'p-else', email: 'someone@example.com', phone: '+2348099999999' },
        { id: 'p-holder', email: '2348012345678@phone.waaiio.com', phone: '2348012345678' },
      ],
    });
    const list = await customerEmailCandidates(f.db, { phone: PHONE, userId: USER });
    expect(list.map(c => [c.email, c.source]).sort()).toEqual([
      ['local.match@example.com', 'account'], ['me@example.com', 'account'],
      ['other.user@example.com', 'account'], ['phone.match@example.com', 'account'],
    ]);
    expect(list.find(c => c.email === 'me@example.com')!.last_seen).toBe('2026-11-06T10:00:00Z');
    expect(list.find(c => c.email === 'other.user@example.com')!.last_seen).toBe('2026-11-05T10:00:00Z');
  });

  it('merges duplicates case-insensitively, keeping the strongest label and the latest date', async () => {
    seed({
      bookings: [
        booking({ guest_email: 'ADA@example.com', channel: 'web', created_at: '2026-11-25T10:00:00Z' }),
        booking({ guest_email: 'ada@example.com', email_verified_at: '2026-11-02T10:00:00Z', created_at: '2026-11-02T10:00:00Z' }),
        booking({ guest_email: ' Bo@example.com ', channel: 'whatsapp', created_at: '2026-11-03T10:00:00Z' }),
        booking({ guest_email: 'bo@example.com', channel: 'dashboard', created_at: '2026-11-04T10:00:00Z' }),
        booking({ user_id: USER, guest_email: 'cy@example.com', channel: 'web' }),
      ],
      profiles: [{ id: USER, email: 'CY@example.com', phone: null }],
    });
    const list = await customerEmailCandidates(f.db, { phone: PHONE, userId: null });
    const by = Object.fromEntries(list.map(c => [c.email, c]));
    expect(Object.keys(by).sort()).toEqual(['ada@example.com', 'bo@example.com', 'cy@example.com']);
    expect(by['ada@example.com']).toMatchObject({ source: 'proved', last_seen: '2026-11-25T10:00:00Z' });
    expect(by['bo@example.com']).toMatchObject({ source: 'dashboard', last_seen: '2026-11-04T10:00:00Z' });
    expect(by['cy@example.com'].source).toBe('account');
  });

  it('marks emails that are already blocked', async () => {
    seed({ bookings: [booking({ guest_email: 'ada@example.com' }), booking({ guest_email: 'bo@example.com' })], blocks: ['bo@example.com'] });
    const list = await customerEmailCandidates(f.db, { phone: PHONE, userId: null });
    expect(Object.fromEntries(list.map(c => [c.email, c.blocked]))).toEqual({ 'ada@example.com': false, 'bo@example.com': true });
  });

  it('with no number, lists only the account email', async () => {
    seed({
      bookings: [booking({ guest_email: 'guest@example.com' }), booking({ user_id: USER, guest_phone: null, guest_email: 'x@example.com' })],
      profiles: [{ id: USER, email: 'me@example.com', phone: null }],
    });
    expect((await customerEmailCandidates(f.db, { phone: null, userId: USER })).map(c => c.email)).toEqual(['me@example.com']);
  });

  it('reads more than one page of bookings', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => booking({ guest_phone: '08099999999', created_at: `2026-11-${String(10 + (i % 15)).padStart(2, '0')}T10:00:00Z` }));
    many.push(booking({ guest_email: 'late@example.com', created_at: '2026-01-01T10:00:00Z' }));
    seed({ bookings: many });
    expect((await customerEmailCandidates(f.db, { phone: PHONE, userId: null })).map(c => c.email)).toEqual(['late@example.com']);
  });

  it('only reads', async () => {
    seed({ bookings: [booking({ guest_email: 'ada@example.com' })] });
    await customerEmailCandidates(f.db, { phone: PHONE, userId: USER });
    expect(f.db.writes).toEqual([]);
  });
});

const get = (qs: string) => GET(new NextRequest(`https://app.test/api/admin/customers/suspension/candidates?${qs}`, {
  headers: { Authorization: 'Bearer good' },
}));

describe('GET /api/admin/customers/suspension/candidates', () => {
  it('returns the candidates to an admin', async () => {
    seed({ bookings: [booking({ guest_email: 'ada@example.com', channel: 'web' })] });
    const res = await get(`phone=${PHONE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [{ email: 'ada@example.com', source: 'web', last_seen: '2026-11-01T10:00:00Z', blocked: false }] });
  });

  it.each(['support', 'finance', 'operations', 'customer'])('refuses %s', async role => {
    f.role = role;
    expect((await get(`phone=${PHONE}`)).status).toBe(403);
  });

  it.each([
    ['a local number', 'phone=08012345678'],
    ['a + number', 'phone=%2B2348012345678'],
    ['a bad user id', 'userId=nope'],
    ['nothing', ''],
  ])('rejects %s with 400', async (_label, qs) => {
    expect((await get(qs)).status).toBe(400);
  });

  it('a failed read is an error, not an empty list', async () => {
    seed({ bookings: [booking({ guest_email: 'ada@example.com' })] });
    f.db.failReads.add('customer_email_blocks');
    const res = await get(`phone=${PHONE}`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Unable to load this customer’s emails');
  });
});
