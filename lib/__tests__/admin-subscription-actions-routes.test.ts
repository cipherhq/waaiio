// Owner decisions 2026-11-18: admin money actions on subscriptions.
//
// POST /api/admin/subscriptions (stop a Waaiio plan's renewal, extend a Free
// business's feature trial) and POST /api/admin/recurring (pause, resume,
// cancel, retry a merchant customer's recurring payment), with the real
// requirePlatformAdmin, the real consumeStepUp and the real logAdminAudit over
// an in-memory database. Only Supabase Auth and the gateways are synthetic:
// no network call is made. Proves the wrong-business, double-click, race,
// missing-key and provider-failure cases for each action.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb } from './helpers/memory-db';
import { hashOperationParams } from '@/lib/admin-step-up';

const f = vi.hoisted(() => ({
  role: 'admin' as string, db: null as any,
  // Runs inside a gateway call, to simulate a concurrent change.
  during: null as null | (() => void | Promise<void>),
  gateway: {} as Record<string, Mock<(...args: unknown[]) => Promise<boolean>>>,
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  auth: {
    getClaims: async (token: string) => token === 'good'
      ? { data: { claims: { sub: 'admin-1', aal: 'aal2', session_id: 'sess-1' } } } : { error: new Error('invalid') },
    getUser: async () => ({ data: { user: { id: 'admin-1', email: 'a@x.test', app_metadata: { role: f.role } } } }),
  },
  rpc: (name: string) => {
    if (name === 'check_session_exists') return { maybeSingle: async () => ({ data: { session_exists: true }, error: null }) };
    throw new Error(`unexpected rpc ${name}`);
  },
  from: (table: string) => f.db.from(table),
}) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: () => { throw new Error('cookie client not expected'); } }));

function gatewayFn(name: string) {
  return async (...args: unknown[]) => {
    const fn = f.gateway[name];
    const during = f.during;
    f.during = null;
    await during?.();
    return fn(...args);
  };
}
vi.mock('@/lib/payments/paystack-recurring', () => ({
  cancelSubscription: gatewayFn('paystackDisable'),
  enableSubscription: gatewayFn('paystackEnable'),
}));
vi.mock('@/lib/payments/stripe-recurring', () => ({
  cancelSubscription: gatewayFn('stripeCancelNow'),
  cancelSubscriptionAtPeriodEnd: gatewayFn('stripeCancelAtPeriodEnd'),
  pauseSubscription: gatewayFn('stripePause'),
  resumeSubscription: gatewayFn('stripeResume'),
}));

import * as subscriptions from '@/app/api/admin/subscriptions/route';
import * as recurring from '@/app/api/admin/recurring/route';

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '44444444-4444-4444-8444-444444444444';
const SUB = '22222222-2222-4222-8222-222222222222';
const CSUB = '33333333-3333-4333-8333-333333333333';
const PERIOD_END = '2026-12-18T00:00:00.000Z';
const DAY = 86_400_000;
const future = () => new Date(Date.now() + 120_000).toISOString();

let grants = 0;
/**
 * Double click: the second request arrives while the first is inside its
 * gateway call (or, for retry, before it). Returns both statuses.
 */
async function doubleClick(send: () => Promise<Response>, viaGateway = true): Promise<number[]> {
  let second: number | undefined;
  if (viaGateway) {
    f.during = async () => { second = (await send()).status; };
    const first = (await send()).status;
    return [first, second!].sort();
  }
  const [a, b] = [await send(), await send()];
  return [a.status, b.status].sort();
}

/** Record a verified step-up for exactly this operation; returns its id. */
function grant(targetId: string, params: Record<string, unknown>): string {
  const id = `su-${++grants}`;
  f.db.tables.admin_step_up_authorizations.push({
    id, admin_user_id: 'admin-1', session_id: 'sess-1', action_type: 'subscription_admin_action', target_id: targetId,
    params_hash: hashOperationParams(params), verified_at: new Date().toISOString(), consumed_at: null, expires_at: future(),
  });
  return id;
}

