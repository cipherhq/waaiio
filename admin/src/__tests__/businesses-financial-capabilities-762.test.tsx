import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@shared/capabilities';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: unknown; count?: number };
const f = vi.hoisted(() => ({
  token: 'synthetic-token' as string | null, role: 'admin',
  payments: [] as Row[], fees: [] as Row[], payouts: [] as Row[],
  failTable: '', financialWait: null as Promise<Result> | null,
  fetch: vi.fn(), queries: [] as Array<{ table: string; columns: string; filters: Array<[string, unknown]> }>,
  stepUp: vi.fn(),
}));
const business = (id: string, name: string) => ({
  id, name, slug: id, bot_code: id, category: 'services', flow_type: null,
  country_code: 'NG', subscription_tier: 'free', payout_mode: 'platform_managed',
  status: 'active', phone: null, city: null, neighborhood: null, created_at: '2026-01-01',
  verification_level: 'basic', verification_status: 'approved', payout_limit_monthly: null,
  assigned_channel_id: null, custom_fee_percentage: null, custom_fee_flat: null,
  payment_channels: null, messaging_suspended: false,
});
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    if (['business_capabilities', 'capability_overrides'].includes(table)) throw new Error('Direct capability read forbidden');
    const query = { table, columns: '', filters: [] as Array<[string, unknown]> };
    f.queries.push(query);
    let statuses: unknown[] | null = null;
    let unrefunded = false;
    const result = async (): Promise<Result> => {
      const bizId = query.filters.find(([column]) => column === 'business_id')?.[1];
      if (table === 'payments' && bizId === 'synthetic-a' && f.financialWait) return f.financialWait;
      if (f.failTable === table) return { data: null, error: { message: 'read failed' } };
      let rows: Row[] = table === 'businesses'
        ? [business('synthetic-a', 'Alpha Shop'), business('synthetic-b', 'Beta Shop')]
        : table === 'payments' ? f.payments : table === 'platform_fees' ? f.fees
          : table === 'business_payouts' && query.columns === 'net_amount, status' ? f.payouts : [];
      if (statuses) rows = rows.filter(row => statuses!.includes(row.status));
      if (unrefunded) rows = rows.filter(row => row.refunded_at == null);
      return { data: rows, error: null, count: 0 };
    };
    const chain = {
      select: (columns: string) => { query.columns = columns; return chain; },
      eq: (column: string, value: unknown) => { query.filters.push([column, value]); return chain; },
      in: (column: string, values: unknown[]) => { query.filters.push([column, values]); if (column === 'status') statuses = values; return chain; },
      is: (column: string, value: unknown) => { query.filters.push([column, value]); if (column === 'refunded_at') unrefunded = true; return chain; },
      gt: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => { const value = await result(); return { ...value, data: value.data?.[0] || null }; },
      then: (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => result().then(resolve, reject),
    };
    return chain;
  };
  return {
    adminDb: { from },
    supabase: { from, auth: { getSession: async () => ({ data: { session: f.token ? { access_token: f.token } : null }, error: null }) } },
  };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: f.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/verification', () => ({ getCurrencyCode: () => 'NGN' }));
vi.mock('@/lib/formatters', () => ({
  fmtCurrency: (value: number) => 'M ' + value,
  fmtDate: () => 'date', fmtDateTime: () => 'date',
}));
vi.mock('@/hooks/useStepUp', () => ({
  useStepUp: () => ({ execute: f.stepUp, reset: vi.fn(), submitCode: vi.fn(), isPending: false, state: { phase: 'idle' } }),
}));
vi.mock('@/components/StepUpDialog', () => ({ StepUpDialog: () => null }));
import Businesses from '@/pages/Businesses';

