/**
 * #963: the public booking endpoint (POST /api/bookings/public/create) and client
 * intake forms (Owner decisions 2026-11-10). The handler runs with mocked
 * dependencies (harness pattern from bk1-public-booking-business-status); the
 * intake library is spied, except toE164.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  service: {} as Record<string, unknown>,
  beforeForm: null as null | { formId: string },
  found: null as null | { id: string; status: string },
  deliver: { status: 'skipped', reason: 'no_after_intake' } as Record<string, unknown>,
  calls: [] as string[],
}));
const spies = vi.hoisted(() => ({
  webBeforeBookingForm: vi.fn(async () => env.beforeForm),
  findWebIntake: vi.fn(async () => env.found),
  linkIntakeToBooking: vi.fn(async () => { env.calls.push('link'); }),
  deliverAfterBookingIntake: vi.fn(async () => env.deliver),
}));
vi.mock('@/lib/intake/send', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/intake/send')>()), ...spies }));

function chain(result: () => { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'gte', 'lte', 'order', 'limit', 'update']) c[m] = () => c;
  c.maybeSingle = async () => result();
  c.single = async () => result();
  c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
  return c;
}
const BUSINESS = {
  id: 'biz-1', name: 'Healing Labs', slug: 'healing', country_code: 'NG', payment_gateway: 'paystack', subscription_tier: 'growth',
  metadata: {}, owner_id: 'owner-1',
  operating_hours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { open: '08:00', close: '18:00' }])),
};
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (t: string) => chain(() => ({ data: t === 'businesses' ? BUSINESS : t === 'services' ? env.service : t === 'profiles' ? { id: 'user-1' } : null, error: null })),
    rpc: () => ({ single: async () => { env.calls.push('book'); return { data: { booking_id: 'bk-1', reference_code: 'REF1', slot_available: true, committed_total: (env.service.price as number) || 0, committed_deposit: (env.service.deposit_amount as number) || 0 }, error: null }; } }),
    auth: { admin: { createUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) } },
  }),
}));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: async () => ({ url: 'https://pay.example/x', reference: 'P1' }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/otp-token', () => ({ verifyOtpToken: () => 'ada@example.com' }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), withContext: () => ({ error: vi.fn() }) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

const INTAKE_ID = '44444444-4444-4444-8444-444444444444';
const future = () => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toISOString().split('T')[0]; };
const SERVICE = { id: 'svc-1', name: 'Assessment', price: 0, deposit_amount: 0, duration_minutes: 30, buffer_minutes: 0, max_capacity: 1, metadata: {}, intake_form_id: 'f1' };
async function book(extra: Record<string, unknown> = {}) {
  const { POST } = await import('@/app/api/bookings/public/create/route');
  const res = await POST(new NextRequest('http://x/api/bookings/public/create', { method: 'POST', body: JSON.stringify({
    businessSlug: 'healing', serviceId: 'svc-1', date: future(), time: '10:00', guestName: 'Ada Obi',
    guestEmail: 'ada@example.com', guestPhone: '+2348012345678', otpToken: 'otp',
    expectedTerms: { price: env.service.price, deposit: env.service.deposit_amount, country: 'NG', quantity: 1 }, ...extra,
  }) }));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  env.service = { ...SERVICE };
  env.beforeForm = null;
  env.found = null;
  env.deliver = { status: 'skipped', reason: 'no_after_intake' };
  env.calls = [];
  Object.values(spies).forEach(s => s.mockClear());
});

describe('public booking: before-booking form', () => {
  it('refuses to book until the form is answered, booking nothing', async () => {
    env.beforeForm = { formId: 'f1' };
    for (const found of [null, { id: INTAKE_ID, status: 'pending' }]) {
      env.found = found;
      const r = await book({ intakeId: INTAKE_ID });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('intake_required');
    }
    expect((await book()).body.code).toBe('intake_required');
    expect(env.calls).toEqual([]);
  });

  it('books once the form is answered, and links the answers to the booking', async () => {
    env.beforeForm = { formId: 'f1' };
    env.found = { id: INTAKE_ID, status: 'submitted' };
    const r = await book({ intakeId: INTAKE_ID });
    expect(r.status).toBe(200);
    expect(spies.findWebIntake).toHaveBeenCalledWith(expect.anything(), { businessId: 'biz-1', serviceId: 'svc-1', formId: 'f1', phone: '+2348012345678', intakeId: INTAKE_ID });
    expect(spies.linkIntakeToBooking).toHaveBeenCalledWith(expect.anything(), 'biz-1', INTAKE_ID, 'bk-1', 'svc-1');
    expect(env.calls).toEqual(['book', 'link']);
  });

  it('links before sending a paid booking to payment', async () => {
    env.service = { ...SERVICE, price: 5000, deposit_amount: 5000 };
    env.beforeForm = { formId: 'f1' };
    env.found = { id: INTAKE_ID, status: 'submitted' };
    const r = await book({ intakeId: INTAKE_ID });
    expect(r.body.paymentUrl).toBeTruthy();
    expect(spies.linkIntakeToBooking).toHaveBeenCalledTimes(1);
    expect(spies.deliverAfterBookingIntake).not.toHaveBeenCalled();
  });
});

describe('public booking: phone and after-booking form', () => {
  it('a service with a form needs the phone number', async () => {
    const r = await book({ guestPhone: undefined });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('phone_required');
    expect(env.calls).toEqual([]);
  });

  it('a service without a form still books without a phone', async () => {
    env.service = { ...SERVICE, intake_form_id: null };
    const r = await book({ guestPhone: undefined });
    expect(r.status).toBe(200);
    expect(spies.webBeforeBookingForm).not.toHaveBeenCalled();
    expect(spies.deliverAfterBookingIntake).not.toHaveBeenCalled();
  });

  it('a free booking returns the emailed form link for the confirmation screen', async () => {
    env.deliver = { status: 'sent', intakeId: 'in-9', url: 'https://www.waaiio.com/intake/tok' };
    const r = await book();
    expect(r.status).toBe(200);
    expect(spies.deliverAfterBookingIntake).toHaveBeenCalledWith(expect.anything(), 'bk-1', { keepIfEmailFails: true });
    expect(r.body.intakeUrl).toBe('https://www.waaiio.com/intake/tok');
  });

  it('a failing intake send never changes the booking result', async () => {
    spies.deliverAfterBookingIntake.mockRejectedValueOnce(new Error('boom'));
    const r = await book();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, bookingId: 'bk-1' });
    expect(r.body.intakeUrl).toBeUndefined();
  });
});
