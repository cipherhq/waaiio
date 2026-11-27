// #1166 r7 F1–F6a (Customers page): blocking a customer's emails, rendered
// with the real useStepUp hook and StepUpDialog. Only fetch and the Supabase
// client are stubbed. Covers the candidate list (unticked, labelled), adding
// an email by hand, the step-up bound to the exact set of emails, email-only
// blocks, the one list of numbers and emails, per-email unblock, the unblock
// dialog, and the support role (view only).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const PHONE = '2348012345678';
const USER = '11111111-1111-4111-8111-111111111111';
type Block = { email: string; phone: string | null; reason: string; blocked_at: string };
const m = vi.hoisted(() => ({
  role: 'admin', fetch: vi.fn(),
  suspensions: [] as Array<{ phone: string; reason: string; suspended_at: string }>,
  emailBlocks: [] as Block[],
  candidates: [] as Array<{ email: string; source: string; last_seen: string | null; blocked: boolean }>,
  candidatesStatus: 200,
  saveStatus: 200,
  /** When set, the candidate response for this phone waits for release(). */
  holdPhone: null as string | null,
  release: null as null | (() => void),
}));

vi.mock('@/lib/supabase', () => {
  const chain = () => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'order', 'in', 'eq']) q[k] = () => q;
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
    return q;
  };
  return {
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }), setSession: vi.fn().mockResolvedValue({ error: null }) } },
    adminDb: { from: chain },
  };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: m.role }) }));
import Customers from '../pages/WhatsAppCustomers';

const customersPayload = () => ({
  businesses: [{ id: 'biz-a', name: 'Mama Put Kitchen', country_code: 'NG' }],
  profiles: [{ id: USER, first_name: 'Chi', last_name: 'Obi', email: 'chi@example.com', phone: null, canonical_phone: null }],
  bookings: [
    { id: 'bk-1', user_id: null, business_id: 'biz-a', guest_name: 'Ada', guest_phone: '08012345678', guest_email: 'ada@example.com', canonical_phone: PHONE,
      status: 'confirmed', total_amount: 5000, deposit_amount: 0, created_at: '2026-11-10T10:00:00Z' },
    { id: 'bk-2', user_id: USER, business_id: 'biz-a', guest_name: 'Chi', guest_phone: null, guest_email: null, canonical_phone: null,
      status: 'confirmed', total_amount: 9000, deposit_amount: 0, created_at: '2026-11-09T10:00:00Z' },
    // A guest with no usable number and no account.
    { id: 'bk-3', user_id: null, business_id: 'biz-a', guest_name: 'Bayo', guest_phone: '0700', guest_email: 'bayo@example.com', canonical_phone: null,
      status: 'confirmed', total_amount: 1000, deposit_amount: 0, created_at: '2026-11-08T10:00:00Z' },
  ],
  payments: [],
});

