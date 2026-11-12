/**
 * #887 (Owner decision 2026-11-10, option 1B): a 30-day account deletion
 * cannot be scheduled yet, because there is nowhere to store the schedule
 * (profiles.metadata never existed) and nothing completes it.
 *
 * The request must be refused BEFORE anything changes: no subscription is
 * cancelled at Stripe/Paystack, no bot chat is closed, no audit row is written
 * and no email is sent. "Cancel deletion" must answer without reading the
 * missing column. Immediate deletion is unchanged (separate lane).
 *
 * Calls the real route handlers against a fake service client that records
 * every table operation and answers 42703 for profiles.metadata, as the live
 * staging and production databases do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Op = { table: string; op: string; value?: unknown };
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  ops: [] as Array<{ table: string; op: string; value?: unknown }>,
  deleteUser: vi.fn(),
  cancelStripe: vi.fn(),
  cancelPaystack: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/payments/stripe-recurring', () => ({ cancelSubscription: mocks.cancelStripe }));
vi.mock('@/lib/payments/paystack-recurring', () => ({ cancelSubscription: mocks.cancelPaystack }));
vi.mock('@/lib/email/client', () => ({ sendEmail: mocks.sendEmail }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAudit: mocks.audit }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: { deleteUser: mocks.deleteUser } },
    from(table: string) {
      let selected = '';
      let payload: Record<string, unknown> | undefined;
      const answer = () => {
        // The live profiles table has no metadata column (staging and production).
        if (table === 'profiles' && (selected.includes('metadata') || (payload && 'metadata' in payload))) {
          return { data: null, error: { code: '42703', message: 'column profiles.metadata does not exist' } };
        }
        if (table === 'businesses' && !payload) return { data: [{ id: 'biz-887', name: 'Shop' }], error: null };
        if (table === 'customer_subscriptions' && !payload) {
          return { data: [{ id: 'sub-1', gateway: 'stripe', gateway_subscription_code: 'sub_live_1', metadata: {}, business_id: 'biz-887' }], error: null };
        }
        return { data: null, error: null };
      };
      const builder: Record<string, unknown> = {
        select(columns: string) { selected = columns; mocks.ops.push({ table, op: 'select', value: columns }); return builder; },
        update(value: Record<string, unknown>) { payload = value; mocks.ops.push({ table, op: 'update', value }); return builder; },
        eq: () => builder,
        in: () => builder,
        maybeSingle: async () => answer(),
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

import { DELETE, PATCH } from '@/app/api/account/route';

function deleteRequest(body?: unknown) {
  return new NextRequest('https://example.test/api/account', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const tablesTouched = () => [...new Set(mocks.ops.map((o: Op) => o.table))];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ops.length = 0;
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner-887', email: 'owner@example.test' } } });
  mocks.deleteUser.mockResolvedValue({ error: null });
  mocks.cancelStripe.mockResolvedValue(undefined);
  mocks.cancelPaystack.mockResolvedValue(undefined);
  mocks.sendEmail.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue({ error: null });
});

describe('#887 DELETE /api/account with a 30-day grace period', () => {
  it('is refused with a clear message and changes nothing', async () => {
    const res = await DELETE(deleteRequest({ gracePeriod: true }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('grace_period_unavailable');
    expect(body.error).toMatch(/couldn't schedule a 30-day deletion/i);
    expect(body.error).toMatch(/Nothing has been changed/);
    expect(body.error).toContain('support@waaiio.com');
    expect(body.success).toBeUndefined();

    // Refused before any side effect.
    expect(mocks.ops).toEqual([]);
    expect(mocks.cancelStripe).not.toHaveBeenCalled();
    expect(mocks.cancelPaystack).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });

  it('still requires a signed-in user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await DELETE(deleteRequest({ gracePeriod: true }));
    expect(res.status).toBe(401);
    expect(mocks.ops).toEqual([]);
  });
});

describe('#887 immediate deletion is unchanged', () => {
  it('still cancels subscriptions, closes bot chats, audits, emails and deletes the login', async () => {
    const res = await DELETE(deleteRequest({ gracePeriod: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mocks.cancelStripe).toHaveBeenCalledWith('sub_live_1');
    expect(mocks.ops).toContainEqual({ table: 'bot_sessions', op: 'update', value: { is_active: false } });
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.deleteUser).toHaveBeenCalledWith('owner-887');
    // It never reads or writes the missing profiles.metadata column.
    expect(tablesTouched()).not.toContain('profiles');
  });
});

describe('#887 PATCH /api/account (cancel scheduled deletion)', () => {
  it('answers "No deletion scheduled" without reading profiles.metadata or touching businesses', async () => {
    const res = await PATCH();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'No deletion scheduled' });
    expect(mocks.ops).toEqual([]);
  });

  it('still requires a signed-in user', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await PATCH();
    expect(res.status).toBe(401);
  });
});
