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
  stepUp: vi.fn(), mutation: vi.fn(), prepare: vi.fn(), verified: false,
}));
const business = (id: string, name: string) => ({
  id: id === 'synthetic-a' ? '00000000-0000-0000-0000-000000000001' : '00000000-0000-0000-0000-000000000002', name, slug: id, bot_code: id, category: 'services', flow_type: null,
  country_code: 'NG', subscription_tier: 'free', payout_mode: 'platform_managed',
  status: 'active', phone: null, city: null, neighborhood: null, created_at: '2026-01-01',
  verification_level: 'basic', verification_status: 'approved', payout_limit_monthly: null,
  assigned_channel_id: null, custom_fee_percentage: 2, custom_fee_flat: 10,
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
    supabase: { from, auth: { getSession: async () => ({ data: { session: f.token ? { access_token: f.token } : null }, error: null }),
      setSession: async () => { f.token = 'rotated-token'; f.verified = true; return { error: null }; } } },
  };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: f.role }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/verification', () => ({ getCurrencyCode: () => 'NGN' }));
vi.mock('@/lib/formatters', () => ({
  fmtCurrency: (value: number) => 'M ' + value,
  fmtDate: () => 'date', fmtDateTime: () => 'date',
}));
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
  f.verified = false; f.mutation.mockReset(); f.prepare.mockReset();
  f.mutation.mockImplementation(async (body: Record<string, unknown>) => new Response(JSON.stringify({
    success: true, verification_level: 'standard', verification_status: 'verified', payout_limit_monthly: 123,
    custom_fee_percentage: body.custom_fee_percentage, custom_fee_flat: body.custom_fee_flat,
  })));
  f.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/capabilities')) return stateResponse();
    const body = JSON.parse(String(init?.body || '{}'));
    if (url.endsWith('/prepare')) { const response = await f.prepare(body); if (response) return response; return new Response(JSON.stringify({ stepUpId: '00000000-0000-0000-0000-000000000762', factorId: 'factor', challengeId: 'challenge' })); }
    if (url.endsWith('/verify')) return new Response(JSON.stringify({ session: { access_token: 'rotated-token', refresh_token: 'synthetic-refresh' } }));
    if (url.endsWith('/verification/review') || url.endsWith('/messaging-suspension')) return f.mutation(body, init);
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', f.fetch);
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });


async function reasonAndConfirm() {
  await userEvent.type(screen.getByRole('textbox', { name: 'Reason for change' }), '  Reviewed  ');
  await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
  await screen.findByPlaceholderText('000000');
}
async function authorize() {
  await userEvent.type(screen.getByPlaceholderText('000000'), '123456');
  await userEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}
