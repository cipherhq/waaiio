/**
 * #922 — property stays: the bot never creates a stay over taken nights.
 *
 * Behavioural tests of reservation.flow.ts `create_reservation` with a
 * table-aware Supabase fake. The database side (M522 exclusion constraint,
 * two parallel claims) is proved in lib/__tests__/property-stay-no-overlap-522.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';

const initializePayment = vi.fn();
const buildSavedCardOffer = vi.fn();
vi.mock('../shared/payment', () => ({ initializePayment: (...a: unknown[]) => initializePayment(...a) }));
vi.mock('../shared/saved-card-flow', () => ({
  buildSavedCardOffer: (...a: unknown[]) => buildSavedCardOffer(...a),
  handleSavedCardInput: vi.fn(),
}));
vi.mock('../shared/capability-guard', () => ({
  requireCurrentCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../shared/bank-transfer', () => ({
  checkBankTransferEligibility: vi.fn().mockResolvedValue({ qualifies: false, bankAccount: null, platformSettings: {} }),
  createPendingTransfer: vi.fn(),
  formatBankTransferBlock: vi.fn(),
  submitTransferProof: vi.fn(),
  BANK_ONLY_BUTTONS: [],
}));

import { reservationFlow } from '../reservation.flow';

type Result = { data: unknown; error: unknown };

/** What each query returns, plus a record of what the flow asked for. */
function fakeSupabase(opts: {
  stays?: Result;
  blocked?: Result;
  insert?: Result;
  existing?: Result;
}) {
  const calls = { inserts: [] as unknown[], stayChecks: [] as Array<Record<string, unknown>>, blockedChecks: [] as Array<Record<string, unknown>> };

  function chain(table: string) {
    const filters: Record<string, unknown> = {};
    let inserting = false;
    const c: Record<string, any> = {};
    for (const m of ['select', 'update', 'delete', 'neq', 'is', 'order']) c[m] = vi.fn(() => c);
    for (const m of ['eq', 'or', 'in', 'not', 'lt', 'gt', 'gte', 'lte']) {
      c[m] = vi.fn((col: string, ...rest: unknown[]) => { filters[`${m}:${col}`] = rest.length > 1 ? rest : rest[0]; return c; });
    }
    c.insert = vi.fn((payload: unknown) => { inserting = true; calls.inserts.push(payload); return c; });
    c.limit = vi.fn(async () => {
      if (table === 'reservations') { calls.stayChecks.push(filters); return opts.stays ?? { data: [], error: null }; }
      if (table === 'property_blocked_dates') { calls.blockedChecks.push(filters); return opts.blocked ?? { data: [], error: null }; }
      return { data: [], error: null };
    });
    c.single = vi.fn(async () => {
      if (table !== 'reservations') return { data: null, error: null };
      if (inserting) return opts.insert ?? { data: { id: 'res-new', reference_code: 'WA-R1' }, error: null };
      return opts.existing ?? { data: null, error: { code: 'PGRST116' } };
    });
    c.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    // Awaiting an update chain (bot_sessions save) resolves cleanly.
    c.then = (res: (v: Result) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
    return c;
  }

  return {
    client: { from: vi.fn((t: string) => chain(t)), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) },
    calls,
  };
}

function ctxFor(supabase: unknown, sessionData: Record<string, unknown>) {
  return createMockContext({
    supabase: supabase as any,
    session: {
      id: 'sess-1', user_id: 'u1', business_id: 'b1', current_step: 'create_reservation', version: 0,
      session_data: {
        property_id: 'prop-1',
        check_in: '2026-12-10',
        check_out: '2026-12-13',
        nights: 3,
        nightly_rate: 100,
        guests: 2,
        first_name: 'Ada',
        last_name: 'Obi',
        ...sessionData,
      },
    },
    business: {
      id: 'b1', name: 'Test Stays', slug: 'test-stays', category: 'shortlet' as any, flow_type: 'reservation' as any,
      subscription_tier: 'growth', trial_ends_at: new Date(Date.now() + 86400000).toISOString(), metadata: {},
    },
  });
}

const step = getStep(reservationFlow, 'create_reservation');

function expectNotAvailable(messages: any[], d: Record<string, unknown>) {
  expect(messages).toHaveLength(1);
  expect(messages[0].type).toBe('buttons');
  expect(messages[0].body).toBe('Sorry, this property is not available for the selected dates.');
  expect(messages[0].buttons.map((b: any) => b.id)).toEqual(['recovery_change_dates', 'recovery_exit']);
  expect(d.check_in).toBeUndefined();
  expect(d.check_out).toBeUndefined();
  expect(d.nights).toBeUndefined();
  expect(d._availability_checked).toBeUndefined();
  expect(d.property_id).toBe('prop-1');
  expect(d.reservation_id).toBeUndefined();
}

