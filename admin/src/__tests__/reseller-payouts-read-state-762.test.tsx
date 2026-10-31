import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Payouts from '../pages/ResellerPayouts';

const m = vi.hoisted(() => ({
  getSession: vi.fn(), setSession: vi.fn(), fetch: vi.fn(), selectors: vi.fn(), fees: vi.fn(),
  role: 'admin', rotated: false,
}));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: m.role }) }));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: m.getSession, setSession: m.setSession } },
  adminDb: { from: (table: string) => {
    if (table === 'resellers') return { select: () => ({ order: m.selectors }) };
    if (table !== 'platform_fees') throw new Error('Unexpected table or mutation');
    const params: Record<string, string> = {};
    const query = {
      select: () => query,
      eq: (key: string, value: string) => { params[key] = value; return query; },
      gte: (_key: string, value: string) => { params.start = value; return query; },
      lt: (_key: string, value: string) => { params.end = value; return query; },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve().then(() => m.fees(params)).then(resolve, reject),
    };
    return query;
  } },
}));
// The real useStepUp and StepUpDialog run; only network/session boundaries are synthetic.
const row = { id: 'p1', reseller_id: 'r1', company_name: 'Alpha', period_start: '2026-01-01',
  period_end: '2026-02-01', gross_commission: 10000, holdback: 1000, deductions: 0,
  net_amount: 9000, status: 'pending', notes: null, created_at: '2026-02-01',
  approved_by: null, paid_at: null };
