/**
 * Public booking: existing customers are matched by the OTP-verified email
 * only (Owner decision 2026-11-27, "keep separate"; same rule as the event
 * ticket purchase route).
 *
 * Handler-level tests for POST /api/bookings/public/create with a mocked
 * Supabase service client. They record every profiles update and the user id
 * passed to the booking RPC and to payment initialisation.
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
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

const VERIFIED_EMAIL = 'guest@example.com';
const PHONE = '2348012345678';
const NEW_USER_ID = 'new-auth-user';

type ProfileRow = { id: string; email: string | null; phone: string | null };

let profiles: ProfileRow[] = [];
let profileUpdates: Array<{ id: string; values: Record<string, unknown> }> = [];
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let service: Record<string, unknown> = {};

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

function singleRow(row: unknown) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve({ data: row, error: null }),
  };
  return chain;
}

const BUSINESS = {
  id: 'biz-1', name: 'Biz', slug: 'biz', country_code: 'NG', payment_gateway: 'paystack',
  subscription_tier: 'growth', metadata: {}, owner_id: 'owner-1',
  operating_hours: Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map((d) => [d, { open: '08:00', close: '18:00' }]),
  ),
};

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'profiles') return profilesQuery();
      if (table === 'businesses') return singleRow(BUSINESS);
      if (table === 'services') return singleRow(service);
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const price = Number(service.price || 0);
      const deposit = Number(service.deposit_amount || 0);
      if (name === 'quote_booking_tax_980') {
        return Promise.resolve({ data: { total: price, deposit, tax_snapshot: null }, error: null });
      }
      return {
        single: () => Promise.resolve({
          data: { booking_id: 'booking-1', reference_code: 'REF1', slot_available: true, committed_total: price, committed_deposit: deposit },
          error: null,
        }),
      };
    },
    auth: { admin: { createUser: mockCreateUser } },
  }),
}));

import { POST } from '../public/create/route';

const SERVICE = {
  id: 'svc-1', name: 'Haircut', price: 5000, deposit_amount: 2000, duration_minutes: 30, buffer_minutes: 0,
  max_capacity: 1, metadata: {}, requires_staff: false, staff_ids: [], intake_form_id: null,
};

function futureDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().split('T')[0];
}

function req(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/bookings/public/create', {
    method: 'POST',
    body: JSON.stringify({
      businessSlug: 'biz', serviceId: 'svc-1', date: futureDate(), time: '10:00', guestName: 'Ada Guest',
      guestEmail: VERIFIED_EMAIL, guestPhone: PHONE, otpToken: 'otp',
      expectedTerms: { price: service.price, deposit: service.deposit_amount, country: 'NG', quantity: 1 },
      ...overrides,
    }),
  });
}

function bookingCall() {
  return rpcCalls.find((c) => c.name === 'book_slot_authoritative_604');
}

beforeEach(() => {
  profiles = [];
  profileUpdates = [];
  rpcCalls = [];
  service = { ...SERVICE };
  mockVerifyOtpToken.mockReset().mockReturnValue(VERIFIED_EMAIL);
  mockInitializePayment.mockReset().mockResolvedValue({ url: 'https://pay.example/x', reference: 'ref-x' });
  mockCreateUser.mockReset().mockImplementation(async ({ email }: { email: string }) => {
    // Mirrors the on_auth_user_created trigger: new profile has email, no phone.
    profiles.push({ id: NEW_USER_ID, email, phone: null });
    return { data: { user: { id: NEW_USER_ID } }, error: null };
  });
});

describe('POST /api/bookings/public/create — guest profile matching', () => {
  it('(a) phone matches a profile with a different email: profile untouched, booking goes to a new guest', async () => {
    profiles = [{ id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);

    // The existing profile's email is never changed.
    expect(profileUpdates.filter((u) => u.id === 'existing-other')).toEqual([]);
    expect(profiles.find((p) => p.id === 'existing-other')?.email).toBe('someone-else@example.com');

    // A new guest is created under the verified email and owns the booking and payment.
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({ email: VERIFIED_EMAIL });
    expect(bookingCall()?.args.p_user_id).toBe(NEW_USER_ID);
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ userId: NEW_USER_ID, userEmail: VERIFIED_EMAIL });
    // Only the new guest's own profile is updated (name + verified email).
    expect(profileUpdates).toEqual([
      { id: NEW_USER_ID, values: { first_name: 'Ada', last_name: 'Guest', email: VERIFIED_EMAIL } },
    ]);
    // The typed phone and email still go on the booking, as before.
    expect(bookingCall()?.args).toMatchObject({ p_guest_phone: `+${PHONE}`, p_guest_email: VERIFIED_EMAIL });
  });

  it('(a2) phone matches a profile with no email: profile untouched, booking goes to a new guest', async () => {
    profiles = [{ id: 'existing-noemail', email: null, phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(profileUpdates.filter((u) => u.id === 'existing-noemail')).toEqual([]);
    expect(bookingCall()?.args.p_user_id).toBe(NEW_USER_ID);
  });

  it('(b) verified email matches an existing profile: unchanged, booking attached to it', async () => {
    profiles = [{ id: 'existing-email', email: VERIFIED_EMAIL, phone: null }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(profileUpdates).toEqual([]);
    expect(bookingCall()?.args.p_user_id).toBe('existing-email');
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ userId: 'existing-email' });
  });

  it('(b2) verified email match wins over a different profile with the same phone', async () => {
    profiles = [
      { id: 'existing-email', email: VERIFIED_EMAIL, phone: null },
      { id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` },
    ];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(bookingCall()?.args.p_user_id).toBe('existing-email');
    expect(profileUpdates).toEqual([]);
  });

  it('(c) brand-new guest: unchanged, new guest created under the verified email', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
    expect(mockCreateUser.mock.calls[0][0]).toMatchObject({
      email: VERIFIED_EMAIL, email_confirm: true,
      user_metadata: { first_name: 'Ada', last_name: 'Guest' },
    });
    expect(bookingCall()?.args.p_user_id).toBe(NEW_USER_ID);
    expect(profileUpdates).toEqual([
      { id: NEW_USER_ID, values: { first_name: 'Ada', last_name: 'Guest', email: VERIFIED_EMAIL } },
    ]);
    expect(await res.json()).toMatchObject({ success: true, bookingId: 'booking-1', paymentUrl: 'https://pay.example/x' });
  });

  it('(c2) brand-new guest booking a free service: confirmed with no payment', async () => {
    service = { ...SERVICE, price: 0, deposit_amount: 0 };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, bookingId: 'booking-1' });
    expect(mockInitializePayment).not.toHaveBeenCalled();
    expect(bookingCall()?.args.p_user_id).toBe(NEW_USER_ID);
  });

  it('(d) phone matches a profile with the same email (different letter case): reused, not changed', async () => {
    profiles = [{ id: 'existing-same', email: 'Guest@Example.com', phone: `+${PHONE}` }];

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(mockCreateUser).not.toHaveBeenCalled();
    expect(profileUpdates).toEqual([]);
    expect(bookingCall()?.args.p_user_id).toBe('existing-same');
  });

  it('amounts sent to the booking RPC and payment are unchanged', async () => {
    profiles = [{ id: 'existing-other', email: 'someone-else@example.com', phone: `+${PHONE}` }];
    await POST(req());
    expect(bookingCall()?.args).toMatchObject({
      p_total_amount: 5000, p_deposit_amount: 2000, p_deposit_status: 'pending', p_status: 'pending', p_party_size: 1,
    });
    expect(mockInitializePayment.mock.calls[0][1]).toMatchObject({ amount: 2000, gatewayOverride: 'paystack', businessId: 'biz-1' });
  });
});
