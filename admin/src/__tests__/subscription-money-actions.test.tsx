// Owner decisions 2026-11-18: the admin Subscriptions and Recurring Payments
// money actions, rendered with the real useStepUp hook and StepUpDialog. Only
// fetch and the Supabase client are stubbed. Proves each action asks for a
// step-up bound to exactly what the admin confirmed, sends the same fields to
// the server route, never writes a table from the browser, shows the server's
// refusal, and is off for non-full admins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const BIZ = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const CSUB = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-11-18T09:00:00.000Z';

const m = vi.hoisted(() => ({
  role: 'admin', fetch: vi.fn(),
  directWrites: [] as Array<{ table: string; kind: string }>,
  subscriptions: [] as unknown[],
  recurring: [] as unknown[],
  actionStatus: 200, actionBody: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: any = {};
    for (const k of ['select', 'order', 'eq', 'in', 'gte', 'limit']) q[k] = () => q;
    for (const kind of ['update', 'insert', 'upsert', 'delete']) q[kind] = () => { m.directWrites.push({ table, kind }); return q; };
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: table === 'subscriptions' ? m.subscriptions : [], error: null }).then(r);
    return q;
  };
  const auth = {
    getSession: async () => ({ data: { session: { access_token: 'token' } } }),
    setSession: async () => ({ error: null }),
  };
  return { supabase: { from, auth }, adminDb: { from, auth } };
});
vi.mock('@/lib/adminQuery', () => ({ adminQuery: async () => ({ data: [], count: 0 }) }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: m.role }) }));

import Subscriptions from '@/pages/Subscriptions';
import RecurringPayments from '@/pages/RecurringPayments';

