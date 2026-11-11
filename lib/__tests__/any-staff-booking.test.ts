/**
 * "Any available" staff on a service that requires staff (TestBiz "Lashes Refil", staging 10 Nov 2026).
 *
 * book_slot_atomic refuses a booking with no staff member for a requires_staff service and
 * answers exactly like a full slot, so the bot said "this time slot just got booked".
 * create_booking now offers the time to each staff member shown on the staff step, least busy
 * first, through the same booking function, until one is accepted.
 *
 * Real select_staff / create_booking steps; the booking function is a mock that answers like
 * the live one (slot_available false = refused). The database checks themselves (staff schedule,
 * per-staff capacity, buffer, slot lock) are unchanged by this fix and are not re-tested here.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowContext, PromptMessage } from '@/lib/bot/flows/types';
import { getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const JOHN = { id: 'staff-john', name: 'John Doe' };
const JONATHAN = { id: 'staff-jonathan', name: 'Jonathan Lee' };
const SAT = '2026-11-07';
const TAKEN = 'Sorry, this time slot just got booked. Please choose another time.';
const SLOT_RPC = 'book_slot_authoritative_604';
const PKG_RPC = 'book_with_package_authoritative_604';

type Row = { date: string; time: string; staff_id: string | null; metadata: null; services: { duration_minutes: number; buffer_minutes: number }; seating_resource_id: null };
interface DbOpts {
  /** Existing bookings on the day (used for the least-busy order and the time list). */
  bookings?: Row[];
  /** The booking this bot session already made, if any (bot_session_id lookup). */
  sessionBooking?: { staff_id: string | null } | null;
  /** Active package enrollments for the customer (package path). */
  enrollments?: unknown[];
  /** Answers per staff id tried: 'accept' | 'refuse' | 'error'. Missing = refuse. */
  answers: Record<string, 'accept' | 'refuse' | 'error'>;
  pkg?: boolean;
}