describe('Businesses verification and fees through actual MFA hook', () => {
  it('shows reason UI without native prompt and sends only after authorization with rotated Bearer', async () => {
    const prompt = vi.fn(() => { throw new Error('prompt unsupported'); }); vi.stubGlobal('prompt', prompt);
    render(<Businesses />); await open(); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    expect(screen.getByRole('button', { name: 'Confirm and authorize' })).toBeDisabled();
    expect(f.mutation).not.toHaveBeenCalled();
    await reasonAndConfirm();
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledWith({
      actionType: 'commercial_config', targetId: '00000000-0000-0000-0000-000000000001',
      params: { scope: 'business_verification_review', action: 'set_level', level: 'standard', reason: 'Reviewed' },
    });
    await authorize();
    await screen.findByText('Saved. The displayed values are the server result.');
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(f.mutation.mock.calls[0][1].headers.Authorization).toBe('Bearer rotated-token');
    expect(f.mutation.mock.calls[0][0].stepUpId).toBe('00000000-0000-0000-0000-000000000762');
    expect(screen.getByRole('button', { name: 'Standard', exact: true })).toBeDisabled();
    expect(screen.getByText('M 123')).toBeInTheDocument();
    expect(prompt).not.toHaveBeenCalled();
  });
  it.each(['save', 'clear'])('custom fees %s preserves zero/null and binds exact fields', async mode => {
    render(<Businesses />); await open(); await ready();
    if (mode === 'save') {
      await userEvent.clear(screen.getByRole('spinbutton', { name: 'Custom Fee %' }));
      await userEvent.type(screen.getByRole('spinbutton', { name: 'Custom Fee %' }), '0');
      await userEvent.clear(screen.getByRole('spinbutton', { name: 'Custom Flat Fee' }));
      await userEvent.type(screen.getByRole('spinbutton', { name: 'Custom Flat Fee' }), '0');
    }
    await userEvent.click(screen.getByRole('button', { name: mode === 'save' ? 'Save Override' : 'Clear Override' }));
    await reasonAndConfirm();
    const value = mode === 'save' ? 0 : null;
    expect(f.prepare.mock.calls[0][0].params).toEqual({
      scope: 'business_verification_review', action: 'set_custom_fees', custom_fee_percentage: value, custom_fee_flat: value, reason: 'Reviewed',
    });
    expect(screen.getByRole('spinbutton', { name: 'Custom Flat Fee' })).toBeDisabled();
    await authorize(); await screen.findByText('Saved. The displayed values are the server result.');
    expect(f.mutation.mock.calls[0][0]).toMatchObject({ custom_fee_percentage: value, custom_fee_flat: value });
    expect(screen.getByRole('spinbutton', { name: 'Custom Flat Fee' })).toHaveValue(mode === 'save' ? 0 : null);
  });
  it('cancels before preparation and before authorization without mutation', async () => {
    render(<Businesses />); await open(); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel change' }));
    expect(f.prepare).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await reasonAndConfirm();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(f.mutation).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Reason for change' })).not.toBeInTheDocument();
  });
  it('missing token blocks preparation and mutation visibly', async () => {
    render(<Businesses />); await open(); await ready(); f.token = null;
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for change' }), 'Review');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await screen.findByText('No active session');
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.mutation).not.toHaveBeenCalled();
  });
  it('shows failed save, keeps old state, and does not retry automatically', async () => {
    f.mutation.mockResolvedValue(new Response('{"error":"Synthetic save failed"}', { status: 500 }));
    render(<Businesses />); await open(); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await reasonAndConfirm(); await authorize();
    await screen.findByText('Synthetic save failed');
    expect(screen.getByRole('button', { name: 'Basic', exact: true })).toBeDisabled();
    expect(f.mutation).toHaveBeenCalledTimes(1);
  });
  it('blocks duplicate submissions and ignores late response for a different business', async () => {
    const pending = deferred<Response>(); f.mutation.mockReturnValue(pending.promise);
    render(<Businesses />); await open(); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for change' }), 'Review');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await screen.findByPlaceholderText('000000'); expect(f.prepare).toHaveBeenCalledTimes(1);
    await authorize(); await waitFor(() => expect(f.mutation).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true })); await open('Beta Shop'); await ready();
    await act(async () => pending.resolve(new Response('{"success":true,"verification_level":"full","verification_status":"verified","payout_limit_monthly":999}')));
    expect(screen.getByRole('button', { name: 'Basic', exact: true })).toBeDisabled();
    expect(screen.queryByText('M 999')).not.toBeInTheDocument();
  });
});

describe('shared Businesses authorization preparation lifecycle', () => {
  const prepared = () => new Response('{"stepUpId":"00000000-0000-0000-0000-000000000762","factorId":"factor","challengeId":"challenge"}');
  it.each(['resolve', 'reject'])('drains cancelled preparation before a new selection can authorize (%s)', async outcome => {
    let resolve!: (value: Response) => void;
    let reject!: (error: Error) => void;
    f.prepare.mockReturnValueOnce(new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
    render(<Businesses />); await open(); await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for change' }), 'Alpha');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    await open('Beta Shop'); await ready();
    expect(screen.getByRole('button', { name: 'Standard', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Suspend Messaging' })).toBeDisabled();
    await act(async () => outcome === 'resolve' ? resolve(prepared()) : reject(new Error('late failure')));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Standard', exact: true })).not.toBeDisabled());
    expect(screen.queryByPlaceholderText('000000')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
    await reasonAndConfirm();
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls[1][0].targetId).toBe('00000000-0000-0000-0000-000000000002');
    await authorize(); await screen.findByText('Saved. The displayed values are the server result.');
    expect(f.mutation).toHaveBeenCalledTimes(1);
    expect(f.mutation.mock.calls[0][0].business_id).toBe('00000000-0000-0000-0000-000000000002');
  });
  it.each(['review', 'messaging'])('serializes %s preparation against the other shared caller', async first => {
    const pending = deferred<Response>(); f.prepare.mockReturnValueOnce(pending.promise);
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('reviewed messaging'));
    render(<Businesses />); await open(); await ready();
    const messagingButton = screen.getByRole('button', { name: 'Suspend Messaging' });
    if (first === 'review') {
      await userEvent.click(screen.getByRole('button', { name: 'Standard', exact: true }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason for change' }), 'Reviewed');
      await userEvent.click(screen.getByRole('button', { name: 'Confirm and authorize' }));
    } else await userEvent.click(messagingButton);
    await waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Standard', exact: true })).toBeDisabled();
    expect(messagingButton).toBeDisabled();
    fireEvent.click(first === 'review' ? messagingButton : screen.getByRole('button', { name: 'Standard', exact: true }));
    expect(f.prepare).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(prepared())); await screen.findByPlaceholderText('000000');
    expect(messagingButton).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    await waitFor(() => expect(messagingButton).not.toBeDisabled());
    expect(f.mutation).not.toHaveBeenCalled();
  });
});
