// #1103 and admin audit #1108 (Customers page): the rendered page with the real
// useStepUp hook and StepUpDialog. Only fetch and the Supabase client are
// stubbed. Covers suspend/unsuspend through step-up, the role gate, honest
// errors, and "Total spent" counting successful payments only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const PHONE = '2348012345678';
const m = vi.hoisted(() => ({
  role: 'admin', fetch: vi.fn(), setSession: vi.fn(),
  suspensions: [] as Array<{ phone: string; reason: string; suspended_at: string }>,
  saveStatus: 200, saveBody: {} as Record<string, unknown>, customersStatus: 200, listStatus: 200,
  dbCalls: [] as Array<[string, string, unknown]>,
}));

vi.mock('@/lib/supabase', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'order']) q[k] = () => q;
    q.in = (c: string, v: unknown) => { m.dbCalls.push([table, `in:${c}`, v]); return q; };
    q.eq = (c: string, v: unknown) => { m.dbCalls.push([table, c, v]); return q; };
    const rows = table === 'bookings' ? [{ id: 'bk-1', business_id: 'biz-a', status: 'confirmed', total_amount: 5000, date: '2026-11-10', created_at: '2026-11-10T10:00:00Z' }] : [];
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(r);
    return q;
  };
  return {
    supabase: { auth: {
      getSession: async () => ({ data: { session: { access_token: 'token' } } }),
      setSession: m.setSession,
    } },
    adminDb: { from: chain },
  };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: m.role }) }));
import Customers from '../pages/WhatsAppCustomers';

const customersPayload = () => ({
  businesses: [{ id: 'biz-a', name: 'Mama Put Kitchen', country_code: 'NG' }],
  profiles: [],
  bookings: [
    { id: 'bk-1', user_id: null, business_id: 'biz-a', guest_name: 'Ada', guest_phone: '08012345678', canonical_phone: PHONE,
      status: 'confirmed', total_amount: 5000, deposit_amount: 0, created_at: '2026-11-10T10:00:00Z' },
    { id: 'bk-2', user_id: null, business_id: 'biz-a', guest_name: 'Bayo', guest_phone: '07000000000', canonical_phone: null,
      status: 'confirmed', total_amount: 9000, deposit_amount: 0, created_at: '2026-11-09T10:00:00Z' },
  ],
  payments: [
    // Ada: one success (counted), one failed and one pending (not counted).
    { user_id: null, business_id: 'biz-a', booking_id: 'bk-1', amount: 5000, currency: 'NGN', status: 'success', created_at: '2026-11-10T10:05:00Z' },
    { user_id: null, business_id: 'biz-a', booking_id: 'bk-1', amount: 5000, currency: 'NGN', status: 'failed', created_at: '2026-11-10T10:01:00Z' },
    { user_id: null, business_id: 'biz-a', booking_id: 'bk-1', amount: 700, currency: 'NGN', status: 'pending', created_at: '2026-11-10T10:02:00Z' },
    // No user and no booking: no customer row.
    { user_id: null, business_id: 'biz-a', booking_id: null, amount: 123, currency: 'NGN', status: 'success', created_at: '2026-11-08T10:00:00Z' },
  ],
});