const cap = CAPABILITIES[0];
const second = CAPABILITIES[1];
const stateResponse = (capabilities: string[] = [], overrides: string[] = []) =>
  new Response(JSON.stringify({ tier: 'free', capabilities, overrides }), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function toggle() { return screen.getByRole('switch', { name: 'Selected ' + cap.label }); }
async function open(name = 'Alpha Shop') { await userEvent.click(await screen.findByText(name)); }
async function ready() { await waitFor(() => expect(toggle()).not.toBeDisabled()); }
function card(label: string) { return screen.getByText(label).parentElement!; }
beforeEach(() => {
  f.token = 'synthetic-token'; f.role = 'admin'; f.failTable = ''; f.financialWait = null;
  f.payments = [
    { status: 'success', amount: 100, refund_amount: 20 },
    { status: 'refunded', amount: 50, refund_amount: 50 },
    { status: 'success', amount: 200, refund_amount: 0 },
    { status: 'pending', amount: 999, refund_amount: 0 },
    { status: 'failed', amount: 999, refund_amount: 0 },
  ];
  f.fees = [{ fee_total: 10, gateway_fee: 3, refunded_at: null }, { fee_total: 0, gateway_fee: 7, refunded_at: 'date' }];
  f.payouts = [{ status: 'paid', net_amount: 40 }, { status: 'processing', net_amount: 30 }, { status: 'pending', net_amount: 999 }];
  f.queries.length = 0; f.fetch.mockReset(); f.stepUp.mockReset();
  f.fetch.mockImplementation(async () => stateResponse());
  vi.stubGlobal('fetch', f.fetch);
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('actual Businesses financial summary', () => {
  it('deducts refunds once, both retained fees, and separate paid/processing payouts', async () => {
    render(<Businesses />); await open();
    await screen.findByText('Accounting remainder: M 197');
    expect(card('Collections')).toHaveTextContent('M 350');
    expect(card('Refunds')).toHaveTextContent('M 70');
    expect(card('Platform Fees')).toHaveTextContent('M 10');
    expect(card('Gateway Fees')).toHaveTextContent('M 3');
    expect(card('Paid payouts')).toHaveTextContent('M 40');
    expect(screen.getByText('Net retained: M 267')).toBeInTheDocument();
    expect(screen.getByText('Processing reservations: M 30')).toBeInTheDocument();
    expect(screen.getByText(/not the available-to-withdraw balance/)).toBeInTheDocument();
    expect(f.queries.filter(q => q.table === 'payments')).toHaveLength(1);
    expect(f.queries.find(q => q.table === 'payments')?.filters).toContainEqual(['status', ['success', 'refunded']]);
  });
  it('fully refunded-only collections yield zero retained, not a negative double refund', async () => {
    f.payments = [{ status: 'refunded', amount: 50, refund_amount: 50 }]; f.fees = []; f.payouts = [];
    render(<Businesses />); await open(); await screen.findByText('Net retained: M 0');
    expect(screen.getByText('Accounting remainder: M 0')).toBeInTheDocument();
  });
  it('renders legitimate empty results', async () => {
    f.payments = []; f.fees = []; f.payouts = [];
    render(<Businesses />); await open(); await screen.findByText('Accounting remainder: M 0');
  });
  it.each(['payments', 'platform_fees', 'business_payouts', 'bookings'])('does not show false zero on %s read failure', async table => {
    f.failTable = table; render(<Businesses />); await open();
    await screen.findByText(/Financial summary could not be loaded/);
    expect(screen.queryByText(/^Accounting remainder: M/)).not.toBeInTheDocument();
    f.failTable = ''; await userEvent.click(screen.getByRole('button', { name: 'Retry financial summary' }));
    await screen.findByText('Accounting remainder: M 197');
  });
  it('ignores a delayed financial response after switching businesses', async () => {
    const pending = deferred<Result>(); f.financialWait = pending.promise;
    render(<Businesses />); await open(); await screen.findByText('Loading financial summary…');
    await userEvent.click(screen.getByRole('button', { name: 'Close' })); await open('Beta Shop');
    await screen.findByText('Accounting remainder: M 197');
    await act(async () => pending.resolve({ data: [{ amount: 9999, refund_amount: 0 }], error: null }));
    expect(screen.getByText('Accounting remainder: M 197')).toBeInTheDocument();
    expect(screen.queryByText('M 9999')).not.toBeInTheDocument();
  });
});

describe('secured selected-capability loading and mutation readback', () => {
  it('uses Bearer initial GET and renders selected/override state without effective-entitlement claims', async () => {
    f.fetch.mockImplementation(async () => stateResponse([cap.id], [cap.id]));
    render(<Businesses />); await open(); await ready();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(within(toggle().parentElement!).getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText(/Selected capabilities may be paused/)).toBeInTheDocument();
    expect(f.fetch).toHaveBeenCalledWith(expect.stringContaining('/synthetic-a/capabilities'), { headers: { Authorization: 'Bearer synthetic-token' } });
    expect(f.stepUp).not.toHaveBeenCalled();
  });
  it('disables editing while initial GET is loading', async () => {
    const pending = deferred<Response>(); f.fetch.mockReturnValue(pending.promise);
    render(<Businesses />); await open();
    expect(toggle()).toBeDisabled();
    await act(async () => pending.resolve(stateResponse())); await ready();
  });
  it('does not send a request without a session token', async () => {
    f.token = null; render(<Businesses />); await open();
    await screen.findByText(/Session expired/); expect(toggle()).toBeDisabled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(['denied', 'network', 'malformed', 'read-error'])('shows %s as unknown, blocks edits, and retries', async mode => {
    f.fetch.mockImplementationOnce(async () => {
      if (mode === 'network') throw new TypeError('Network unavailable');
      if (mode === 'malformed') return new Response(JSON.stringify({ capabilities: [], overrides: [false] }), { status: 200 });
      return new Response('{}', { status: mode === 'denied' ? 403 : 500 });
    });
    render(<Businesses />); await open();
    await screen.findByRole('button', { name: 'Retry capabilities' });
    expect(toggle()).toBeDisabled();
    f.fetch.mockImplementation(async () => stateResponse([cap.id]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry capabilities' })); await ready();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });
  it.each([false, true])('waits for authoritative cascade readback after selected=%s mutation', async initiallySelected => {
    const pending = deferred<Response>();
    f.fetch.mockResolvedValueOnce(stateResponse(initiallySelected ? [cap.id] : [], initiallySelected ? [cap.id] : []))
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }))
      .mockReturnValueOnce(pending.promise);
    render(<Businesses />); await open(); await ready();
    await userEvent.click(toggle());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3));
    expect(toggle()).toBeDisabled();
    for (const item of screen.getAllByRole('switch')) expect(item).toBeDisabled();
    const init = f.fetch.mock.calls[1][1];
    expect(init.headers.Authorization).toBe('Bearer synthetic-token');
    expect(JSON.parse(init.body)).toEqual({ capability: cap.id, action: initiallySelected ? 'revoke' : 'grant', reason: 'Admin toggled' });
    await act(async () => pending.resolve(stateResponse([second.id], [second.id]))); await ready();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Selected ' + second.label })).toHaveAttribute('aria-checked', 'true');
    expect(within(toggle().parentElement!).queryByText('Admin')).not.toBeInTheDocument();
    expect(within(screen.getByRole('switch', { name: 'Selected ' + second.label }).parentElement!).getByText('Admin')).toBeInTheDocument();
  });
  it('removes an override badge when authoritative readback clears overrides but keeps the selection', async () => {
    f.fetch.mockResolvedValueOnce(stateResponse([cap.id], [cap.id]))
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }))
      .mockResolvedValueOnce(stateResponse([cap.id], []));
    render(<Businesses />); await open(); await ready();
    expect(within(toggle().parentElement!).getByText('Admin')).toBeInTheDocument();
    await userEvent.click(toggle()); await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(3)); await ready();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
    expect(within(toggle().parentElement!).queryByText('Admin')).not.toBeInTheDocument();
  });
  it('prevents duplicate POSTs before a pending mutation finishes', async () => {
    const pending = deferred<Response>();
    f.fetch.mockResolvedValueOnce(stateResponse()).mockReturnValueOnce(pending.promise);
    render(<Businesses />); await open(); await ready();
    fireEvent.click(toggle()); fireEvent.click(toggle());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(toggle()).toBeDisabled();
    await act(async () => pending.resolve(new Response('{"success":true}', { status: 200 }))); await ready();
  });
  it('distinguishes POST failure from successful-save readback failure', async () => {
    f.fetch.mockResolvedValueOnce(stateResponse()).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    render(<Businesses />); await open(); await ready(); await userEvent.click(toggle());
    await screen.findByText(/Capability change failed/); expect(toggle()).toBeDisabled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps controls blocked after POST success and GET failure until a successful retry', async () => {
    f.fetch.mockResolvedValueOnce(stateResponse()).mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }));
    render(<Businesses />); await open(); await ready(); await userEvent.click(toggle());
    await screen.findByText(/Capability saved, but refreshed state/); expect(toggle()).toBeDisabled();
    f.fetch.mockImplementation(async () => stateResponse([cap.id]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry capabilities' })); await ready();
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });
  it('ignores old initial GET after closing and reopening the same business', async () => {
    const pending = deferred<Response>();
    f.fetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(stateResponse([]));
    render(<Businesses />); await open();
    await userEvent.click(screen.getByRole('button', { name: 'Close' })); await open(); await ready();
    await act(async () => pending.resolve(stateResponse([cap.id])));
    expect(toggle()).toHaveAttribute('aria-checked', 'false');
  });
  it('ignores old POST response after selecting another business', async () => {
    const pending = deferred<Response>();
    f.fetch.mockResolvedValueOnce(stateResponse()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(stateResponse([cap.id]));
    render(<Businesses />); await open(); await ready(); await userEvent.click(toggle());
    await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Close' })); await open('Beta Shop'); await ready();
    await act(async () => pending.resolve(new Response('{"success":true}', { status: 200 })));
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });
  it('does not permit a non-admin to mutate selections', async () => {
    f.role = 'support'; render(<Businesses />); await open();
    await waitFor(() => expect(screen.queryByText('Loading selected capabilities…')).not.toBeInTheDocument());
    expect(toggle()).toBeDisabled();
    fireEvent.click(toggle());
    expect(f.fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
  });
});
