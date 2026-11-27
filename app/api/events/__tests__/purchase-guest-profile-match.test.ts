/**
 * Guest ticket purchase: existing customers are matched by the
 * OTP-verified email only (Owner decision 2026-11-27, "keep separate").
 *
 * Handler-level tests for POST /api/events/purchase with a mocked Supabase
 * service client. They record every profiles query/update and the user id
 * passed to the purchase RPC and to payment initialisation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockInitializePayment, mockVerifyOtpToken, mockCreateUser } = vi.hoisted(() => ({
  mockInitializePayment: vi.fn(),
  mockVerifyOtpToken: vi.fn(),
  mockCreateUser: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('rl-key'),
}));
vi.mock('@/lib/otp-token', () => ({ verifyOtpToken: mockVerifyOtpToken }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: mockInitializePayment }));
vi.mock('@/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...log, withContext: vi.fn().mockReturnValue(log) } };
});

const VERIFIED_EMAIL = 'buyer@example.com';
const PHONE = '2348012345678';
const NEW_USER_ID = 'new-auth-user';

type ProfileRow = { id: string; email: string | null; phone: string | null };

let profiles: ProfileRow[] = [];
let profileUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

function profilesQuery() {
  const filters: Array<[string, unknown]> = [];
  let pendingUpdate: Record<string, unknown> | null = null;
  const match = () => profiles.filter((p) => filters.every(([col, v]) => (p as any)[col] === v));
  const chain: any = {
    select: () => chain,
    limit: () => chain,
    update: (values: Record<string, unknown>) => {
      pendingUpdate = values;
      return chain;
    },
    eq: (col: string, v: unknown) => {
      filters.push([col, v]);
      if (pendingUpdate) {
        profileUpdates.push({ id: String(v), values: pendingUpdate });
        return Promise.resolve({ data: null, error: null });
      }
      return chain;
    },
    maybeSingle: () => Promise.resolve({ data: match()[0] ?? null, error: null }),
  };
  return chain;
}

function eventsQuery(price: number) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    single: () =>
      Promise.resolve({
        data: {
          id: 'event-1', name: 'Show', price, total_tickets: 100, tickets_sold: 0,
          status: 'published', max_per_order: 10, date: '2099-01-01', time: '19:00',
          businesses: { id: 'biz-1', name: 'Biz', slug: 'biz', country_code: 'NG', payment_gateway: null },
        },
        error: null,
      }),
  };
  return chain;
}

let eventPrice = 5000;

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'profiles') return profilesQuery();
      if (table === 'events') return eventsQuery(eventPrice);
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: [{ tickets_available: true, booking_id: 'booking-1', reference_code: 'REF1' }],
        error: null,
      });
    },
    auth: { admin: { createUser: mockCreateUser } },
  }),
}));

import { POST } from '../purchase/route';

function req(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/events/purchase', {
    method: 'POST',
    body: JSON.stringify({
      eventSlug: 'show', quantity: 2, guestName: 'Ada Buyer',
      guestEmail: VERIFIED_EMAIL, guestPhone: PHONE, otpToken: 'otp', ...overrides,
    }),
  });
}

function purchaseUserId() {
  const call = rpcCalls.find((c) => c.name === 'purchase_tickets_atomic');
  return call?.args.p_user_id;
}

beforeEach(() => {
  profiles = [];
  profileUpdates = [];
  rpcCalls = [];
  eventPrice = 5000;
  mockVerifyOtpToken.mockReset().mockReturnValue(VERIFIED_EMAIL);
  mockInitializePayment.mockReset().mockResolvedValue({ url: 'https://pay.example/x', reference: 'ref-x' });
  mockCreateUser.mockReset().mockImplementation(async ({ email }: { email: string }) => {
    // Mirrors the on_auth_user_created trigger: new profile has email, no phone.
    profiles.push({ id: NEW_USER_ID, email, phone: null });
    return { data: { user: { id: NEW_USER_ID } }, error: null };
  });
});

describe('POST /api/events/purchase — guest profile matching', () => {
  it('(a) phone matches a profile with a different email: profile untouched, purchase goes to a new guest', async () => {
    profiles = [{ id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);

    // The existing profile's email is never changed.
    expect(profileUpdates.filter((u) => u.id === 'existing-other')).toEqual([]);
    expect(profiles.find((p) => p.id === 'existing-other')?.email).toBe('someone-else@example.com');

    // A new guest is created under the verified email and owns the purchase.
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({ email: VERIFIED_EMAIL });
    expect(purchaseUserId()).toBe(NEW_USER_ID);
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ userId: NEW_USER_ID, userEmail: VERIFIED_EMAIL });
    // Only the new guest's own profile is updated (name + verified email).
    expect(profileUpdates).toEqual([
      { id: NEW_USER_ID, values: { first_name: 'Ada', last_name: 'Buyer', email: VERIFIED_EMAIL } },
    ]);
    // The typed phone still goes on the ticket booking, as before.
    expect(rpcCalls[0].args.p_guest_phone).toBe(PHONE);
  });

  it('(a2) phone matches a profile with no email: profile untouched, purchase goes to a new guest', async () => {
    profiles = [{ id: 'existing-noemail', email: null, phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(profileUpdates.filter((u) => u.id === 'existing-noemail')).toEqual([]);
    expect(purchaseUserId()).toBe(NEW_USER_ID);
  });

  it('(b) verified email matches an existing profile: unchanged, purchase attached to it', async () => {
    profiles = [{ id: 'existing-email', email: VERIFIED_EMAIL, phone: null }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(profileUpdates).toEqual([]);
    expect(purchaseUserId()).toBe('existing-email');
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ userId: 'existing-email' });
  });

  it('(b2) verified email match wins over a different profile with the same phone', async () => {
    profiles = [
      { id: 'existing-email', email: VERIFIED_EMAIL, phone: null },
      { id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` },
    ];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(purchaseUserId()).toBe('existing-email');
    expect(profileUpdates).toEqual([]);
  });

  it('(c) brand-new buyer: unchanged, new guest created under the verified email', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({
      email: VERIFIED_EMAIL, email_confirm: true,
      user_metadata: { first_name: 'Ada', last_name: 'Buyer' },
    });
    expect(purchaseUserId()).toBe(NEW_USER_ID);
    expect(profileUpdates).toEqual([
      { id: NEW_USER_ID, values: { first_name: 'Ada', last_name: 'Buyer', email: VERIFIED_EMAIL } },
    ]);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, bookingId: 'booking-1', url: 'https://pay.example/x' });
  });

  it('(c2) brand-new buyer of a free event: success with no payment', async () => {
    eventPrice = 0;
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, free: true });
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(purchaseUserId()).toBe(NEW_USER_ID);
  });

  it('(d) phone matches a profile with the same email (different letter case): reused, not changed', async () => {
    profiles = [{ id: 'existing-same', email: 'Buyer@Example.com', phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(profileUpdates).toEqual([]);
    expect(purchaseUserId()).toBe('existing-same');
  });

  it('amount sent to the RPC and payment is unchanged (unit price x quantity)', async () => {
    profiles = [{ id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` }];
    await POST(req());
    expect(rpcCalls[0].args).toMatchObject({ p_total_amount: 10000, p_expected_price: 5000, p_quantity: 2 });
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ amount: 10000 });
  });
});
