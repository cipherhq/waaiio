/**
 * W14–W16 consumer compatibility. Real flow steps and public handler;
 * synthetic query/provider boundaries only, not live bookings or SQL proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { FlowContext, FlowStepConfig } from '@/lib/bot/flows/types';

const boundary = vi.hoisted(() => ({
  client: null as any,
  payment: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => boundary.client }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: boundary.payment }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: boundary.capabilities }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(async () => null), getRateLimitKey: vi.fn(() => 'synthetic'),
}));
vi.mock('@/lib/otp-token', () => ({ verifyOtpToken: vi.fn(() => 'guest@example.test') }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
vi.mock('@/lib/bot/flows/shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn(), createPendingTransfer: vi.fn(),
  formatBankTransferBlock: vi.fn(), BANK_ONLY_BUTTONS: [],
}));
vi.mock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(), getPaymentGatewayByName: vi.fn() }));
vi.mock('@/lib/payments/saved-payment-adapter', () => ({ savedPaymentAdapter: {} }));
vi.mock('@/lib/bot/receipt-ocr', () => ({ analyzeReceipt: vi.fn(), receiptMatchesExpected: vi.fn() }));

const BIZ = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const SERVICE = '20000000-0000-4000-8000-000000000001';
const A = '30000000-0000-4000-8000-000000000001';
const B = '30000000-0000-4000-8000-000000000002';
const DATE = '2099-01-05';
const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY = dayKeys[new Date(DATE + 'T00:00').getDay()];
type Row = Record<string, any>;
let rows: Record<string, Row[]>;
let reads: Array<{ table: string; filters: Array<[string, string, unknown]> }>;
let rpc: ReturnType<typeof vi.fn>;
let steps: FlowStepConfig[];

function member(id: string, overrides: Row = {}): Row {
  return { id, business_id: BIZ, name: id === A ? 'Alex' : 'Blair', is_active: true,
    services: ['Haircut'], schedule: { [DAY]: { start: '09:00', end: '11:00' } }, ...overrides };
}
function client() {
  return {
    from: (table: string) => {
      const filters: Array<[string, string, unknown]> = [];
      const trace = { table, filters };
      reads.push(trace);
      let head = false;
      const result = (single = false) => {
        const selected = (rows[table] || []).filter(row => filters.every(([kind, key, value]) =>
          kind === 'in' ? (value as unknown[]).includes(row[key]) : row[key] === value));
        return { data: head ? null : single ? selected[0] || null : selected, error: null, count: selected.length };
      };
      const chain: any = {
        select: (_fields: string, options?: { head?: boolean }) => { head = !!options?.head; return chain; },
        eq: (key: string, value: unknown) => { filters.push(['eq', key, value]); return chain; },
        in: (key: string, value: unknown[]) => { filters.push(['in', key, value]); return chain; },
        limit: () => chain, order: () => chain,
        single: async () => result(true), maybeSingle: async () => result(true),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return chain;
    },
    rpc,
  };
}
function context(data: Row = {}): FlowContext {
  return {
    supabase: boundary.client,
    business: rows.businesses[0],
    session: { id: 'synthetic-session', business_id: BIZ, session_data: {
      service_id: SERVICE, service_name: 'Haircut', service_duration: 60, date: DATE,
      _service_requires_staff: true, _service_staff_ids: [A, B],
      _service_allow_staff_selection: false, ...data,
    } },
    from: '+10000000000', sender: { sendText: vi.fn() }, copyLang: 'en',
    intelligence: { resetAbuse: vi.fn() }, t: async (text: string) => text,
  } as unknown as FlowContext;
}
function step(id: string) {
  const found = steps.find(value => value.id === id);
  if (!found) throw new Error('Missing real flow step: ' + id);
  return found;
}
async function publicBooking(extra: Row = {}) {
  const { POST } = await import('@/app/api/bookings/public/create/route');
  return POST(new NextRequest('http://localhost/api/bookings/public/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessSlug: 'synthetic', serviceId: SERVICE, date: DATE,
      time: '10:00', guestName: 'Guest', guestEmail: 'guest@example.test',
      otpToken: 'synthetic-token', ...extra }),
  }));
}
beforeEach(async () => {
  vi.clearAllMocks();
  reads = [];
  rows = {
    businesses: [{ id: BIZ, slug: 'synthetic', status: 'active', name: 'Synthetic',
      country_code: 'US', category: 'salon', metadata: { slot_interval_minutes: 30 },
      operating_hours: {}, owner_id: 'owner', subscription_tier: 'growth' }],
    services: [{ id: SERVICE, business_id: BIZ, name: 'Haircut', is_active: true,
      price: 0, deposit_amount: 0, duration_minutes: 60, buffer_minutes: 0,
      requires_staff: true, staff_ids: [A, B], allow_staff_selection: false,
      max_capacity: 1, metadata: {} }],
    business_staff: [member(A), member(B)],
    profiles: [{ id: 'guest-profile', email: 'guest@example.test' }],
    bookings: [],
  };
  rpc = vi.fn(() => ({
    single: async () => ({ data: { booking_id: 'synthetic-booking',
      reference_code: 'SYNTHETIC', slot_available: true }, error: null }),
  }));
  boundary.client = client();
  boundary.capabilities.mockResolvedValue(['staff', 'scheduling']);
  steps = (await import('@/lib/bot/flows/scheduling.flow')).schedulingFlow.steps;
});

describe('W14–W16 real scheduling consumers', () => {
  it('uses explicit IDs and automatically assigns when customer choice is false', async () => {
    rows.business_staff.push(member('unassigned'));
    const ctx = context();
    expect(await step('select_staff').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.staff_id).toBe(A);
    expect(reads.find(r => r.table === 'business_staff')?.filters).toContainEqual(['in', 'id', [A, B]]);
    expect(reads.find(r => r.table === 'business_staff')?.filters).toContainEqual(['eq', 'is_active', true]);
  });

  it('offers the real picker for multiple eligible staff with shared choice enabled', async () => {
    const ctx = context({ _service_allow_staff_selection: true });
    expect(await step('select_staff').skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data._available_staff).toEqual([{ id: A, name: 'Alex' }, { id: B, name: 'Blair' }]);
    const messages = await step('select_staff').prompt(ctx);
    expect(messages.some(message => message.type === 'list')).toBe(true);
  });

  it('auto-assigns a single eligible staff even when customer choice is true', async () => {
    rows.business_staff = [member(A)];
    const ctx = context({ _service_allow_staff_selection: true });
    expect(await step('select_staff').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.staff_id).toBe(A);
  });

  it('last-removal empty-ID state remains required and uses active legacy fallback', async () => {
    rows.business_staff = [member(A, { services: ['Other'] }), member(B),
      member('inactive', { is_active: false }), member('foreign', { business_id: OTHER })];
    const ctx = context({ _service_staff_ids: [] });
    expect(await step('select_staff').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.staff_id).toBe(B);
    expect(reads.find(r => r.table === 'business_staff')?.filters).toContainEqual(['eq', 'business_id', BIZ]);
  });

  it('retains broader active fallback when no legacy names match', async () => {
    rows.business_staff = [member(A, { services: ['Old label'] }), member(B, { services: ['Other label'] })];
    const ctx = context({ _service_staff_ids: [] });
    expect(await step('select_staff').skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data.staff_id).toBe(A);
  });

  it('does not fallback around an inactive explicit member', async () => {
    rows.business_staff = [member(A, { is_active: false }), member(B)];
    const ctx = context({ _service_staff_ids: [A] });
    expect(await step('select_staff').skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data._staff_unavailable).toBe(true);
    expect(ctx.session.session_data.staff_id).toBeUndefined();
    expect((await step('select_staff').prompt(ctx))[0].type).toBe('buttons');
  });

  it('excludes staff on a different day and blocks a required service', async () => {
    const otherDay = dayKeys[(dayKeys.indexOf(DAY) + 1) % 7];
    rows.business_staff = [member(A, { schedule: { [otherDay]: { start: '09:00', end: '17:00' } } })];
    const ctx = context({ _service_staff_ids: [A] });
    expect(await step('select_staff').skipIf!(ctx)).toBe(false);
    expect(ctx.session.session_data._staff_unavailable).toBe(true);
  });

  it('explicitly optional service skips staff without querying candidates', async () => {
    const ctx = context({ _service_requires_staff: false, _service_staff_ids: [] });
    expect(await step('select_staff').skipIf!(ctx)).toBe(true);
    expect(reads.filter(r => r.table === 'business_staff')).toHaveLength(0);
  });

  it('select_time offers an exact duration fit and excludes a later overflowing slot', async () => {
    const ctx = context({ staff_id: A, _service_staff_ids: [A] });
    const prompts = await step('select_time').prompt(ctx);
    const times = prompts.flatMap(prompt => prompt.type === 'list' ? prompt.items.map(item => item.postbackText) : []);
    expect(times).toContain('10:00');
    expect(times).not.toContain('10:30');
    expect(times).toContain('09:00');
  });

  it('select_time still removes occupied duration-overlapping slots', async () => {
    rows.bookings = [{ id: 'existing', business_id: BIZ, staff_id: A, date: DATE,
      status: 'confirmed', time: '09:00:00', services: { duration_minutes: 60, buffer_minutes: 0 } }];
    const prompts = await step('select_time').prompt(context({ staff_id: A }));
    const times = prompts.flatMap(prompt => prompt.type === 'list' ? prompt.items.map(item => item.postbackText) : []);
    expect(times).not.toContain('09:00');
    expect(times).not.toContain('09:30');
    expect(times).toContain('10:00');
  });
});

describe('W14–W16 actual public POST compatibility', () => {
  it('assigns an explicit eligible staff for the full duration and calls booking authority', async () => {
    const response = await publicBooking();
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('book_slot_atomic', expect.objectContaining({
      p_business_id: BIZ, p_service_id: SERVICE, p_staff_id: A, p_duration: 60,
    }));
    expect(boundary.payment).not.toHaveBeenCalled();
  });

  it('excludes a candidate whose schedule ends before the booking ends', async () => {
    rows.business_staff = [member(A, { schedule: { [DAY]: { start: '09:00', end: '10:30' } } }), member(B)];
    expect((await publicBooking()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('book_slot_atomic', expect.objectContaining({ p_staff_id: B }));
  });

  it('returns409 before booking when no candidate fits the duration', async () => {
    rows.business_staff = [member(A, { schedule: { [DAY]: { start: '09:00', end: '10:30' } } })];
    expect((await publicBooking()).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('empty IDs preserve public fallback without importing the bot legacy-name filter', async () => {
    rows.services[0].staff_ids = [];
    rows.business_staff = [member(A, { services: ['Unrelated legacy name'] }), member(B)];
    expect((await publicBooking()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('book_slot_atomic', expect.objectContaining({ p_staff_id: A }));
  });

  it('excludes foreign and inactive candidates from public fallback', async () => {
    rows.services[0].staff_ids = [];
    rows.business_staff = [member(A, { business_id: OTHER }), member(B, { is_active: false })];
    expect((await publicBooking()).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not substitute unrelated staff for inactive explicit IDs', async () => {
    rows.services[0].staff_ids = [A];
    rows.business_staff = [member(A, { is_active: false }), member(B)];
    expect((await publicBooking()).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps optional service booking unstaffed', async () => {
    rows.services[0].requires_staff = false;
    rows.services[0].staff_ids = [];
    expect((await publicBooking()).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('book_slot_atomic', expect.objectContaining({ p_staff_id: null }));
    expect(reads.filter(r => r.table === 'business_staff')).toHaveLength(0);
  });

  it('preserves class instructor authority instead of auto-assigning a service member', async () => {
    expect((await publicBooking({ classSessionId: 'synthetic-class' })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('book_slot_atomic', expect.objectContaining({
      p_staff_id: null, p_class_session_id: 'synthetic-class',
    }));
    expect(reads.filter(r => r.table === 'business_staff')).toHaveLength(0);
  });

  it('preserves public class/appointment XOR validation', async () => {
    rows.appointments = [{ ...rows.services[0], id: 'appointment' }];
    expect((await publicBooking({ serviceId: undefined, appointmentId: 'appointment',
      classSessionId: 'synthetic-class' })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not turn booking-authority refusal into a successful booking', async () => {
    rpc.mockReturnValue({ single: async () => ({ data: { slot_available: false }, error: null }) });
    expect((await publicBooking()).status).toBe(409);
    expect(boundary.payment).not.toHaveBeenCalled();
  });
});
