/**
 * Admin tier-change pre-check: real page render tests.
 *
 * Renders the actual Businesses and Subscriptions pages with mocked deps,
 * drives the tier-change UI, and asserts pre-check behavior:
 *
 * Businesses page:
 * 1. GET non-OK → alert "Could not check…", no POST
 * 2. GET throws (network) → alert, no POST
 * 3. Paying business + confirm false → no POST
 * 4. Paying business + confirm true → exactly one POST with {tier}
 *
 * Subscriptions page:
 * 5. GET non-OK → alert "Could not check…", no POST
 * 6. GET throws (network) → alert, no POST
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Test state (vi.hoisted so it's available before vi.mock calls) ──

const {
  fetchBehavior,
  fetchCalls,
  alertCalls,
  confirmResult,
  confirmCalls,
  mockBizData,
  mockSubData,
} = vi.hoisted(() => ({
  fetchBehavior: { value: 'ok-nonpaying' as 'ok-nonpaying' | 'ok-paying' | 'non-ok' | 'throw' },
  fetchCalls: [] as Array<{ url: string; method: string; body?: string }>,
  alertCalls: [] as string[],
  confirmResult: { value: false },
  confirmCalls: [] as string[],
  mockBizData: [
    {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'Acme Shop',
      slug: 'acme-shop',
      bot_code: 'ACME01',
      category: 'services',
      flow_type: null,
      country_code: 'NG',
      subscription_tier: 'free',
      payout_mode: 'platform_managed',
      status: 'active',
      phone: null,
      city: null,
      neighborhood: null,
      created_at: '2026-01-01T00:00:00Z',
      verification_level: 'basic',
      verification_status: 'approved',
      payout_limit_monthly: null,
      assigned_channel_id: null,
      custom_fee_percentage: null,
      custom_fee_flat: null,
      payment_channels: null,
      messaging_suspended: false,
    },
  ],
  mockSubData: [
    {
      id: 'ssssssss-1111-2222-3333-444444444444',
      business_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      plan: 'free',
      status: 'active',
      amount: 0,
      currency: 'NGN',
      billing_interval: 'month',
      trial_ends_at: null,
      current_period_start: '2026-01-01T00:00:00Z',
      current_period_end: '2026-12-01T00:00:00Z',
      cancelled_at: null,
      cancellation_reason: null,
      gateway: null,
      metadata: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: null,
      // PostgREST join result for select('*, businesses(name, category, subscription_tier)')
      businesses: { name: 'Acme Shop', category: 'services', subscription_tier: 'free' },
    },
  ],
}));

// ── Supabase mock (adminDb + supabase auth) ──

function chainable(data: unknown[] | null = [], error: unknown = null) {
  const result = { data, error, count: data?.length ?? 0 };
  // Must be a proper thenable so `await adminDb.from(...).select(...).order(...)` resolves
  const chain: Record<string, unknown> = {
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) => {
      return Promise.resolve(result).then(resolve, reject);
    },
    eq: () => chain,
    in: () => chain,
    neq: () => chain,
    is: () => chain,
    gt: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve({ data: data?.[0] ?? null, error }),
  };
  return chain;
}

vi.mock('@/lib/supabase', () => {
  const mkFrom = (table: string) => ({
    select: (..._args: unknown[]) => {
      if (table === 'businesses') return chainable(mockBizData);
      if (table === 'subscriptions') return chainable(mockSubData);
      if (table === 'whatsapp_channels') return chainable([]);
      if (table === 'capability_overrides') return chainable([], null);
      return chainable([]);
    },
    update: () => chainable([]),
  });
  return {
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: { session: { access_token: 'test-token', user: { id: 'admin-1' } } },
        }),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
      from: (t: string) => mkFrom(t),
    },
    adminDb: {
      from: (t: string) => mkFrom(t),
    },
  };
});

vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: vi.fn().mockReturnValue({
    userId: 'admin-1',
    email: 'admin@waaiio.test',
    role: 'admin',
  }),
}));

vi.mock('@/lib/auditLog', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/verification', () => ({
  getCurrencyCode: vi.fn(() => 'NGN'),
}));

vi.mock('@/hooks/useStepUp', () => ({
  useStepUp: () => ({
    execute: vi.fn(),
    isPending: false,
    state: { phase: 'idle', description: '', error: null },
    submitCode: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock('@/components/StepUpDialog', () => ({
  StepUpDialog: () => null,
}));

// ── Global overrides ──

let origFetch: typeof globalThis.fetch;
let origAlert: typeof globalThis.alert;
let origConfirm: typeof globalThis.confirm;

function installGlobals() {
  origFetch = globalThis.fetch;
  origAlert = globalThis.alert;
  origConfirm = globalThis.confirm;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    fetchCalls.push({ url, method, body: init?.body as string | undefined });

    if (fetchBehavior.value === 'throw') throw new TypeError('Failed to fetch');
    if (fetchBehavior.value === 'non-ok') {
      return new Response(JSON.stringify({ error: 'server error' }), { status: 500 });
    }
    if (method === 'GET') {
      const body = fetchBehavior.value === 'ok-paying'
        ? { tier: 'free', paidPlan: 'growth', revertsOn: '2026-12-01T00:00:00Z' }
        : { tier: 'free', paidPlan: null, revertsOn: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ tier: 'growth', paidPlan: null, revertsOn: null }), { status: 200 });
  }) as typeof globalThis.fetch;

  globalThis.alert = vi.fn((msg: string) => { alertCalls.push(msg); });
  globalThis.confirm = vi.fn((_msg: string) => { confirmCalls.push(_msg); return confirmResult.value; });
}

function restoreGlobals() {
  globalThis.fetch = origFetch;
  globalThis.alert = origAlert;
  globalThis.confirm = origConfirm;
}

// ── Imports (after mocks) ──

import BusinessesPage from '@/pages/Businesses';
import SubscriptionsPage from '@/pages/Subscriptions';

// ── Helpers ──

function postCalls() { return fetchCalls.filter(c => c.method === 'POST'); }

// ── Tests: Businesses page ──

describe('Tier change pre-check — Businesses page', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    alertCalls.length = 0;
    confirmCalls.length = 0;
    confirmResult.value = false;
    fetchBehavior.value = 'ok-nonpaying';
    installGlobals();
  });

  afterEach(() => {
    restoreGlobals();
  });

  async function openBizAndChangeTier() {
    const user = userEvent.setup();
    render(<BusinessesPage />);

    // Wait for the business row to appear and click it
    const row = await screen.findByText('Acme Shop');
    await user.click(row);

    // Wait for the detail modal to open with Admin Actions
    await screen.findByText('Admin Actions');

    // Change tier from 'free' to 'growth'
    const tierSelect = screen.getAllByDisplayValue('Free')[0] as HTMLSelectElement;
    await user.selectOptions(tierSelect, 'growth');

    // Click Save
    const saveButtons = screen.getAllByRole('button', { name: /Save/ });
    // The first Save in the tier section
    const tierSaveBtn = saveButtons.find(b => !b.hasAttribute('disabled'));
    expect(tierSaveBtn).toBeDefined();
    await user.click(tierSaveBtn!);
  }

  it('1. GET non-OK → alert "Could not check…", no POST', async () => {
    fetchBehavior.value = 'non-ok';
    await openBizAndChangeTier();

    await waitFor(() => expect(alertCalls.length).toBeGreaterThan(0));
    expect(alertCalls[0]).toContain('Could not check');
    expect(postCalls()).toHaveLength(0);
  });

  it('2. GET throws (network) → alert, no POST', async () => {
    fetchBehavior.value = 'throw';
    await openBizAndChangeTier();

    await waitFor(() => expect(alertCalls.length).toBeGreaterThan(0));
    expect(alertCalls[0]).toContain('Could not check');
    expect(postCalls()).toHaveLength(0);
  });

  it('3. paying business + confirm false → no POST', async () => {
    fetchBehavior.value = 'ok-paying';
    confirmResult.value = false;
    await openBizAndChangeTier();

    await waitFor(() => expect(confirmCalls.length).toBeGreaterThan(0));
    expect(confirmCalls[0]).toContain('pays for the Growth plan');
    expect(postCalls()).toHaveLength(0);
  });

  it('4. paying business + confirm true → exactly one POST with {tier}', async () => {
    fetchBehavior.value = 'ok-paying';
    confirmResult.value = true;
    await openBizAndChangeTier();

    await waitFor(() => expect(postCalls().length).toBe(1));
    const body = JSON.parse(postCalls()[0].body!);
    expect(body).toEqual({ tier: 'growth' });
  });
});

// ── Tests: Subscriptions page ──

describe('Tier change pre-check — Subscriptions page', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    alertCalls.length = 0;
    confirmCalls.length = 0;
    confirmResult.value = false;
    fetchBehavior.value = 'ok-nonpaying';
    installGlobals();
  });

  afterEach(() => {
    restoreGlobals();
  });

  async function openSubAndChangeTier() {
    const user = userEvent.setup();
    render(<SubscriptionsPage />);

    // Wait for the subscription row to appear and click it
    const row = await screen.findByText('Acme Shop');
    await user.click(row);

    // Wait for the detail modal with admin actions
    await screen.findByText('Change Tier');

    // Find the tier select inside the "Change Tier" section
    const changeTierLabel = screen.getByText('Change Tier');
    const tierSection = changeTierLabel.closest('div.rounded-lg')!;
    const tierSelect = tierSection.querySelector('select')!;
    await user.selectOptions(tierSelect, 'growth');

    // Click Save button inside the tier section
    const saveBtn = tierSection.querySelector('button')!;
    await user.click(saveBtn);
  }

  it('5. GET non-OK → alert "Could not check…", no POST', async () => {
    fetchBehavior.value = 'non-ok';
    await openSubAndChangeTier();

    await waitFor(() => expect(alertCalls.length).toBeGreaterThan(0));
    expect(alertCalls[0]).toContain('Could not check');
    expect(postCalls()).toHaveLength(0);
  });

  it('6. GET throws (network) → alert, no POST', async () => {
    fetchBehavior.value = 'throw';
    await openSubAndChangeTier();

    await waitFor(() => expect(alertCalls.length).toBeGreaterThan(0));
    expect(alertCalls[0]).toContain('Could not check');
    expect(postCalls()).toHaveLength(0);
  });
});
