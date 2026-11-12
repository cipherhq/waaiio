/**
 * #963 lane 3: a booking the business makes by hand sends the intake form only
 * when "send confirmation to client" is ticked (Owner decision 2026-11-10), and
 * a before-booking form is sent as in after mode. The create-manual handler runs
 * with mocked dependencies (harness pattern from mk3-manual-booking-atomicity).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const deliver = vi.hoisted(() => vi.fn(async () => ({ status: 'sent', intakeId: 'in-1' })));
const mockRpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/intake/send', () => ({ deliverAfterBookingIntake: deliver }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'owner-1' } }, error: null }) } }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert']) c[m] = () => c;
      c.single = async () => ({
        data: table === 'services' ? { name: 'Assessment', price: 0, duration_minutes: 30, max_capacity: 1, buffer_minutes: 0 }
          : table === 'businesses' ? { name: 'Healing Labs', country_code: 'NG' } : null,
        error: null,
      });
      c.maybeSingle = async () => ({ data: { is_class: false }, error: null });
      c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
      return c;
    },
    rpc: (...a: unknown[]) => mockRpc(...a),
  }),
}));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireAnyCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'k' }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ createWhatsAppUser: async () => 'customer-1' }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId() { return null; } } }));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn(), findCustomerEmail: vi.fn() }));
vi.mock('@/lib/email/templates', () => ({ businessNotificationEmail: vi.fn(() => ({ html: '' })) }));

const { POST } = await import('@/app/api/bookings/create-manual/route');

const BODY = {
  businessId: 'biz-1', serviceId: 'svc-1', date: '2027-01-15', time: '10:00',
  customerName: 'Ada Obi', customerPhone: '+2348000000000',
};
const post = (extra: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/bookings/create-manual', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...BODY, ...extra }),
}));

beforeEach(() => {
  deliver.mockClear();
  mockRpc.mockReset();
  mockRpc.mockImplementation((name: string) => {
    if (name === 'quote_booking_tax_980') return { data: { total: 0, deposit: 0, tax_snapshot: null }, error: null };
    const single = async () => ({ data: { booking_id: 'book-1', reference_code: 'REF-001', slot_available: true }, error: null });
    if (name === 'book_manual_slot_authoritative_604') return { single };
    const p = Promise.resolve({ data: null, error: null });
    return Object.assign(p, { single, maybeSingle: async () => ({ data: null, error: null }) });
  });
});

describe('create-manual: intake form and the "send confirmation" tick', () => {
  it('ticked: sends the form for the new booking, before-booking forms included', async () => {
    const res = await post({ sendConfirmation: true });
    expect(res.status).toBe(200);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'book-1', { includeBeforeBooking: true });
  });

  it.each([['unticked', { sendConfirmation: false }], ['not given', {}]])('%s: sends nothing, booking still made', async (_n, extra) => {
    const res = await post(extra);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });
});