beforeEach(() => {
  initializePayment.mockReset();
  buildSavedCardOffer.mockReset();
});

describe('#922 create_reservation never creates a stay over taken nights', () => {
  it('A4: nights taken while the customer read the terms → no insert, not-available prompt; the second pass reaches the payment link', async () => {
    const stays: Result = { data: [{ id: 'other-stay' }], error: null };
    const { client, calls } = fakeSupabase({ stays });
    // Re-entry after the terms prompt: the early check already ran and set the flag.
    const ctx = ctxFor(client, { _availability_checked: true, _terms_accepted: true, _terms_loop_consumed: true });
    const d = ctx.session.session_data;

    const messages = await step.prompt(ctx);

    expectNotAvailable(messages, d);
    expect(d._terms_accepted).toBeUndefined();
    expect(d._terms_loop_consumed).toBeUndefined();
    expect(d._terms_cancelled).toBeUndefined();
    expect(calls.inserts).toHaveLength(0);
    expect(initializePayment).not.toHaveBeenCalled();
    // The re-check covers every night, legacy service_id rows, every unfinished status,
    // and leaves out this session's own stay.
    expect(calls.stayChecks[0]).toMatchObject({
      'eq:business_id': 'b1',
      'or:property_id.eq.prop-1,service_id.eq.prop-1': undefined,
      'or:bot_session_id.is.null,bot_session_id.neq.sess-1': undefined,
      'not:status': ['in', '(cancelled,no_show,checked_out,completed)'],
      'lt:check_in': '2026-12-13',
      'gt:check_out': '2026-12-10',
    });

    // Choose New Dates → check-in, new dates, then "I Accept & Confirm" again.
    const v = await step.validate!('recovery_change_dates', ctx);
    Object.assign(d, v.data);
    await expect(step.next!(ctx)).resolves.toBe('select_checkin');
    Object.assign(d, { check_in: '2026-12-20', check_out: '2026-12-22', nights: 2 });
    const confirmStep = getStep(reservationFlow, 'reservation_confirmation');
    const c = await confirmStep.validate!('confirm', ctx);
    Object.assign(d, c.data);
    await expect(confirmStep.next!(ctx)).resolves.toBe('collect_name');

    stays.data = [];
    buildSavedCardOffer.mockResolvedValue(null);
    initializePayment.mockResolvedValue({ url: 'https://pay.example/abc', reference: 'pay-ref-1' });
    const second = await step.prompt(ctx);

    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({ check_in: '2026-12-20', check_out: '2026-12-22', total_amount: 200, status: 'pending' });
    expect(initializePayment).toHaveBeenCalledTimes(1);
    expect((second[0] as any).body).toContain('https://pay.example/abc');
    expect(d.payment_reference).toBe('pay-ref-1');
    expect(step.nextAfterPrompt && typeof step.nextAfterPrompt === 'function' ? step.nextAfterPrompt(ctx) : undefined).toBe('reservation_payment');
  });

  it('A6b: double tap — the stay this session just created is not "taken"; the insert reuses it', async () => {
    // The stays query already leaves out this session's rows (bot_session_id filter), so it returns none.
    const { client, calls } = fakeSupabase({
      insert: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_reservations_session_idempotent"' } },
      existing: { data: { id: 'res-mine', reference_code: 'WA-R9' }, error: null },
    });
    buildSavedCardOffer.mockResolvedValue({ display: { id: 'pm-1' }, prompt: { type: 'text', text: 'Use saved card?' } });
    const ctx = ctxFor(client, { _availability_checked: true, _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expect(calls.stayChecks[0]).toMatchObject({ 'or:bot_session_id.is.null,bot_session_id.neq.sess-1': undefined });
    expect(calls.inserts).toHaveLength(1);
    expect(ctx.session.session_data.reservation_id).toBe('res-mine');
    expect(messages).toEqual([{ type: 'text', text: 'Use saved card?' }]);
  });

  it('only the exact 23P01 code is read as "dates taken"', async () => {
    const { client } = fakeSupabase({ insert: { data: null, error: { code: '23P01x', message: 'x' } } });
    const ctx = ctxFor(client, { _terms_accepted: true });
    const messages = await step.prompt(ctx);
    expect(messages).toEqual([{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }]);
  });

  it('A5: insert refused by the M522 constraint (23P01), no same-session stay → not-available prompt, no payment', async () => {
    const { client, calls } = fakeSupabase({
      insert: { data: null, error: { code: '23P01', message: 'conflicting key value violates exclusion constraint' } },
    });
    const ctx = ctxFor(client, { _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expect(calls.inserts).toHaveLength(1);
    expectNotAvailable(messages, ctx.session.session_data);
    expect(initializePayment).not.toHaveBeenCalled();
    expect(buildSavedCardOffer).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).not.toContain('exclusion');
  });

  it('A6: insert error but this session already holds the stay → that stay is reused (unchanged)', async () => {
    const { client, calls } = fakeSupabase({
      insert: { data: null, error: { code: '23P01', message: 'conflict with own retry' } },
      existing: { data: { id: 'res-mine', reference_code: 'WA-R9' }, error: null },
    });
    buildSavedCardOffer.mockResolvedValue({ display: { id: 'pm-1' }, prompt: { type: 'text', text: 'Use saved card?' } });
    const ctx = ctxFor(client, { _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expect(calls.inserts).toHaveLength(1);
    expect(ctx.session.session_data.reservation_id).toBe('res-mine');
    expect(ctx.session.session_data.reference_code).toBe('WA-R9');
    expect(messages).toEqual([{ type: 'text', text: 'Use saved card?' }]);
  });

  it('other insert errors keep the existing generic message', async () => {
    const { client } = fakeSupabase({ insert: { data: null, error: { code: '23503', message: 'fk' } } });
    const ctx = ctxFor(client, { _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expect(messages).toEqual([{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }]);
    expect(ctx.session.session_data.check_in).toBe('2026-12-10');
  });

  it('A7: a blocked range inside the stay → not-available prompt, no insert', async () => {
    const { client, calls } = fakeSupabase({ blocked: { data: [{ id: 'blk-1' }], error: null } });
    const ctx = ctxFor(client, { _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expectNotAvailable(messages, ctx.session.session_data);
    expect(calls.inserts).toHaveLength(0);
    // Blocked nights are date_from..date_to inclusive; the stay's nights are [check_in, check_out).
    // So a block that starts on the check-out day (date_from = check_out) does not match.
    expect(calls.blockedChecks[0]).toMatchObject({
      'eq:property_id': 'prop-1',
      'lt:date_from': '2026-12-13',
      'gte:date_to': '2026-12-10',
    });
  });

  it('free nights → exactly one check and one insert in a single pass', async () => {
    const { client, calls } = fakeSupabase({});
    buildSavedCardOffer.mockResolvedValue({ display: { id: 'pm-1' }, prompt: { type: 'text', text: 'Use saved card?' } });
    const ctx = ctxFor(client, { _terms_accepted: true });

    await step.prompt(ctx);

    expect(calls.stayChecks).toHaveLength(1);
    expect(calls.blockedChecks).toHaveLength(1);
    expect(calls.inserts).toHaveLength(1);
    expect(calls.inserts[0]).toMatchObject({ property_id: 'prop-1', check_in: '2026-12-10', check_out: '2026-12-13', status: 'pending' });
    expect(ctx.session.session_data.reservation_id).toBe('res-new');
  });

  it('pre-insert check that cannot read availability → generic message, no insert', async () => {
    const { client, calls } = fakeSupabase({ stays: { data: null, error: { message: 'timeout' } } });
    const ctx = ctxFor(client, { _availability_checked: true, _terms_accepted: true });

    const messages = await step.prompt(ctx);

    expect(calls.inserts).toHaveLength(0);
    expect(messages).toEqual([{ type: 'text', text: 'Something went wrong on our end. Send *Hi* to start over.' }]);
  });

  it('a retry that reuses an existing stay does not re-check (its own stay would look taken)', async () => {
    const { client, calls } = fakeSupabase({ stays: { data: [{ id: 'res-mine' }], error: null } });
    buildSavedCardOffer.mockResolvedValue({ display: { id: 'pm-1' }, prompt: { type: 'text', text: 'Use saved card?' } });
    const ctx = ctxFor(client, { _availability_checked: true, _terms_accepted: true, reservation_id: 'res-mine', reference_code: 'WA-R9' });

    const messages = await step.prompt(ctx);

    expect(calls.stayChecks).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
    expect(messages).toEqual([{ type: 'text', text: 'Use saved card?' }]);
  });

  it('A8: Choose New Dates → back to check-in with the property kept', async () => {
    const { client } = fakeSupabase({});
    const ctx = ctxFor(client, {});
    const d = ctx.session.session_data;
    for (const k of ['check_in', 'check_out', 'nights']) delete d[k];

    const v = await step.validate!('recovery_change_dates', ctx);
    expect(v).toEqual({ valid: true, data: { _recovery_action: 'change_dates' } });
    Object.assign(d, v.data);

    await expect(step.next!(ctx)).resolves.toBe('select_checkin');
    expect(d.property_id).toBe('prop-1');
    expect(d._recovery_action).toBeUndefined();
  });
});