function mockDb(opts: DbOpts) {
  const from = vi.fn((table: string) => {
    const ops: Array<[string, ...unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'gt', 'gte', 'lt', 'lte', 'order', 'limit', 'range']) {
      chain[m] = vi.fn((...args: unknown[]) => { ops.push([m, ...args]); return chain; });
    }
    const has = (col: string) => ops.some(([op, c]) => op === 'eq' && c === col);
    const rows = (): unknown[] => {
      if (table === 'package_enrollments') return opts.enrollments || [];
      if (table !== 'bookings') return [];
      return (opts.bookings || []).filter(b => ops.every(([op, col, val]) => {
        if (op === 'eq' && col === 'date') return b.date === val;
        if (op === 'gte' && col === 'date') return b.date >= (val as string);
        if (op === 'lte' && col === 'date') return b.date <= (val as string);
        if (op === 'eq' && col === 'staff_id') return b.staff_id === val;
        return true;
      }));
    };
    // The post-commit readback returns the row as the booking function stored it
    chain.single = vi.fn(async () => ({
      data: table === 'bookings' && lastAccepted ? {
        id: 'bk-new', service_id: 'svc-lash', appointment_id: null, party_size: 1, date: SAT, time: '10:00:00',
        class_session_id: null, staff_id: lastAccepted, total_amount: opts.pkg ? 500000 : 0, deposit_amount: 0,
      } : null,
      error: null,
    }));
    chain.maybeSingle = vi.fn(async () => ({
      data: table === 'bookings' && has('bot_session_id') ? (opts.sessionBooking ?? null) : null, error: null,
    }));
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const data = rows();
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve, reject);
    };
    return chain;
  });
  let lastAccepted: string | null = null;
  const answer = (staffId: string | null) => opts.answers[staffId ?? 'none'] ?? 'refuse';
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => {
    if (name === 'update_session_cas') return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    const staffId = (params.p_staff_id as string | null) ?? null;
    if (name === SLOT_RPC) {
      const a = answer(staffId);
      if (a === 'accept') lastAccepted = staffId;
      return {
        single: async () => a === 'error'
          ? { data: null, error: { code: 'P0001', message: 'terms_changed' } }
          : { data: a === 'accept' ? { booking_id: 'bk-new', reference_code: 'REF1', slot_available: true } : { booking_id: null, reference_code: null, slot_available: false }, error: null },
      };
    }
    if (name === PKG_RPC) {
      const a = answer(staffId);
      if (a === 'accept') lastAccepted = staffId;
      if (a === 'error') return Promise.resolve({ data: null, error: { code: 'P0001', message: 'package_unavailable' } });
      return Promise.resolve({ data: a === 'accept'
        ? { success: true, booking_id: 'bk-new', reference_code: 'REF1', slot_available: true }
        : { success: false, slot_available: false, reason: 'slot_full' }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });
  return { client: { from, rpc } };
}

function ctxFor(db: ReturnType<typeof mockDb>, sessionData: Record<string, unknown> = {}): FlowContext {
  return {
    supabase: db.client as never,
    sender: { sendText: vi.fn() } as never,
    standalone: {
      getBotTemplates: vi.fn(async () => ({})),
      checkTierLimits: vi.fn(async () => ({ allowed: true })),
      // The real fillTemplate always returns text; a staff name is appended to it
      fillTemplate: vi.fn((t?: string) => t ?? 'Booked!\nRef: REF1'),
    } as never,
    intelligence: { resetAbuse: vi.fn() } as never,
    t: async (s: string) => s,
    copyLang: 'en',
    from: '+12404844862',
    session: {
      id: 'sess-any', user_id: 'user-1', business_id: 'biz-test', current_step: 'create_booking', version: 1,
      session_data: {
        first_name: 'Ada', last_name: 'Obi', party_size: 1,
        active_capability: 'scheduling',
        service_id: 'svc-lash', service_name: 'Lashes Refil', service_price: 0, service_deposit: 0,
        service_duration: 30, _service_max_capacity: 1, _service_buffer_minutes: 0, _service_available_days: [],
        _service_requires_staff: true, _service_staff_ids: [JOHN.id, JONATHAN.id], _service_allow_staff_selection: true,
        _available_staff: [JOHN, JONATHAN],
        date: SAT, time: '10:00', _action: 'confirm',
        ...sessionData,
      },
    },
    business: {
      id: 'biz-test', name: 'TestBiz', slug: 'testbiz', category: 'salon' as never,
      flow_type: 'scheduling' as never, subscription_tier: 'growth', trial_ends_at: '',
      country_code: 'NG', operating_hours: { saturday: { open: '09:00', close: '17:00' } },
      metadata: { require_terms_before_payment: false },
    },
  };
}

async function steps() {
  const { schedulingFlow } = await import('@/lib/bot/flows/scheduling.flow');
  return { staff: getStep(schedulingFlow, 'select_staff'), create: getStep(schedulingFlow, 'create_booking') };
}

const claims = (db: ReturnType<typeof mockDb>, name = SLOT_RPC) =>
  db.client.rpc.mock.calls.filter(([n]) => n === name).map(([, p]) => (p as Record<string, unknown>).p_staff_id);
const texts = (msgs: PromptMessage[]) => JSON.stringify(msgs);
const row = (staff_id: string | null): Row => ({
  date: SAT, time: '15:00:00', staff_id, metadata: null, services: { duration_minutes: 30, buffer_minutes: 0 }, seating_resource_id: null,
});

beforeAll(async () => { await import('@/lib/bot/flows/registry'); }, 60_000);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
  vi.spyOn(await import('@/lib/capabilities/service'), 'getEnabledCapabilities').mockResolvedValue(['staff'] as never);
  vi.spyOn(await import('@/lib/tier-limits'), 'checkTierLimit').mockResolvedValue({ allowed: true } as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/capability-guard'), 'requireCurrentCapability').mockResolvedValue({ allowed: true } as never);
  vi.spyOn(await import('@/lib/integrations/google-calendar'), 'syncBookingToCalendar').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/automation/rules-engine'), 'evaluateRules').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/automation/sequence-service'), 'triggerSequences').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/notifications'), 'createNotification').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/notify-owner'), 'notifyOwnerNewBooking').mockResolvedValue(undefined as never);
  vi.spyOn(await import('@/lib/bot/flows/shared/post-completion'), 'handlePostCompletion').mockResolvedValue(undefined as never);
  const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
  vi.spyOn(savedPaymentAdapter, 'getSavedMethods').mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('select_staff — what "Any available" and a named pick store', () => {
  it('"Any available" (tapped or typed) drops a staff member kept from an earlier pass', async () => {
    const { staff } = await steps();
    for (const input of ['staff_any', 'any', 'anyone']) {
      const ctx = ctxFor(mockDb({ answers: {} }), { staff_id: JOHN.id, staff_name: JOHN.name });
      const r = await staff.validate(input, ctx);
      expect(r).toEqual({ valid: true, data: { staff_id: null, staff_name: null, _staff_any: true } });
    }
  });

  it('a named staff member (tapped or typed) clears "Any available"', async () => {
    const { staff } = await steps();
    const ctx = ctxFor(mockDb({ answers: {} }), { _staff_any: true });
    expect(await staff.validate(`staff_${JONATHAN.id}`, ctx))
      .toEqual({ valid: true, data: { staff_id: JONATHAN.id, staff_name: JONATHAN.name, _staff_any: false } });
    expect(await staff.validate('Jonathan', ctx))
      .toEqual({ valid: true, data: { staff_id: JONATHAN.id, staff_name: JONATHAN.name, _staff_any: false } });
  });

  it('a new pass through the step (e.g. after "Change date") forgets an earlier "Any available"', async () => {
    const { staff } = await steps();
    const ctx = ctxFor(mockDb({ answers: {} }), { _staff_any: true, _service_requires_staff: false });
    expect(await staff.skipIf!(ctx)).toBe(true);
    expect(ctx.session.session_data).not.toHaveProperty('_staff_any');
  });

  it('a capability switch clears "Any available"', async () => {
    const { clearStaleCapabilityState } = await import('@/lib/bot/flows/shared/capability-transition');
    const data: Record<string, unknown> = { _staff_any: true, staff_id: null };
    clearStaleCapabilityState(data, 'scheduling', 'appointment');
    expect(data).not.toHaveProperty('_staff_any');
  });
});