beforeEach(() => {
  m.role = 'admin'; m.suspensions = []; m.emailBlocks = []; m.candidatesStatus = 200; m.saveStatus = 200;
  m.holdPhone = null; m.release = null;
  m.candidates = [
    { email: 'ada@example.com', source: 'proved', last_seen: '2026-11-10T10:00:00Z', blocked: false },
    { email: 'ada.work@example.com', source: 'account', last_seen: null, blocked: false },
    { email: 'ada.old@example.com', source: 'unrecorded', last_seen: '2026-01-02T10:00:00Z', blocked: false },
    { email: 'ada.site@example.com', source: 'web', last_seen: null, blocked: false },
    { email: 'ada.biz@example.com', source: 'dashboard', last_seen: null, blocked: false },
    { email: 'ada.api@example.com', source: 'api', last_seen: null, blocked: false },
    { email: 'gone@example.com', source: 'account', last_seen: null, blocked: true },
  ];
  m.fetch.mockReset();
  m.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/admin/customers')) return Response.json(customersPayload());
    if (url.includes('/api/admin/customers/suspension/candidates')) {
      if (m.holdPhone && url.includes(`phone=${m.holdPhone}`)) {
        await new Promise<void>(resolve => { m.release = resolve; });
        return Response.json({ candidates: [{ email: 'ada-private@example.com', source: 'account', last_seen: null, blocked: false }] });
      }
      if (url.includes(`userId=${USER}`)) return Response.json({ candidates: [{ email: 'chi@example.com', source: 'account', last_seen: null, blocked: false }] });
      return m.candidatesStatus === 200 ? Response.json({ candidates: m.candidates }) : Response.json({ error: 'Unable to load this customer’s emails' }, { status: 500 });
    }
    if (url.endsWith('/api/admin/customers/suspension') && (!init?.method || init.method === 'GET')) {
      return Response.json({ suspensions: m.suspensions, emailBlocks: m.emailBlocks });
    }
    if (url.endsWith('/step-up/prepare')) return Response.json({ stepUpId: 'grant-1', factorId: 'factor', challengeId: '' });
    if (url.endsWith('/step-up/verify')) return Response.json({ session: { access_token: 'after-mfa', refresh_token: 'r' } });
    if (url.endsWith('/api/admin/customers/suspension')) {
      const body = JSON.parse(String(init!.body));
      if (m.saveStatus !== 200) return Response.json({ error: 'Already blocked', suspended: true }, { status: m.saveStatus });
      if (body.suspended) {
        if (body.phone) m.suspensions = [{ phone: body.phone, reason: body.reason, suspended_at: '2026-11-27T12:00:00Z' }];
        m.emailBlocks = [...m.emailBlocks, ...body.emails.map((email: string) => ({ email, phone: body.phone, reason: body.reason, blocked_at: '2026-11-27T12:00:00Z' }))];
      } else {
        if (body.phone) m.suspensions = [];
        m.emailBlocks = m.emailBlocks.filter(b => !body.emails.includes(b.email));
      }
      return Response.json({ suspended: body.suspended, phone: body.phone, phoneChanged: !!body.phone, emails: body.emails });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calls = (suffix: string, method?: string) => m.fetch.mock.calls.filter(([url, init]) =>
  (url as string).includes(suffix) && (!method || (init?.method || 'GET') === method));
const prepared = (i = 0) => JSON.parse(String(calls('/step-up/prepare')[i][1].body));
const saved = (i = 0) => JSON.parse(String(calls('/api/admin/customers/suspension', 'POST')[i][1].body));
function authorize() {
  fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
}
async function openCustomer(name: string) {
  fireEvent.click(await screen.findByText(name));
  return screen.findByText('Waaiio access');
}
const esc = (email: string) => new RegExp(`^${email.replace(/[.+]/g, '\\$&')}`);
const box = (email: string) => screen.getByRole('checkbox', { name: esc(email) }) as HTMLInputElement;

describe('Block dialog: candidate emails (F1, F2, F3)', () => {
  it('lists the number and every candidate email unticked, with the Owner labels; blocked ones cannot be ticked', async () => {
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    expect(await screen.findByText('Also block these emails')).toBeTruthy();
    expect(screen.getByText('Tick the emails to block. Nothing is blocked unless you tick it.')).toBeTruthy();
    expect(screen.getByText(`+${PHONE}`)).toBeTruthy();
    await screen.findByRole('checkbox', { name: esc('ada@example.com') });
    expect(JSON.parse(JSON.stringify(calls('/candidates').map(([u]) => String(u).split('?')[1])))).toEqual([`phone=${PHONE}`]);
    for (const c of m.candidates) expect(box(c.email).checked).toBe(false);
    expect(box('gone@example.com').disabled).toBe(true);
    for (const label of ['Proved with a code', 'Account', 'Booking (source not recorded)', 'Website',
      'Booking added by the business', 'Booking from the business’s booking system']) {
      expect(screen.getAllByText(new RegExp(`^${label.replace(/[()]/g, '\\$&')}`)).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: 'Block number' })).toBeTruthy();
  });

  it('adds an email by hand (format checked, duplicates refused), shown ticked as "Added by you"', async () => {
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    await screen.findByRole('checkbox', { name: esc('ada@example.com') });
    const field = screen.getByLabelText('Add an email');
    fireEvent.change(field, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    fireEvent.change(field, { target: { value: ' ADA@example.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('This email is already in the list.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Second@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(box('second@example.com').checked).toBe(true);
    expect(screen.getByText('Added by you')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Block number and 1 email' })).toBeTruthy();
  });
});

describe('Block: one step-up bound to the number, reason and ticked emails (F4, S4)', () => {
  it('blocks the number and the ticked emails, sorted and lower-cased, and names the count', async () => {
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    await screen.findByRole('checkbox', { name: esc('ada@example.com') });
    fireEvent.click(box('ada.work@example.com'));
    fireEvent.click(box('ada@example.com'));
    fireEvent.change(screen.getByLabelText('Add an email'), { target: { value: 'Zed@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Abusive messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block number and 3 emails' }));
    expect(await screen.findByText(/and block 3 emails/)).toBeTruthy();
    const emails = ['ada.work@example.com', 'ada@example.com', 'zed@example.com'];
    expect(prepared()).toEqual({ actionType: 'customer_suspension', targetId: PHONE, params: { phone: PHONE, suspended: true, reason: 'Abusive messages', emails } });
    authorize();
    await waitFor(() => expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(1));
    expect(saved()).toEqual({ phone: PHONE, suspended: true, reason: 'Abusive messages', emails, stepUpId: 'grant-1' });
    expect(await screen.findByText(/Suspended numbers and emails \(4\)/)).toBeTruthy();
  });

  it('Cancel changes nothing', async () => {
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    await screen.findByRole('checkbox', { name: esc('ada@example.com') });
    fireEvent.click(box('ada@example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls('/step-up/prepare')).toHaveLength(0);
    expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(0);
  });

  it('a late candidate list from an earlier dialog is ignored', async () => {
    m.holdPhone = PHONE;
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    await waitFor(() => expect(m.release).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await openCustomer('Chi Obi');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await screen.findByRole('checkbox', { name: esc('chi@example.com') });
    m.release!();
    await new Promise(r => setTimeout(r, 20));
    expect(screen.getAllByRole('checkbox').map(c => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual([expect.stringMatching(/^chi@example\.com/)]);
  });

  it('opening Unsuspend while a Block lookup is still running shows no stale "Loading emails…"', async () => {
    m.holdPhone = PHONE;
    m.suspensions = [{ phone: PHONE, reason: 'Abusive messages', suspended_at: '2026-11-17T12:00:00Z' }];
    render(<Customers />);
    await openCustomer('Ada');
    const modal = screen.getByText('Waaiio access').closest('div')!;
    fireEvent.click(within(modal).getByRole('button', { name: 'Block an email' }));
    await waitFor(() => expect(m.release).not.toBeNull());
    expect(screen.getByText('Loading emails…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(modal).getByRole('button', { name: 'Unsuspend' }));
    await screen.findByRole('button', { name: 'Unblock number' });
    expect(screen.queryByText('Loading emails…')).toBeNull();
    m.release!();
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByText('Loading emails…')).toBeNull();
  });

  it('a reason is counted in characters: two emoji are too short', async () => {
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: '\u{1F600}\u{1F600}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block number' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a reason');
    expect(calls('/step-up/prepare')).toHaveLength(0);
  });

  it('a refused save shows the server message and keeps the dialog open', async () => {
    m.saveStatus = 409;
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    await screen.findByRole('checkbox', { name: esc('ada@example.com') });
    fireEvent.click(box('ada@example.com'));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Abusive messages' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block number and 1 email' }));
    await screen.findByText('Confirm operation');
    authorize();
    expect((await screen.findByRole('alert')).textContent).toContain('Already blocked');
    expect(screen.getByRole('button', { name: 'Block number and 1 email' })).toBeTruthy();
  });

  it('if the candidate list cannot load, says so and still allows blocking the number', async () => {
    m.candidatesStatus = 500;
    render(<Customers />);
    await openCustomer('Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Suspend from all bots' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to load this customer’s emails');
    expect(screen.getByRole('button', { name: 'Block number' })).toBeTruthy();
  });
});

describe('Email-only block (F5a)', () => {
  it('a customer with no usable number: "Block" opens the dialog without a number; target is the email', async () => {
    m.candidates = [{ email: 'chi@example.com', source: 'account', last_seen: null, blocked: false }];
    render(<Customers />);
    await openCustomer('Chi Obi');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    await screen.findByRole('checkbox', { name: esc('chi@example.com') });
    expect(String(calls('/candidates')[0][0]).split('?')[1]).toBe(`userId=${USER}`);
    expect(screen.queryByText(/will be blocked from every Waaiio bot/)).toBeNull();
    fireEvent.click(box('chi@example.com'));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Chargebacks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block 1 email' }));
    await screen.findByText('Confirm operation');
    expect(prepared()).toEqual({ actionType: 'customer_suspension', targetId: 'chi@example.com',
      params: { phone: null, suspended: true, reason: 'Chargebacks', emails: ['chi@example.com'] } });
    authorize();
    await waitFor(() => expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(1));
    expect(saved()).toMatchObject({ phone: null, emails: ['chi@example.com'] });
  });

  it('a guest with no usable number and no account gets the dialog with no lookup and no error', async () => {
    render(<Customers />);
    await openCustomer('Bayo');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(await screen.findByLabelText('Add an email')).toBeTruthy();
    expect(calls('/candidates')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Also block these emails')).toBeTruthy();
  });

  it('needs a ticked or added email', async () => {
    m.candidates = [];
    render(<Customers />);
    await openCustomer('Chi Obi');
    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    fireEvent.change(await screen.findByLabelText(/^Reason/), { target: { value: 'Chargebacks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block 0 emails' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Tick or add at least one email.');
    expect(calls('/step-up/prepare')).toHaveLength(0);
  });

  it('"Block an email" on the list opens the add field only, with no candidate lookup', async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Block an email' }));
    fireEvent.change(await screen.findByLabelText('Add an email'), { target: { value: 'x@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Fraud' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block 1 email' }));
    await screen.findByText('Confirm operation');
    expect(calls('/candidates')).toHaveLength(0);
    expect(prepared().params).toEqual({ phone: null, suspended: true, reason: 'Fraud', emails: ['x@example.com'] });
  });
});

describe('Blocked list and unblocking (F5, F6, F6a)', () => {
  beforeEach(() => {
    m.suspensions = [{ phone: PHONE, reason: 'Abusive messages', suspended_at: '2026-11-17T12:00:00Z' }];
    m.emailBlocks = [
      { email: 'ada@example.com', phone: PHONE, reason: 'Abusive messages', blocked_at: '2026-11-17T12:00:00Z' },
      { email: 'ada.work@example.com', phone: PHONE, reason: 'Abusive messages', blocked_at: '2026-11-17T12:00:00Z' },
      { email: 'solo@example.com', phone: null, reason: 'Fraud', blocked_at: '2026-11-18T12:00:00Z' },
    ];
  });

  it('shows numbers and emails in one list with their type', async () => {
    render(<Customers />);
    const heading = await screen.findByText(/Suspended numbers and emails \(4\)/);
    const table = heading.closest('div.mt-8')!.querySelector('table')!;
    const types = within(table).getAllByRole('row').slice(1).map(r => within(r).getAllByRole('cell')[0].textContent);
    expect(types.sort()).toEqual(['Email', 'Email', 'Email', 'Number']);
    expect(within(table).getByText('solo@example.com')).toBeTruthy();
  });

  it('unblocks one email on its own with its own step-up; the number stays blocked', async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock solo@example.com' }));
    await screen.findByText('Confirm operation');
    expect(prepared()).toEqual({ actionType: 'customer_suspension', targetId: 'solo@example.com',
      params: { phone: null, suspended: false, reason: null, emails: ['solo@example.com'] } });
    authorize();
    await waitFor(() => expect(screen.getByText(/Suspended numbers and emails \(3\)/)).toBeTruthy());
    expect(m.suspensions).toHaveLength(1);
  });

  it('a blocked customer shows the number and every blocked email; more emails can be blocked', async () => {
    m.candidates = [{ email: 'new@example.com', source: 'web', last_seen: null, blocked: false }];
    render(<Customers />);
    await openCustomer('Ada');
    expect(screen.getByText('Blocked emails')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Unblock ada.work@example.com' }).length).toBeGreaterThan(0);
    // The customer's own "Block an email" (the list has one too, with no candidates).
    const modal = screen.getByText('Waaiio access').closest('div')!;
    fireEvent.click(within(modal).getByRole('button', { name: 'Block an email' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: esc('new@example.com') }));
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Same person' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block 1 email' }));
    await screen.findByText('Confirm operation');
    // An email-only change linked to the customer's number: the number itself is not touched.
    expect(prepared()).toEqual({ actionType: 'customer_suspension', targetId: 'new@example.com',
      params: { phone: null, linkPhone: PHONE, suspended: true, reason: 'Same person', emails: ['new@example.com'] } });
    authorize();
    await waitFor(() => expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(1));
    expect(saved()).toEqual({ phone: null, linkPhone: PHONE, suspended: true, reason: 'Same person', emails: ['new@example.com'], stepUpId: 'grant-1' });
  });

  it('unblocking the number lists its blocked emails unticked and unblocks only the ticked ones', async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unsuspend •••• 5678' }));
    expect(await screen.findByText('Also unblock these emails')).toBeTruthy();
    expect(screen.getByText('Tick the emails to unblock. Emails you don’t tick stay blocked.')).toBeTruthy();
    expect(box('ada@example.com').checked).toBe(false);
    expect(box('ada.work@example.com').checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: esc('solo@example.com') })).toBeNull();
    fireEvent.click(box('ada@example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Unblock number and 1 email' }));
    await screen.findByText('Confirm operation');
    expect(prepared()).toEqual({ actionType: 'customer_suspension', targetId: PHONE,
      params: { phone: PHONE, suspended: false, reason: null, emails: ['ada@example.com'] } });
    authorize();
    await waitFor(() => expect(calls('/api/admin/customers/suspension', 'POST')).toHaveLength(1));
    expect(m.emailBlocks.map(b => b.email).sort()).toEqual(['ada.work@example.com', 'solo@example.com']);
  });

  it('support sees blocked emails but cannot block or unblock', async () => {
    m.role = 'support';
    render(<Customers />);
    await openCustomer('Ada');
    expect(screen.getByText('Blocked emails')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Unblock/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Block an email' })).toBeNull();
    expect(calls('/candidates')).toHaveLength(0);
  });
});