beforeEach(() => {
  m.role = 'admin'; m.suspensions = []; m.saveStatus = 200; m.saveBody = { suspended: true, phone: PHONE };
  m.customersStatus = 200; m.listStatus = 200; m.dbCalls = [];
  m.setSession.mockResolvedValue({ error: null });
  m.fetch.mockReset();
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/admin/customers')) {
      return m.customersStatus === 200 ? Response.json(customersPayload()) : Response.json({ error: 'x' }, { status: m.customersStatus });
    }
    if (url.endsWith('/api/admin/customers/suspension') && (!init?.method || init.method === 'GET')) {
      return m.listStatus === 200 ? Response.json({ suspensions: m.suspensions }) : Response.json({ error: 'Unable to load suspended customers' }, { status: m.listStatus });
    }
    if (url.endsWith('/step-up/prepare')) return Response.json({ stepUpId: 'grant-1', factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return Response.json({ session: { access_token: 'after-mfa', refresh_token: 'r' } });
    if (url.endsWith('/api/admin/customers/suspension')) {
      if (m.saveStatus === 200) {
        const body = JSON.parse(String(init!.body));
        m.suspensions = body.suspended ? [{ phone: PHONE, reason: body.reason, suspended_at: '2026-11-17T12:00:00Z' }] : [];
      }
      return Response.json(m.saveBody, { status: m.saveStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calls = (suffix: string, method?: string) => m.fetch.mock.calls.filter(([url, init]) =>
  url.endsWith(suffix) && (!method || (init?.method || 'GET') === method));

async function openAda() {
  fireEvent.click(await screen.findByText('Ada'));
  return screen.findByText('Waaiio access');
}
function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}

describe('Customers: totals (#1108)', () => {
  it('counts successful payments only, once, with no booking amounts and no customer for an orphan payment', async () => {
    render(<Customers />);
    const ada = (await screen.findByText('Ada')).closest('tr')!;
    const cells = within(ada).getAllByRole('cell');
    expect(cells[4].textContent).toBe('1'); // bookings
    expect(cells[5].textContent).toBe('1'); // successful payments
    expect(cells[6].textContent).toMatch(/5,000/);
    const bayo = screen.getByText('Bayo').closest('tr')!;
    expect(within(bayo).getAllByRole('cell')[6].textContent).toBe('—');
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + Ada + Bayo
    expect(screen.getByText('Successful Payments')).toBeTruthy();
  });

  it('a failed customer load shows an error instead of an empty list', async () => {
    m.customersStatus = 500;
    render(<Customers />);
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to load customer data');
  });

  it('a guest customer detail loads bookings by the guest phone', async () => {
    render(<Customers />);
    await openAda();
    await waitFor(() => expect(m.dbCalls).toContainEqual(['bookings', 'guest_phone', '08012345678']));
    // Their payments are the ones linked to those bookings, as in the totals.
    await waitFor(() => expect(m.dbCalls).toContainEqual(['payments', 'in:booking_id', ['bk-1']]));
  });
});

describe('Customers: platform-wide suspension (#1103)', () => {
  it('admin suspends with a reason through step-up; the page then shows the suspension', async () => {
    render(<Customers />);
    await openAda();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a reason');
    expect(calls('/step-up/prepare')).toHaveLength(0);

    // The admin confirms the full number, not a masked one.
    expect(screen.getByText(`+${PHONE}`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Abusive messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await screen.findByText('Confirm operation');
    expect(JSON.parse(String(calls('/step-up/prepare')[0][1].body))).toEqual({
      actionType: 'customer_suspension', targetId: PHONE,
      params: { phone: PHONE, suspended: true, reason: 'Abusive messages' },
    });
    expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(0);

    authorize();
    await waitFor(() => expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(1));
    const [, request] = calls('/api/admin/customers/suspension', 'POST')[0];
    expect(JSON.parse(String(request.body))).toEqual({ phone: PHONE, suspended: true, reason: 'Abusive messages', stepUpId: 'grant-1' });
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer token');
    expect(await screen.findByText('Reason: Abusive messages')).toBeTruthy();
    expect(screen.getByText(/Suspended numbers \(1\)/)).toBeTruthy();
  });

  it('a refused save shows the server error and the number stays unsuspended', async () => {
    m.saveStatus = 403; m.saveBody = { error: 'Step-up authorization invalid, expired, already used, or does not match this operation', code: 'step_up_required' };
    render(<Customers />);
    await openAda();
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Abusive messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await screen.findByText('Confirm operation');
    authorize();
    expect((await screen.findByRole('alert')).textContent).toContain('Step-up authorization invalid');
    expect(screen.queryByText(/Suspended numbers/)).toBeNull();
  });

  it('admin unsuspends from the suspended numbers list', async () => {
    m.suspensions = [{ phone: PHONE, reason: 'Abusive messages', suspended_at: '2026-11-17T12:00:00Z' }];
    m.saveBody = { suspended: false, phone: PHONE };
    render(<Customers />);
    const ada = (await screen.findByText('Ada')).closest('tr')!;
    expect(within(ada).getByText('suspended')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Unsuspend •••• 5678' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unsuspend' }));
    await screen.findByText('Confirm operation');
    expect(JSON.parse(String(calls('/step-up/prepare')[0][1].body)).params).toEqual({ phone: PHONE, suspended: false, reason: null });
    authorize();
    await waitFor(() => expect(screen.queryByText(/Suspended numbers/)).toBeNull());
    expect(JSON.parse(String(calls('/api/admin/customers/suspension', 'POST')[0][1].body))).toEqual({ phone: PHONE, suspended: false, reason: null, stepUpId: 'grant-1' });
  });

  it('support sees the status but no suspend or unsuspend controls', async () => {
    m.role = 'support';
    m.suspensions = [{ phone: PHONE, reason: 'Abusive messages', suspended_at: '2026-11-17T12:00:00Z' }];
    render(<Customers />);
    await openAda();
    expect(screen.getByText('Reason: Abusive messages')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Unsuspend/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suspend from all bots' })).toBeNull();
  });

  it('a customer with no usable number cannot be suspended', async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByText('Bayo'));
    expect(await screen.findByText(/cannot be suspended here/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspend from all bots' })).toBeNull();
  });

  it('a failed suspension list read is shown, and suspending is not offered', async () => {
    m.listStatus = 500;
    render(<Customers />);
    expect((await screen.findByRole('alert')).textContent).toContain('Suspension status is not shown');
    await openAda();
    expect(screen.queryByRole('button', { name: 'Suspend from all bots' })).toBeNull();
  });
});