describe('create_booking — "Any available" on a service that requires staff', () => {
  it('named staff: one call with that staff member, as before', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { [JOHN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: JOHN.id, staff_name: JOHN.name, _staff_any: false });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JOHN.id]);
    expect(texts(msgs)).not.toContain(TAKEN);
    expect(ctx.session.session_data).toMatchObject({ booking_id: 'bk-new', staff_id: JOHN.id });
  });

  it('named staff refused: the time list again, no other staff member is tried', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { [JOHN.id]: 'refuse', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: JOHN.id, staff_name: JOHN.name, _staff_any: false });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JOHN.id]);
    expect((msgs[0] as { text?: string }).text).toBe(TAKEN);
  });

  it('any staff: the least busy staff member that day is tried first and booked', async () => {
    const { create } = await steps();
    const db = mockDb({ bookings: [row(JOHN.id)], answers: { [JOHN.id]: 'accept', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JONATHAN.id]);
    expect(texts(msgs)).not.toContain(TAKEN);
    expect(ctx.session.session_data).toMatchObject({ booking_id: 'bk-new', staff_id: JONATHAN.id, staff_name: JONATHAN.name });
  });

  it('any staff, first one unavailable at that time (refused by the booking function): the next one is booked', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { [JOHN.id]: 'refuse', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JOHN.id, JONATHAN.id]);
    expect(texts(msgs)).not.toContain(TAKEN);
    expect(ctx.session.session_data).toMatchObject({ booking_id: 'bk-new', staff_id: JONATHAN.id, staff_name: JONATHAN.name });
  });

  it('any staff, availability changed before the commit (every staff member now refused): "time taken" and the time list, no staff kept', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { [JOHN.id]: 'refuse', [JONATHAN.id]: 'refuse' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JOHN.id, JONATHAN.id]);
    expect((msgs[0] as { text?: string }).text).toBe(TAKEN);
    expect(ctx.session.session_data.staff_id).toBeNull();
    expect(ctx.session.session_data.staff_name).toBeNull();
    expect(ctx.session.session_data).not.toHaveProperty('booking_id');
  });

  it('never books without staff: no call is made with an empty staff member', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { none: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    await create.prompt(ctx);
    expect(claims(db)).not.toContain(null);
  });

  it('an error that is not a refusal stops at once (no other staff member is tried)', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { [JOHN.id]: 'error', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    const msgs = await create.prompt(ctx);
    expect(claims(db)).toEqual([JOHN.id]);
    expect(texts(msgs)).not.toContain(TAKEN);
    expect(ctx.session.session_data).not.toHaveProperty('booking_id');
  });

  it('a booking this session already made is retried with its own staff member only (same request, no intent change)', async () => {
    const { create } = await steps();
    const db = mockDb({ sessionBooking: { staff_id: JONATHAN.id }, answers: { [JOHN.id]: 'accept', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true });
    await create.prompt(ctx);
    expect(claims(db)).toEqual([JONATHAN.id]);
    expect(ctx.session.session_data).toMatchObject({ booking_id: 'bk-new', staff_id: JONATHAN.id });
  });

  it('a service that does not require staff keeps "Any available" as no staff member (one call, as before)', async () => {
    const { create } = await steps();
    const db = mockDb({ answers: { none: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true, _service_requires_staff: false });
    await create.prompt(ctx);
    expect(claims(db)).toEqual([null]);
  });

  it('package booking: refused for the first staff member (slot_full), booked with the next', async () => {
    const { create } = await steps();
    const enrollment = {
      id: 'enr-1', package_id: 'pkg-1', sessions_total: 5, sessions_used: 0, expires_at: null, is_active: true,
      service_packages: { id: 'pkg-1', service_ids: ['svc-lash'], is_active: true },
    };
    const db = mockDb({ pkg: true, enrollments: [enrollment], answers: { [JOHN.id]: 'refuse', [JONATHAN.id]: 'accept' } });
    const ctx = ctxFor(db, { staff_id: null, staff_name: null, _staff_any: true, service_price: 500000 });
    const msgs = await create.prompt(ctx);
    expect(claims(db, PKG_RPC)).toEqual([JOHN.id, JONATHAN.id]);
    expect(claims(db, SLOT_RPC)).toEqual([]);
    expect(texts(msgs)).not.toContain(TAKEN);
    expect(ctx.session.session_data).toMatchObject({ staff_id: JONATHAN.id, _package_covered: true });
  });
});
