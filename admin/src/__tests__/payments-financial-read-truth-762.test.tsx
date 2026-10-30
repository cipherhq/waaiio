import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  from: vi.fn(), getSession: vi.fn(), setSession: vi.fn(), fetch: vi.fn(), audit: vi.fn(),
  role: 'admin', token: 'synthetic-before-mfa', refresh: null as null | (() => Promise<void>),
}));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: h.from }, supabase: { auth: { getSession: h.getSession, setSession: h.setSession } } }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: h.role, userId: 'synthetic-admin' }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: h.audit }));
import Payments from '@/pages/Payments';

type Result = { data: unknown[] | null; error: unknown };
const plans: Record<string, () => Promise<Result>> = {};
const updates: string[] = [];
const sources = ['payments', 'bookings', 'orders', 'businesses', 'refund_requests'];
const original = {
  id: 'payment-ordinary', business_id: 'ordinary', amount: 100, refund_amount: 0, currency: 'USD',
  gateway: 'stripe', gateway_reference: 'reference-ordinary', status: 'success', payment_method: 'card',
  booking_id: 'booking-1', order_id: 'order-1', customer_id: null, metadata: null,
  created_at: '2026-10-01T12:00:00Z',
};
const request = { id: 'request-ordinary', payment_id: original.id, business_id: 'ordinary', customer_name: 'Synthetic Customer', customer_phone: '', amount: 25, reason: 'Synthetic reason', status: 'pending', created_at: original.created_at };
function rows(table: string, data: unknown[]) { plans[table] = async () => ({ data, error: null }); }
function failed(table: string, mode: string) {
  plans[table] = async () => {
    if (mode === 'rejected') throw new Error('Synthetic network failure');
    return { data: mode === 'null' ? null : [], error: mode === 'returned' ? { message: 'Synthetic read error' } : null };
  };
}
function response(data: unknown) { return new Response(JSON.stringify(data), { status: 200 }); }
function calls(path: string) { return h.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)); }
async function ready() { await screen.findByRole('button', { name: 'Export CSV' }); expect(screen.queryByRole('alert')).not.toBeInTheDocument(); }
async function refresh() { await act(async () => { await h.refresh!(); }); }