const req = (path: string, body: unknown, token = 'good') => new NextRequest(`https://app.test${path}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const calls = () => Object.fromEntries(Object.entries(f.gateway).map(([k, v]) => [k, v.mock.calls.length]).filter(([, n]) => n));
const audits = () => f.db.tables.admin_audit_logs.filter((a: any) => a.action !== 'step_up_consumed');
const row = (table: string, id: string) => f.db.tables[table].find((r: any) => r.id === id);

beforeEach(() => {
  f.role = 'admin'; f.during = null; grants = 0;
  f.gateway = Object.fromEntries(['paystackDisable', 'paystackEnable', 'stripeCancelNow', 'stripeCancelAtPeriodEnd', 'stripePause', 'stripeResume']
    .map(n => [n, vi.fn(async (..._args: unknown[]) => true)]));
  vi.stubEnv('PAYSTACK_SECRET_KEY', 'sk_test_synthetic');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic');
  f.db = createMemoryDb({
    admin_step_up_authorizations: [], admin_audit_logs: [],
    businesses: [
      { id: BIZ, subscription_tier: 'free', feature_trial_ends_at: new Date(Date.now() + 3 * DAY).toISOString() },
      { id: OTHER_BIZ, subscription_tier: 'growth', feature_trial_ends_at: null },
    ],
    subscriptions: [{
      id: SUB, business_id: BIZ, status: 'active', plan: 'growth', gateway: 'paystack', stripe_subscription_id: null,
      paystack_subscription_code: 'SUB_synthetic', metadata: { email_token: 'tok_synthetic' }, cancelled_at: null,
      cancellation_reason: null, current_period_end: PERIOD_END,
    }],
    subscription_payments: [],
    customer_subscriptions: [{
      id: CSUB, business_id: BIZ, gateway: 'stripe', gateway_subscription_code: 'sub_synthetic', status: 'active',
      metadata: {}, failure_count: 0, authorization_code: null, cancellation_requested_at: null, paused_at: null, cancelled_at: null,
    }],
  });
});

// ── Stop a Waaiio plan's renewal ──

describe('POST /api/admin/subscriptions stop_renewal', () => {
  const body = (stepUpId: string, extra: Record<string, unknown> = {}) =>
    ({ action: 'stop_renewal', subscriptionId: SUB, businessId: BIZ, reason: 'Merchant asked to stop', stepUpId, ...extra });
  const bound = () => grant(SUB, { action: 'stop_renewal', businessId: BIZ, reason: 'Merchant asked to stop' });
  const send = (b: unknown) => subscriptions.POST(req('/api/admin/subscriptions', b));

  it('Paystack: disables renewal, keeps the plan to the period end, audits', async () => {
    const res = await send(body(bound()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renewalStopped: true, paidUntil: PERIOD_END, auditRecorded: true });
    expect(f.gateway.paystackDisable).toHaveBeenCalledWith('SUB_synthetic', 'tok_synthetic');
    expect(calls()).toEqual({ paystackDisable: 1 });
    expect(row('subscriptions', SUB)).toMatchObject({ status: 'active', cancelled_at: expect.any(String), cancellation_reason: 'Merchant asked to stop' });
    expect(audits()).toEqual([expect.objectContaining({
      actor_id: 'admin-1', action: 'admin_subscription_stop_renewal', entity_type: 'subscription', entity_id: SUB,
      details: expect.objectContaining({ business_id: BIZ, gateway: 'paystack', reason: 'Merchant asked to stop', paid_until: PERIOD_END }),
    })]);
  });

  it('Stripe: cancels at the period end, never immediately', async () => {
    Object.assign(row('subscriptions', SUB), { gateway: 'stripe', stripe_subscription_id: 'sub_platform', paystack_subscription_code: null });
    const res = await send(body(bound()));
    expect(res.status).toBe(200);
    expect(f.gateway.stripeCancelAtPeriodEnd).toHaveBeenCalledWith('sub_platform');
    expect(calls()).toEqual({ stripeCancelAtPeriodEnd: 1 });
    expect(row('subscriptions', SUB).status).toBe('active');
  });

  it('refuses a support or finance admin before any gateway call', async () => {
    for (const role of ['support', 'finance', 'operations']) {
      f.role = role;
      expect((await send(body(bound()))).status).toBe(403);
    }
    expect(calls()).toEqual({});
  });

  it('refuses without a step-up, or with one bound to a different reason', async () => {
    expect((await send(body(''))).status).toBe(403);
    const res = await send(body(bound(), { reason: 'Something else entirely' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('step_up_required');
    expect(calls()).toEqual({});
    expect(row('subscriptions', SUB).cancelled_at).toBeNull();
  });

  it('wrong business: 404, nothing at the gateway', async () => {
    const id = grant(SUB, { action: 'stop_renewal', businessId: OTHER_BIZ, reason: 'Merchant asked to stop' });
    const res = await send(body(id, { businessId: OTHER_BIZ }));
    expect(res.status).toBe(404);
    expect(calls()).toEqual({});
    expect(row('subscriptions', SUB).cancelled_at).toBeNull();
    expect(audits()).toEqual([]);
  });

  it('double click with the same step-up: the second is refused, the gateway is called once', async () => {
    const id = bound();
    expect(await doubleClick(() => send(body(id)))).toEqual([200, 403]);
    expect(calls()).toEqual({ paystackDisable: 1 });
  });

  it('a second confirmed request after it is done: 409, no second gateway call', async () => {
    expect((await send(body(bound()))).status).toBe(200);
    const res = await send(body(bound()));
    expect(res.status).toBe(409);
    expect(calls()).toEqual({ paystackDisable: 1 });
  });

  it('a concurrent change during the gateway call: 409, reported and audited as a conflict', async () => {
    f.during = () => { row('subscriptions', SUB).cancelled_at = '2026-11-18T10:00:00Z'; };
    const res = await send(body(bound()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ providerChanged: true });
    expect(audits()).toEqual([expect.objectContaining({ details: expect.objectContaining({ local_update: 'conflict' }) })]);
  });

  it('missing gateway key: 503, never a fake success', async () => {
    vi.stubEnv('PAYSTACK_SECRET_KEY', '');
    const res = await send(body(bound()));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('GATEWAY_NOT_CONFIGURED');
    expect(calls()).toEqual({});
    expect(row('subscriptions', SUB).cancelled_at).toBeNull();
  });

  it('provider refuses or throws: 502, nothing changed, nothing audited', async () => {
    f.gateway.paystackDisable.mockResolvedValueOnce(false);
    expect((await send(body(bound()))).status).toBe(502);
    f.gateway.paystackDisable.mockRejectedValueOnce(new Error('timeout'));
    expect((await send(body(bound()))).status).toBe(502);
    expect(row('subscriptions', SUB).cancelled_at).toBeNull();
    expect(audits()).toEqual([]);
  });

  it('refuses Flutterwave plans, missing email tokens and ended plans without a gateway call', async () => {
    Object.assign(row('subscriptions', SUB), { gateway: 'flutterwave' });
    expect((await send(body(bound()))).status).toBe(422);
    Object.assign(row('subscriptions', SUB), { gateway: 'paystack', metadata: {} });
    expect((await send(body(bound()))).status).toBe(422);
    Object.assign(row('subscriptions', SUB), { metadata: { email_token: 'tok' }, status: 'cancelled' });
    expect((await send(body(bound()))).status).toBe(409);
    expect(calls()).toEqual({});
  });

  it('requires a reason', async () => {
    expect((await send(body(bound(), { reason: ' ' }))).status).toBe(400);
  });
});

// ── Extend the feature trial ──

describe('POST /api/admin/subscriptions extend_trial', () => {
  const body = (stepUpId: string, days = 7, businessId = BIZ) => ({ action: 'extend_trial', businessId, days, stepUpId });
  const bound = (days = 7, businessId = BIZ) => grant(businessId, { action: 'extend_trial', businessId, days });
  const send = (b: unknown) => subscriptions.POST(req('/api/admin/subscriptions', b));
  // The default fixture's plan row is paid; these businesses have never paid.
  beforeEach(() => { row('subscriptions', SUB).plan = 'free'; });

  it('adds the days to a running trial, touches no billing, audits', async () => {
    const before = row('businesses', BIZ).feature_trial_ends_at;
    const res = await send(body(bound()));
    expect(res.status).toBe(200);
    const after = row('businesses', BIZ).feature_trial_ends_at;
    expect(new Date(after).getTime() - new Date(before).getTime()).toBe(7 * DAY);
    expect(await res.json()).toEqual({ trialEndsAt: after, auditRecorded: true });
    expect(calls()).toEqual({});
    expect(row('subscriptions', SUB).cancelled_at).toBeNull();
    expect(audits()).toEqual([expect.objectContaining({
      action: 'admin_extend_feature_trial', entity_type: 'business', entity_id: BIZ,
      details: { days_added: 7, previous_trial_end: before, new_trial_end: after },
    })]);
  });

  it('an ended trial is extended from now', async () => {
    row('businesses', BIZ).feature_trial_ends_at = '2026-01-01T00:00:00.000Z';
    const res = await send(body(bound(5, BIZ), 5));
    expect(res.status).toBe(200);
    expect(Math.abs(new Date(row('businesses', BIZ).feature_trial_ends_at).getTime() - (Date.now() + 5 * DAY))).toBeLessThan(10_000);
  });

  it('allows 1 to 30 whole days only', async () => {
    for (const days of [0, 31, 1.5, -3, '7']) {
      expect((await send({ action: 'extend_trial', businessId: BIZ, days, stepUpId: 'x' })).status).toBe(400);
    }
  });

  it('refuses a paying business, one that paid before, or one with a paid plan row', async () => {
    expect((await send(body(bound(7, OTHER_BIZ), 7, OTHER_BIZ))).status).toBe(409);
    f.db.tables.subscription_payments.push({ id: 'p1', business_id: BIZ, status: 'success', amount: 5000 });
    expect((await send(body(bound()))).status).toBe(409);
    f.db.tables.subscription_payments = [{ id: 'p2', business_id: BIZ, status: 'failed', amount: 5000 }];
    row('subscriptions', SUB).plan = 'growth';
    expect((await send(body(bound()))).status).toBe(409);
  });

  it('a business that never paid passes the check (failed and zero payments do not count)', async () => {
    f.db.tables.subscription_payments = [
      { id: 'p2', business_id: BIZ, status: 'failed', amount: 5000 },
      { id: 'p3', business_id: BIZ, status: 'success', amount: 0 },
      { id: 'p4', business_id: OTHER_BIZ, status: 'success', amount: 5000 },
    ];
    expect((await send(body(bound()))).status).toBe(200);
  });

  it('double click with the same step-up extends once', async () => {
    const before = new Date(row('businesses', BIZ).feature_trial_ends_at).getTime();
    const id = bound();
    expect(await doubleClick(() => send(body(id)), false)).toEqual([200, 403]);
    expect(new Date(row('businesses', BIZ).feature_trial_ends_at).getTime() - before).toBe(7 * DAY);
  });

  it('a trial changed between read and write: 409, no lost update', async () => {
    const db = f.db;
    const original = db.from.bind(db);
    let reads = 0;
    db.from = (table: string) => {
      if (table === 'subscriptions' && ++reads === 1) row('businesses', BIZ).feature_trial_ends_at = '2027-01-01T00:00:00.000Z';
      return original(table);
    };
    const res = await send(body(bound()));
    expect(res.status).toBe(409);
    expect(row('businesses', BIZ).feature_trial_ends_at).toBe('2027-01-01T00:00:00.000Z');
    expect(audits()).toEqual([]);
  });

  it('refuses a non-admin and an unknown business', async () => {
    f.role = 'finance';
    expect((await send(body(bound()))).status).toBe(403);
    f.role = 'admin';
    const ghost = '55555555-5555-4555-8555-555555555555';
    expect((await send(body(bound(7, ghost), 7, ghost))).status).toBe(404);
  });
});

// ── A merchant's customer's recurring payment ──

describe('POST /api/admin/recurring', () => {
  const body = (action: string, stepUpId: string, businessId = BIZ) =>
    ({ subscriptionId: CSUB, businessId, action, reason: 'Support ticket 12', stepUpId });
  const bound = (action: string, businessId = BIZ) => grant(CSUB, { action: `recurring_${action}`, businessId, reason: 'Support ticket 12' });
  const send = (b: unknown) => recurring.POST(req('/api/admin/recurring', b));
  const set = (patch: Record<string, unknown>) => Object.assign(row('customer_subscriptions', CSUB), patch);

  it('Stripe pause, resume and cancel call Stripe first, then change the row', async () => {
    expect((await send(body('pause', bound('pause')))).status).toBe(200);
    expect(row('customer_subscriptions', CSUB)).toMatchObject({ status: 'paused', paused_at: expect.any(String) });
    expect((await send(body('resume', bound('resume')))).status).toBe(200);
    expect(row('customer_subscriptions', CSUB)).toMatchObject({ status: 'active', paused_at: null });
    expect((await send(body('cancel', bound('cancel')))).status).toBe(200);
    expect(row('customer_subscriptions', CSUB)).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(String) });
    expect(calls()).toEqual({ stripePause: 1, stripeResume: 1, stripeCancelNow: 1 });
    expect(audits().map((a: any) => a.action)).toEqual(['admin_recurring_pause', 'admin_recurring_resume', 'admin_recurring_cancel']);
    expect(audits()[0]).toMatchObject({ actor_id: 'admin-1', entity_id: CSUB, details: expect.objectContaining({ reason: 'Support ticket 12', previous_status: 'active', new_status: 'paused' }) });
  });

  it('Paystack: pause and cancel disable, resume enables, with the email token', async () => {
    set({ gateway: 'paystack', gateway_subscription_code: 'SUB_c', metadata: { email_token: 'tok_c' } });
    expect((await send(body('pause', bound('pause')))).status).toBe(200);
    expect((await send(body('resume', bound('resume')))).status).toBe(200);
    expect((await send(body('cancel', bound('cancel')))).status).toBe(200);
    expect(f.gateway.paystackDisable.mock.calls).toEqual([['SUB_c', 'tok_c'], ['SUB_c', 'tok_c']]);
    expect(f.gateway.paystackEnable.mock.calls).toEqual([['SUB_c', 'tok_c']]);
  });

  it('Flutterwave is charged by Waaiio, so only the row changes', async () => {
    set({ gateway: 'flutterwave', gateway_subscription_code: null });
    expect((await send(body('pause', bound('pause')))).status).toBe(200);
    expect(row('customer_subscriptions', CSUB).status).toBe('paused');
    expect(calls()).toEqual({});
  });

  it('wrong business: 404, nothing at the gateway, nothing changed', async () => {
    const res = await send(body('cancel', bound('cancel', OTHER_BIZ), OTHER_BIZ));
    expect(res.status).toBe(404);
    expect(calls()).toEqual({});
    expect(row('customer_subscriptions', CSUB).status).toBe('active');
  });

  it('double click with the same step-up: one gateway call, the second is refused', async () => {
    const id = bound('cancel');
    expect(await doubleClick(() => send(body('cancel', id)))).toEqual([200, 403]);
    expect(calls()).toEqual({ stripeCancelNow: 1 });
  });

  it('a second confirmed request after it is done: 409, no second gateway call', async () => {
    expect((await send(body('pause', bound('pause')))).status).toBe(200);
    expect((await send(body('pause', bound('pause')))).status).toBe(409);
    expect(calls()).toEqual({ stripePause: 1 });
  });

  it('a concurrent change during the gateway call: 409 and audited as a conflict', async () => {
    f.during = () => set({ status: 'cancelled' });
    const res = await send(body('pause', bound('pause')));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ providerChanged: true });
    expect(row('customer_subscriptions', CSUB).status).toBe('cancelled');
    expect(audits()).toEqual([expect.objectContaining({ details: expect.objectContaining({ local_update: 'conflict' }) })]);
  });

  it('refuses actions that do not fit the current status', async () => {
    expect((await send(body('resume', bound('resume')))).status).toBe(409);
    expect((await send(body('retry', bound('retry')))).status).toBe(409);
    expect(calls()).toEqual({});
  });

  it('missing gateway key or a provider failure changes nothing', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect((await send(body('pause', bound('pause')))).status).toBe(503);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic');
    f.gateway.stripePause.mockResolvedValueOnce(false);
    expect((await send(body('pause', bound('pause')))).status).toBe(502);
    expect(row('customer_subscriptions', CSUB).status).toBe('active');
    expect(audits()).toEqual([]);
  });

  it('refuses unknown gateways and missing provider codes', async () => {
    set({ gateway: null });
    expect((await send(body('pause', bound('pause')))).status).toBe(422);
    set({ gateway: 'paystack', gateway_subscription_code: 'SUB_c', metadata: {} });
    expect((await send(body('pause', bound('pause')))).status).toBe(422);
    expect(calls()).toEqual({});
  });

  describe('retry', () => {
    beforeEach(() => set({ gateway: 'paystack', status: 'past_due', failure_count: 2, authorization_code: 'AUTH_synthetic' }));

    it('resets the failure count for the daily retry; no charge is made now', async () => {
      const res = await send(body('retry', bound('retry')));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ action: 'retry', status: 'past_due', failureCount: 0, auditRecorded: true });
      expect(row('customer_subscriptions', CSUB)).toMatchObject({ status: 'past_due', failure_count: 0 });
      expect(calls()).toEqual({});
      expect(audits()).toEqual([expect.objectContaining({ action: 'admin_recurring_retry', details: expect.objectContaining({ previous_failures: 2 }) })]);
    });

    it('Flutterwave can be retried too', async () => {
      set({ gateway: 'flutterwave' });
      expect((await send(body('retry', bound('retry')))).status).toBe(200);
    });

    it('refuses Stripe (it retries itself), no saved card, and a pending cancellation', async () => {
      set({ gateway: 'stripe' });
      expect((await send(body('retry', bound('retry')))).status).toBe(422);
      set({ gateway: 'paystack', authorization_code: null });
      expect((await send(body('retry', bound('retry')))).status).toBe(422);
      set({ authorization_code: 'AUTH_synthetic', cancellation_requested_at: '2026-11-18T00:00:00Z' });
      expect((await send(body('retry', bound('retry')))).status).toBe(409);
      expect(row('customer_subscriptions', CSUB).failure_count).toBe(2);
    });

    it('double click: one reset only', async () => {
      const id = bound('retry');
      expect(await doubleClick(() => send(body('retry', id)), false)).toEqual([200, 403]);
      expect(audits()).toHaveLength(1);
    });
  });

  it('requires an admin, a known action and a reason', async () => {
    f.role = 'finance';
    expect((await send(body('pause', bound('pause')))).status).toBe(403);
    f.role = 'admin';
    expect((await send(body('refund', 'x'))).status).toBe(400);
    expect((await send({ ...body('pause', 'x'), reason: '' })).status).toBe(400);
    expect(calls()).toEqual({});
  });
});