const selectors = [{ id: 'r1', company_name: 'Alpha', commission_percentage: 10, created_at: '2020-01-01' },
  { id: 'r2', company_name: 'Beta', commission_percentage: 10, created_at: '2020-01-01' }];
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function session() { return { data: { session: { access_token: m.rotated ? 'refreshed-token' : 'initial-token' } }, error: null }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function network(url: string, options?: RequestInit) {
  if (url.endsWith('/step-up/prepare')) return Promise.resolve(response({ stepUpId: 'step-1', factorId: 'factor-1', challengeId: 'challenge-1' }));
  if (url.endsWith('/step-up/verify')) return Promise.resolve(response({ session: { access_token: 'refreshed-token', refresh_token: 'synthetic-refresh' } }));
  if (options?.method === 'POST' || options?.method === 'PATCH') return Promise.resolve(response({ payout: row, success: true }));
  return Promise.resolve(response({ payouts: [row] }));
}
function mutations() { return m.fetch.mock.calls.filter(([url, options]) =>
  url.includes('/reseller-payouts') && ['POST', 'PATCH'].includes(options?.method)); }
async function ready() { await screen.findByText('Alpha'); }
async function generate() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Payout' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Generate Payout' }));
  fireEvent.change(screen.getByLabelText('Reseller'), { target: { value: 'r1' } });
  fireEvent.change(screen.getByLabelText('Period Start'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('Period End'), { target: { value: '2026-02-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview Commission (estimate)' }));
  await screen.findByText('Preview only — server calculates final amounts');
}
async function startMfa(kind: string) {
  if (kind === 'generate') {
    await generate();
    fireEvent.click(screen.getByRole('button', { name: /Create Payout/ }));
  } else fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByPlaceholderText('000000');
}
function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}
beforeEach(() => {
  vi.resetAllMocks(); m.role = 'admin'; m.rotated = false;
  vi.stubGlobal('fetch', m.fetch);
  m.getSession.mockImplementation(async () => session());
  m.setSession.mockImplementation(async () => { m.rotated = true; return { error: null }; });
  m.selectors.mockResolvedValue({ data: selectors, error: null });
  m.fees.mockResolvedValue({ data: [{ reseller_commission: 10000 }], error: null });
  m.fetch.mockImplementation(network);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Payout read truthfulness and current authorization', () => {
  it.each(['session-error', 'session-reject', 'missing-token', '403', '500', 'reject', 'json', 'missing', 'null', 'object'])(
    '%s read failure is unavailable and retry is read-only', async mode => {
      if (mode === 'session-error') m.getSession.mockResolvedValue({ data: { session: null }, error: { message: 'synthetic' } });
      else if (mode === 'session-reject') m.getSession.mockRejectedValue(new Error('synthetic'));
      else if (mode === 'missing-token') m.getSession.mockResolvedValue({ data: { session: null }, error: null });
      else m.fetch.mockImplementation(() => {
        if (mode === 'reject') return Promise.reject(new Error('synthetic'));
        if (mode === 'json') return Promise.resolve(new Response('invalid'));
        if (mode === '403' || mode === '500') return Promise.resolve(response({}, Number(mode)));
        return Promise.resolve(response(mode === 'missing' ? {} : { payouts: mode === 'null' ? null : {} }));
      });
      render(<Payouts />);
      await screen.findByRole('alert');
      expect(screen.queryByText('No payouts found.')).not.toBeInTheDocument();
      expect(screen.queryByText('Total Payouts')).not.toBeInTheDocument();
      m.getSession.mockImplementation(async () => session()); m.fetch.mockImplementation(network);
      fireEvent.click(screen.getByRole('button', { name: 'Retry payouts' })); await ready();
      expect(mutations()).toHaveLength(0);
    },
  );
  it('valid empty payouts is genuinely empty', async () => {
    m.fetch.mockResolvedValue(response({ payouts: [] }));
    render(<Payouts />); await screen.findByText('No payouts found.');
    expect(screen.getByText('Total Payouts')).toBeInTheDocument();
  });
  it.each(['returned', 'rejected', 'null'])('selector %s failure is isolated from valid payouts', async mode => {
    if (mode === 'rejected') m.selectors.mockRejectedValue(new Error('synthetic'));
    else m.selectors.mockResolvedValue({ data: mode === 'null' ? null : [], error: mode === 'returned' ? { message: 'synthetic' } : null });
    render(<Payouts />); await ready(); await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Generate Payout' })).toBeDisabled();
    expect(screen.getByText('Total Payouts')).toBeInTheDocument();
    m.selectors.mockResolvedValue({ data: selectors, error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry resellers' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Payout' })).toBeEnabled());
    expect(mutations()).toHaveLength(0);
  });
  it.each(['finance', 'support'])('%s preserves the role boundary', async role => {
    m.role = role; render(<Payouts />);
    if (role === 'finance') await ready();
    else expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Payout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(m.selectors).not.toHaveBeenCalled();
    expect(mutations()).toHaveLength(0);
  });
  it.each(['returned', 'rejected', 'null'])('preview %s failure is visible without a successful preview', async mode => {
    if (mode === 'rejected') m.fees.mockRejectedValue(new Error('synthetic'));
    else m.fees.mockResolvedValue({ data: mode === 'null' ? null : [], error: mode === 'returned' ? { message: 'synthetic' } : null });
    render(<Payouts />); await ready();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Payout' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Generate Payout' }));
    fireEvent.change(screen.getByLabelText('Reseller'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('Period Start'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Period End'), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Preview Commission/ }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /Create Payout/ })).not.toBeInTheDocument();
    m.fees.mockResolvedValue({ data: [], error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Retry Preview' }));
    await screen.findByText('Preview only — server calculates final amounts');
    expect(screen.getByRole('button', { name: /Create Payout/ })).toBeDisabled();
    expect(m.fees).toHaveBeenLastCalledWith({ reseller_id: 'r1', start: '2026-01-01', end: '2026-02-01' });
    expect(mutations()).toHaveLength(0);
  });
  it.each(['reseller', 'start', 'end', 'close'])('preview invalidated by %s ignores late success/error', async change => {
    render(<Payouts />); await ready(); await generate();
    const pending = deferred<unknown>();
    m.fees.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: /Preview Commission/ }));
    await waitFor(() => expect(m.fees).toHaveBeenCalledTimes(2));
    if (change === 'close') {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.click(screen.getByRole('button', { name: 'Generate Payout' }));
    } else fireEvent.change(screen.getByLabelText(change === 'reseller' ? 'Reseller' : change === 'start' ? 'Period Start' : 'Period End'), {
      target: { value: change === 'reseller' ? 'r2' : change === 'start' ? '2026-01-02' : '2026-02-02' },
    });
    await act(async () => pending.resolve({ data: [{ reseller_commission: 99999 }], error: null }));
    expect(screen.queryByRole('button', { name: /Create Payout/ })).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });
  it('newer preview wins over an old failure', async () => {
    render(<Payouts />); await ready(); await generate();
    const pending = deferred<unknown>();
    m.fees.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: /Preview Commission/ }));
    await waitFor(() => expect(m.fees).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Reseller'), { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: /Preview Commission/ }));
    await screen.findByText('Preview only — server calculates final amounts');
    await act(async () => pending.resolve({ data: null, error: { message: 'old' } }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Payout/ })).toBeEnabled();
  });
  it('refresh hides stale detail and reconciles its current status', async () => {
    render(<Payouts />); await ready(); fireEvent.click(screen.getByText('Alpha'));
    await screen.findByText('Payout Details');
    const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh payouts' }));
    expect(screen.queryByText('Payout Details')).not.toBeInTheDocument();
    await act(async () => pending.resolve(response({ payouts: [{ ...row, status: 'paid' }] })));
    await screen.findByText('Payout Details');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    m.fetch.mockResolvedValueOnce(response({ payouts: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh payouts' }));
    await screen.findByText('No payouts found.');
    expect(screen.queryByText('Payout Details')).not.toBeInTheDocument();
  });
  it('new list result survives an older failed load', async () => {
    const pending = deferred<Response>(); m.fetch.mockReturnValueOnce(pending.promise);
    render(<Payouts />);
    await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh payouts' })); await ready();
    await act(async () => pending.resolve(response({}, 500)));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
  it.each(['generate', 'row'])('%s real MFA cannot dispatch after verification-time invalidation', async kind => {
    render(<Payouts />); await ready(); await startMfa(kind);
    const pending = deferred<Response>();
    m.fetch.mockImplementation((url, options) => url.endsWith('/step-up/verify') ? pending.promise : network(url, options));
    authorize();
    await waitFor(() => expect(m.fetch.mock.calls.some(([url]) => url.endsWith('/step-up/verify'))).toBe(true));
    if (kind === 'generate') fireEvent.change(screen.getByLabelText('Period End'), { target: { value: '2026-03-01' } });
    else fireEvent.click(screen.getByRole('button', { name: 'Refresh payouts' }));
    await act(async () => pending.resolve(response({ session: { access_token: 'refreshed-token', refresh_token: 'synthetic-refresh' } })));
    await waitFor(() => expect(m.setSession).toHaveBeenCalled());
    expect(mutations()).toHaveLength(0);
  });
  it.each(['generate', 'row'])('%s rechecks invalidation after awaiting the refreshed token', async kind => {
    render(<Payouts />); await ready(); await startMfa(kind);
    const pending = deferred<ReturnType<typeof session>>();
    m.getSession.mockImplementation(() => m.rotated ? pending.promise : Promise.resolve(session()));
    authorize();
    await waitFor(() => expect(m.rotated).toBe(true));
    await waitFor(() => expect(m.getSession.mock.calls.length).toBeGreaterThanOrEqual(4));
    if (kind === 'generate') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    else fireEvent.click(screen.getByRole('button', { name: 'Refresh payouts' }));
    await act(async () => pending.resolve(session()));
    expect(mutations()).toHaveLength(0);
  });
  it.each(['generate', 'row'])('%s pending real MFA is revoked by unmount', async kind => {
    const view = render(<Payouts />); await ready(); await startMfa(kind);
    const pending = deferred<Response>();
    m.fetch.mockImplementation((url, options) => url.endsWith('/step-up/verify') ? pending.promise : network(url, options));
    authorize();
    await waitFor(() => expect(m.fetch.mock.calls.some(([url]) => url.endsWith('/step-up/verify'))).toBe(true));
    view.unmount();
    await act(async () => pending.resolve(response({ session: { access_token: 'refreshed-token', refresh_token: 'synthetic-refresh' } })));
    expect(mutations()).toHaveLength(0);
  });
  it.each(['selection', 'close', 'deductions'])('pending MFA is revoked by %s changes', async change => {
    render(<Payouts />); await ready();
    if (change === 'deductions') await startMfa('generate');
    else {
      fireEvent.click(screen.getByText('Alpha'));
      fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[1]);
      await screen.findByPlaceholderText('000000');
    }
    const pending = deferred<Response>();
    m.fetch.mockImplementation((url, options) => url.endsWith('/step-up/verify') ? pending.promise : network(url, options));
    authorize();
    await waitFor(() => expect(m.fetch.mock.calls.some(([url]) => url.endsWith('/step-up/verify'))).toBe(true));
    if (change === 'deductions') fireEvent.change(screen.getByLabelText('Deductions (major units)'), { target: { value: '12.5' } });
    else if (change === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    else fireEvent.click(screen.getAllByText('Alpha')[0]);
    await act(async () => pending.resolve(response({ session: { access_token: 'refreshed-token', refresh_token: 'synthetic-refresh' } })));
    expect(mutations()).toHaveLength(0);
  });
  it('real MFA preserves fractional raw deductions and refreshed Bearer; failed reload never resends', async () => {
    render(<Payouts />); await ready(); await generate();
    const deductions = screen.getByLabelText('Deductions (major units)');
    expect(deductions).toHaveAttribute('step', '100');
    expect(deductions).toHaveAttribute('min', '0');
    expect(screen.queryByText('Deductions (cents)')).not.toBeInTheDocument();
    fireEvent.change(deductions, { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Payout/ }));
    await screen.findByPlaceholderText('000000');
    const prepare = m.fetch.mock.calls.find(([url]) => url.endsWith('/step-up/prepare'))!;
    const binding = JSON.parse(prepare[1].body);
    expect(binding).toEqual({ actionType: 'reseller_payout_generate', targetId: 'r1', params: {
      reseller_id: 'r1', period_start: '2026-01-01', period_end: '2026-02-01', holdback_percent: 0, deductions: 12.5, notes: null,
    } });
    expect(mutations()).toHaveLength(0);
    m.fetch.mockImplementation((url, options) => !options?.method ? Promise.resolve(response({}, 500)) : network(url, options));
    authorize();
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const [, options] = mutations()[0];
    expect(options.headers.Authorization).toBe('Bearer refreshed-token');
    expect(JSON.parse(options.body)).toEqual({ ...binding.params, stepUpId: 'step-1' });
    expect(JSON.parse(options.body)).not.toHaveProperty('gross_commission');
    expect(JSON.parse(options.body)).not.toHaveProperty('net_amount');
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry payouts' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(mutations()).toHaveLength(1);
  });
  it.each([['Approve', 'approve', 'pending'], ['Reject', 'reject', 'pending'], ['Mark as Paid', 'mark_paid', 'approved']])(
    '%s retains operation binding and positive authorization', async (label, action, status) => {
      m.fetch.mockImplementation((url, options) => !options?.method ? Promise.resolve(response({ payouts: [{ ...row, status }] })) : network(url, options));
      render(<Payouts />); await ready();
      fireEvent.click(screen.getByRole('button', { name: label }));
      await screen.findByPlaceholderText('000000');
      const prepare = m.fetch.mock.calls.find(([url]) => url.endsWith('/step-up/prepare'))!;
      expect(JSON.parse(prepare[1].body)).toEqual({ actionType: 'reseller_payout_' + action, targetId: 'p1', params: { action, notes: null } });
      expect(mutations()).toHaveLength(0);
      authorize();
      await waitFor(() => expect(mutations()).toHaveLength(1));
      expect(mutations()[0][0]).toMatch(/\/reseller-payouts\/p1$/);
      expect(mutations()[0][1].headers.Authorization).toBe('Bearer refreshed-token');
      expect(JSON.parse(mutations()[0][1].body)).toEqual({ action, stepUpId: 'step-1' });
    },
  );
});