beforeEach(() => {
  vi.clearAllMocks(); h.role = 'admin'; h.token = 'synthetic-before-mfa'; h.refresh = null; updates.length = 0;
  Object.keys(plans).forEach(k => delete plans[k]);
  rows('payments', [original]); rows('bookings', [{ id: 'booking-1', business_id: 'ordinary', reference_code: 'ORDINARY-REF' }]);
  rows('orders', [{ id: 'order-1', business_id: 'ordinary', reference_code: 'ORDER-REF' }]);
  rows('businesses', [{ id: 'ordinary', name: 'Synthetic Store', category: 'retail' }]); rows('refund_requests', [request]);
  h.from.mockImplementation((table: string) => {
    let mutation = false;
    const q: any = {
      select: () => q, order: () => q, in: () => q, eq: () => q,
      update: () => { mutation = true; updates.push(table); return q; },
      then: (resolve: any, reject: any) => (mutation ? Promise.resolve({ data: [], error: null }) : plans[table]()).then(resolve, reject),
    }; return q;
  });
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
  const ownedInterval = Symbol('Payments refresh interval') as unknown as ReturnType<typeof setInterval>;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const [callback, delay] = args;
    if (delay === 30_000) {
      h.refresh = callback as () => Promise<void>;
      return ownedInterval;
    }
    return nativeSetInterval(...args);
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(handle => {
    if (handle !== ownedInterval) nativeClearInterval(handle);
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true); vi.spyOn(window, 'alert').mockImplementation(() => {});
  h.getSession.mockImplementation(async () => ({ data: { session: { access_token: h.token, user: { id: 'synthetic-admin' } } } }));
  h.setSession.mockImplementation(async ({ access_token }) => { h.token = access_token; return { error: null }; });
  h.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/step-up/prepare')) return response({ stepUpId: 'synthetic-step-up', factorId: 'synthetic-factor', challengeId: 'synthetic-challenge' });
    if (url.endsWith('/step-up/verify')) return response({ session: { access_token: 'synthetic-after-mfa', refresh_token: 'synthetic-refresh' } });
    if (url.endsWith('/payments/refund')) return response({ refundId: 'synthetic-refund' });
    throw new Error('Unexpected synthetic endpoint: ' + url);
  });
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('#762 mounted Payments read truth', () => {
  for (const mode of ['returned', 'null', 'rejected']) {
    it.each(sources)('%s ' + mode + ' read hides incomplete data and retries', async table => {
      const prior = plans[table]; failed(table, mode);
      render(<Payments />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Payment data unavailable');
      expect(screen.queryByText('No payments found')).not.toBeInTheDocument();
      expect(screen.queryByText('Synthetic Store')).not.toBeInTheDocument();
      expect(screen.queryByText('Synthetic Customer')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Approve & Refund' })).not.toBeInTheDocument();
      expect(h.fetch).not.toHaveBeenCalled(); expect(updates).toEqual([]);
      plans[table] = prior;
      fireEvent.click(screen.getByRole('button', { name: 'Retry payment data' }));
      await screen.findByText('Synthetic Store'); await ready();
      expect(screen.getByText('Synthetic Customer')).toBeInTheDocument();
    });
  }
  it('renders true empty only after successful reads and skips unneeded relation queries', async () => {
    rows('payments', []); rows('refund_requests', []);
    render(<Payments />); await ready();
    expect(screen.getByText('No payments found')).toBeInTheDocument();
    expect(h.from.mock.calls.map(([table]) => table)).toEqual(['payments', 'refund_requests']);
  });
  it('does not publish payments while the final refund-request read is pending', async () => {
    let release!: (r: Result) => void;
    plans.refund_requests = () => new Promise(resolve => { release = resolve; });
    render(<Payments />);
    await waitFor(() => expect(h.from).toHaveBeenCalledWith('refund_requests'));
    expect(screen.queryByText('Synthetic Store')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    await act(async () => { release({ data: [], error: { message: 'Synthetic late error' } }); });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Store')).not.toBeInTheDocument();
  });
  it.each(['returned', 'null', 'rejected'])('failed refresh (%s) hides stale results, cancels pending MFA and denies refund actions', async mode => {
    render(<Payments />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Refund' }));
    await screen.findByText('Confirm operation');
    const before = h.fetch.mock.calls.length;
    failed('refund_requests', mode); await refresh();
    expect(screen.getByRole('alert')).toHaveTextContent('Previous results are stale');
    expect(screen.queryByText('Synthetic Store')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirm operation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Refund' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve & Refund' })).not.toBeInTheDocument();
    expect(h.fetch).toHaveBeenCalledTimes(before); expect(updates).toEqual([]);
    rows('refund_requests', [request]); fireEvent.click(screen.getByRole('button', { name: 'Retry payment data' }));
    await screen.findByText('Synthetic Store'); await ready();
  });
  it('denies an already-verifying refund when a read fails before MFA completes', async () => {
    render(<Payments />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Refund' })); await screen.findByText('Confirm operation');
    let release!: (r: Response) => void;
    const normal = h.fetch.getMockImplementation()!;
    h.fetch.mockImplementation((url: string, init: RequestInit) => url.endsWith('/step-up/verify') ? new Promise(resolve => { release = resolve; }) : normal(url, init));
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(calls('/step-up/verify')).toHaveLength(1));
    failed('payments', 'returned'); await refresh();
    await act(async () => { release(response({ session: { access_token: 'synthetic-after-mfa', refresh_token: 'synthetic-refresh' } })); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(calls('/payments/refund')).toHaveLength(0); expect(updates).toEqual([]);
  });
  it.each(['retail', 'church', 'mosque', 'ngo', 'crowdfunding_org'])('keeps canonical USD for %s refund row, confirmation and real MFA dialog', async category => {
    rows('businesses', [{ id: 'ordinary', name: 'Synthetic Store', category }]);
    render(<Payments />); await ready();
    const row = screen.getByText('Synthetic Customer').parentElement!;
    expect(row).toHaveTextContent('$25'); expect(row).not.toHaveTextContent('₦');
    if (category === 'retail') expect(screen.getByText('Synthetic Store')).toBeInTheDocument();
    else expect(screen.queryByText('Synthetic Store')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Refund' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('$25'));
    expect(await screen.findByText('Approve refund request of $25 for Synthetic Customer')).toBeInTheDocument();
    const prepare = calls('/step-up/prepare')[0][1];
    expect(JSON.parse(prepare.body)).toEqual({ actionType: 'refund', targetId: original.id, params: { businessId: 'ordinary', amount: 25, reason: 'Synthetic reason' } });
    expect(calls('/payments/refund')).toHaveLength(0);
  });
  it.each(['missing currency', 'missing payment'])('shows unknown without inventing NGN when %s', async kind => {
    rows('payments', kind === 'missing payment' ? [] : [{ ...original, currency: null }]);
    render(<Payments />); await ready();
    expect(screen.getByText('Synthetic Customer').parentElement).toHaveTextContent('UNKNOWN 25');
    expect(document.body).not.toHaveTextContent('₦');
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Refund' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN 25'));
    expect(await screen.findByText('Approve refund request of UNKNOWN 25 for Synthetic Customer')).toBeInTheDocument();
  });
  it('uses canonical GBP through ordinary detail refund and refreshed-token execution', async () => {
    rows('payments', [{ ...original, currency: 'GBP' }]); rows('refund_requests', []);
    render(<Payments />); await ready();
    const row = screen.getByText('Synthetic Store').closest('tr')!;
    expect(row).toHaveTextContent('£100');
    fireEvent.click(row);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));
    expect(await screen.findByText('Refund £25 for payment payment-...')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(calls('/payments/refund')).toHaveLength(1));
    const sent = calls('/payments/refund')[0][1];
    expect(sent.headers.Authorization).toBe('Bearer synthetic-after-mfa');
    expect(JSON.parse(sent.body)).toMatchObject({ paymentId: original.id, businessId: 'ordinary', amount: 25, stepUpId: 'synthetic-step-up' });
    expect(h.setSession).toHaveBeenCalledWith({ access_token: 'synthetic-after-mfa', refresh_token: 'synthetic-refresh' });
  });
  it('preserves request approval step-up and refreshed token before its synthetic mutation', async () => {
    render(<Payments />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Refund' })); await screen.findByText('Confirm operation');
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await waitFor(() => expect(updates).toEqual(['refund_requests']));
    const sent = calls('/payments/refund')[0][1];
    expect(sent.headers.Authorization).toBe('Bearer synthetic-after-mfa');
    expect(JSON.parse(sent.body)).toEqual({ paymentId: original.id, businessId: 'ordinary', amount: 25, reason: 'Synthetic reason', stepUpId: 'synthetic-step-up' });
  });
});

it('keeps unknown currency explicit in ordinary detail and MFA cues', async () => {
  rows('payments', [{ ...original, currency: null }]); rows('refund_requests', []);
  render(<Payments />); await ready();
  const row = screen.getByText('Synthetic Store').closest('tr')!;
  expect(row).toHaveTextContent('UNKNOWN 100');
  fireEvent.click(row);
  expect(screen.getByRole('spinbutton')).toHaveAttribute('placeholder', 'Amount (max UNKNOWN 100)');
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Refund' }));
  expect(await screen.findByText('Refund UNKNOWN 25 for payment payment-...')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('₦');
  expect(calls('/payments/refund')).toHaveLength(0);
});