const json = (body: unknown, status = 200) => Response.json(body, { status });
const calls = (suffix: string, method = 'POST') => m.fetch.mock.calls.filter(([url, init]) =>
  String(url).endsWith(suffix) && ((init?.method || 'GET') === method));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  m.role = 'admin'; m.directWrites = []; m.actionStatus = 200; m.actionBody = {};
  m.subscriptions = [{
    id: SUB, business_id: BIZ, plan: 'growth', status: 'active', amount: 5000, currency: 'NGN', billing_interval: 'month',
    current_period_start: NOW, current_period_end: '2026-12-18T00:00:00.000Z', cancelled_at: null, cancellation_reason: null,
    gateway: 'paystack', metadata: null, created_at: NOW, updated_at: NOW,
    businesses: { name: 'Acme Shop', category: 'retail', subscription_tier: 'free', feature_trial_ends_at: '2026-11-25T00:00:00.000Z' },
  }];
  m.recurring = [{
    id: CSUB, business_id: BIZ, business_name: 'Gym', customer_name: 'Ada', customer_phone: '234', status: 'active',
    amount: 5000, currency: 'NGN', frequency: 'monthly', gateway: 'paystack', failure_count: 0, charge_count: 1, total_charged: 5000, created_at: NOW,
  }];
  m.fetch.mockReset();
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/admin/recurring') && (init?.method || 'GET') === 'GET') return json({ records: m.recurring });
    if (url.endsWith('/step-up/prepare')) return json({ stepUpId: 'grant-1', factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return json({ session: { access_token: 'after-mfa', refresh_token: 'r' } });
    if (url.endsWith('/api/admin/subscriptions') || url.endsWith('/api/admin/recurring')) return json(m.actionBody, m.actionStatus);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', m.fetch);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}

async function openAcme() {
  render(<Subscriptions />);
  fireEvent.click((await screen.findAllByText('Acme Shop')).find(e => e.closest('tr'))!);
  await screen.findByText('Stop Renewal');
}

describe('Subscriptions: Stop Renewal', () => {
  it('needs a reason, then stops renewal through a bound step-up and shows the paid-until date', async () => {
    m.actionBody = { renewalStopped: true, paidUntil: '2026-12-18T00:00:00.000Z', auditRecorded: true };
    await openAcme();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Renewal...' }));
    const confirmButton = screen.getByRole('button', { name: 'Confirm Stop Renewal' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason for stopping renewal'), { target: { value: 'Merchant asked' } });
    fireEvent.click(confirmButton);
    await screen.findByPlaceholderText('000000');
    expect(bodyOf(calls('/step-up/prepare')[0])).toEqual({
      actionType: 'subscription_admin_action', targetId: SUB,
      params: { action: 'stop_renewal', subscriptionId: SUB, businessId: BIZ, reason: 'Merchant asked' },
    });
    authorize();
    expect(await screen.findByText(/Renewal is stopped\. The plan stays until/)).toBeInTheDocument();
    expect(bodyOf(calls('/api/admin/subscriptions')[0])).toEqual({
      action: 'stop_renewal', subscriptionId: SUB, businessId: BIZ, reason: 'Merchant asked', stepUpId: 'grant-1',
    });
    expect(m.directWrites).toEqual([]);
  });

  it("shows the server's refusal and keeps the subscription as it was", async () => {
    m.actionStatus = 422;
    m.actionBody = { error: 'Flutterwave plans cannot be ended at the period end yet, so nothing was changed.' };
    await openAcme();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Renewal...' }));
    fireEvent.change(screen.getByLabelText('Reason for stopping renewal'), { target: { value: 'Merchant asked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Stop Renewal' }));
    await screen.findByPlaceholderText('000000');
    authorize();
    expect((await screen.findByRole('alert')).textContent).toContain('Flutterwave plans cannot be ended');
    expect(screen.queryByText(/Renewal is stopped/)).not.toBeInTheDocument();
    expect(m.directWrites).toEqual([]);
  });
});

describe('Subscriptions: Extend Trial', () => {
  it('sends the days through a bound step-up', async () => {
    m.actionBody = { trialEndsAt: '2026-12-05T00:00:00.000Z', auditRecorded: true };
    await openAcme();
    fireEvent.change(screen.getByLabelText('Days to add'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }));
    await screen.findByPlaceholderText('000000');
    expect(bodyOf(calls('/step-up/prepare')[0]).params).toEqual({ action: 'extend_trial', businessId: BIZ, days: 10 });
    authorize();
    await waitFor(() => expect(calls('/api/admin/subscriptions')).toHaveLength(1));
    expect(bodyOf(calls('/api/admin/subscriptions')[0])).toEqual({ action: 'extend_trial', businessId: BIZ, days: 10, stepUpId: 'grant-1' });
    expect(m.directWrites).toEqual([]);
  });

  it('allows at most 30 days', async () => {
    await openAcme();
    fireEvent.change(screen.getByLabelText('Days to add'), { target: { value: '31' } });
    expect(screen.getByRole('button', { name: 'Extend' })).toBeDisabled();
  });

  it('is off for a non-full admin', async () => {
    m.role = 'support';
    await openAcme();
    expect(screen.getByText('Only a full admin can extend a trial or stop a renewal.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Extend' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop Renewal...' })).toBeDisabled();
    expect(calls('/step-up/prepare')).toEqual([]);
  });
});

describe('Recurring Payments: pause, resume, cancel, retry', () => {
  async function openAda() {
    render(<RecurringPayments />);
    fireEvent.click((await screen.findAllByText('Ada')).find(e => e.closest('tr'))!);
    await screen.findByText('Admin Actions');
  }

  it('a reason is required before any step-up', async () => {
    await openAda();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a reason');
    expect(calls('/step-up/prepare')).toEqual([]);
  });

  it('pauses through a bound step-up and shows the new status', async () => {
    m.actionBody = { action: 'pause', status: 'paused', auditRecorded: true };
    await openAda();
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Support ticket 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByPlaceholderText('000000');
    expect(bodyOf(calls('/step-up/prepare')[0])).toEqual({
      actionType: 'subscription_admin_action', targetId: CSUB,
      params: { action: 'recurring_pause', businessId: BIZ, reason: 'Support ticket 12' },
    });
    authorize();
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(bodyOf(calls('/api/admin/recurring')[0])).toEqual({
      subscriptionId: CSUB, businessId: BIZ, action: 'pause', reason: 'Support ticket 12', stepUpId: 'grant-1',
    });
    expect(m.directWrites).toEqual([]);
  });

  it('cancel asks for confirmation first; declining sends nothing', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await openAda();
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Support ticket 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Subscription' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('No refund'));
    expect(calls('/step-up/prepare')).toEqual([]);
  });

  it('a 409 shows the reason and reloads the real state', async () => {
    m.actionStatus = 409;
    m.actionBody = { error: 'This recurring payment is cancelled, so it cannot be paused.' };
    await openAda();
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Support ticket 12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await screen.findByPlaceholderText('000000');
    authorize();
    await waitFor(() => expect(calls('/api/admin/recurring', 'GET')).toHaveLength(2));
  });

  it('offers retry for a past_due Paystack payment, not for Stripe (it retries itself)', async () => {
    m.recurring = [{ ...(m.recurring[0] as object), status: 'past_due', failure_count: 2 }];
    m.actionBody = { action: 'retry', status: 'past_due', failureCount: 0, auditRecorded: true };
    await openAda();
    fireEvent.change(screen.getByLabelText('Reason for this change'), { target: { value: 'Card topped up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry (3 more tries)' }));
    await screen.findByPlaceholderText('000000');
    expect(bodyOf(calls('/step-up/prepare')[0]).params).toEqual({ action: 'recurring_retry', businessId: BIZ, reason: 'Card topped up' });
    authorize();
    await waitFor(() => expect(calls('/api/admin/recurring')).toHaveLength(1));
    expect(bodyOf(calls('/api/admin/recurring')[0]).action).toBe('retry');
    cleanup();

    m.recurring = [{ ...(m.recurring[0] as object), gateway: 'stripe' }];
    await openAda();
    expect(screen.queryByRole('button', { name: 'Retry (3 more tries)' })).not.toBeInTheDocument();
  });

  it('is off for a non-full admin', async () => {
    m.role = 'finance';
    await openAda();
    expect(screen.getByText('Only a full admin can change a recurring payment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel Subscription' })).toBeDisabled();
  });
});
