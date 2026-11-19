/**
 * Admin "Email link" / "Copy link" (Owner decision 2026-11-18), rendered on
 * the real Tickets, Bookings (bookings and property stays) and Orders pages
 * with a fake admin API.
 * Proves the buttons call /api/admin/customer-links/resend, show the server's
 * answer, stay off with a reason when there is no customer email, and never
 * write to a table directly.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fixtures: {} as Record<string, unknown[]>,
  directWrites: [] as Array<{ table: string; kind: string }>,
  fetch: vi.fn(),
  copied: [] as string[],
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'order', 'eq', 'in', 'limit', 'range', 'not', 'gte', 'lte', 'is', 'neq', 'gt', 'lt', 'or', 'ilike']) q[m] = () => q;
    for (const kind of ['update', 'delete', 'insert', 'upsert']) q[kind] = () => { h.directWrites.push({ table, kind }); return q; };
    q.maybeSingle = async () => ({ data: (h.fixtures[table] || [])[0] ?? null, error: null });
    q.single = q.maybeSingle;
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: h.fixtures[table] || [], error: null, count: (h.fixtures[table] || []).length }).then(resolve, reject);
    return q;
  };
  const auth = { getSession: async () => ({ data: { session: { access_token: 'synthetic-token', user: { id: 'admin-self' } } } }) };
  return { adminDb: { from, auth }, supabase: { from, auth } };
});
const session = vi.hoisted(() => ({ userId: 'admin-self', email: 'a@example.test', role: 'admin' }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => session }));

import Tickets from '@/pages/Tickets';
import Bookings from '@/pages/Bookings';
import Orders from '@/pages/Orders';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Handler = (url: string, body: Record<string, unknown>) => Response;
let api: Handler;
const resendCalls = () => h.fetch.mock.calls
  .filter(([url]) => String(url).endsWith('/api/admin/customer-links/resend'))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const BIZ = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const LINK = 'https://app.example.test/tickets/TK-AAA111';

beforeEach(() => {
  h.fixtures = {
    event_tickets: [{ id: ID, business_id: BIZ, event_id: 'ev', ticket_code: 'TK-AAA111', ticket_number: 1, status: 'valid', guest_name: 'Ada', created_at: '2026-11-01T00:00:00Z' }],
  };
  h.directWrites = [];
  h.copied = [];
  api = (_url, body) => body.check
    ? json({ link: LINK, canEmail: true, reason: null, emailHint: 'a•••@example.test' })
    : json({ sent: true, sentTo: 'a•••@example.test', auditRecorded: true });
  h.fetch.mockReset();
  h.fetch.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(api(String(url), JSON.parse(String(init?.body || '{}')))));
  vi.stubEnv('VITE_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', h.fetch);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { h.copied.push(text); }) },
  });
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function openTicket() {
  render(<Tickets />);
  fireEvent.click((await screen.findAllByText('TK-AAA111')).find(e => e.closest('tr'))!);
}

describe('admin Tickets: customer link', () => {
  it('Email link sends through the admin route and shows the masked address', async () => {
    await openTicket();
    expect(await screen.findByText('Sends to a•••@example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Link emailed to a•••@example.test.');
    expect(resendCalls()).toEqual([{ kind: 'ticket', id: ID, check: true }, { kind: 'ticket', id: ID }]);
    expect(h.directWrites).toEqual([]);
  });

  it('no customer email: Email link is off with the reason, Copy link copies the link', async () => {
    api = (_url, body) => body.check
      ? json({ link: LINK, canEmail: false, reason: 'No customer email on file.', emailHint: null })
      : json({ error: 'should not be called' }, 500);
    await openTicket();
    expect(await screen.findByText('Email is off: No customer email on file.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email link' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(h.copied).toEqual([LINK]));
    expect(resendCalls()).toHaveLength(1);
  });

  it('a refused send shows the server reason', async () => {
    api = (_url, body) => body.check
      ? json({ link: LINK, canEmail: true, reason: null, emailHint: 'a•••@example.test' })
      : json({ error: 'This link was emailed several times in the last hour. Try again later.' }, 429);
    await openTicket();
    await screen.findByText('Sends to a•••@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email not sent: This link was emailed several times in the last hour. Try again later.');
  });
});

describe('admin Bookings: confirmation link', () => {
  const BOOKING = '44444444-4444-4444-8444-444444444444';
  const STAY = '55555555-5555-4555-8555-555555555555';
  beforeEach(() => {
    h.fixtures = {
      bookings: [{ id: BOOKING, business_id: BIZ, user_id: null, service_id: null, date: '2026-12-01', time: '10:00', party_size: 1, status: 'confirmed', flow_type: 'scheduling', total_amount: 0, deposit_amount: 0, deposit_status: 'none', guest_name: 'Bisi Booker', guest_phone: null, staff_name: null, reference_code: 'BK-REF1', channel: 'whatsapp', notes: null, special_requests: null, created_at: '2026-11-02T00:00:00Z', updated_at: null }],
      reservations: [{ id: STAY, business_id: BIZ, user_id: null, check_in: '2026-12-05', check_out: '2026-12-07', nights: 2, guests: 2, status: 'confirmed', guest_name: 'Sade Stayer', reference_code: 'RES-1', created_at: '2026-11-01T00:00:00Z' }],
      businesses: [{ id: BIZ, name: 'Sunny', category: 'salon', country_code: 'NG' }],
    };
  });

  it('a booking shows Email link and Copy link and checks the booking link', async () => {
    render(<Bookings />);
    fireEvent.click((await screen.findByText('Bisi Booker')).closest('tr')!);
    expect(await screen.findByRole('button', { name: 'Email link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    await waitFor(() => expect(resendCalls()).toEqual([{ kind: 'booking', id: BOOKING, check: true }]));
  });

  it('a property stay checks the stay link (kind stay), sends through the admin route, and copies the /stays link', async () => {
    const stayLink = 'https://app.example.test/stays/0123456789abcdef0123456789abcdef';
    api = (_url, body) => body.check
      ? json({ link: stayLink, canEmail: true, reason: null, emailHint: 's•••@example.test' })
      : json({ sent: true, sentTo: 's•••@example.test', auditRecorded: true });
    render(<Bookings />);
    fireEvent.click((await screen.findByText('Sade Stayer')).closest('tr')!);
    expect(await screen.findByText('Sends to s•••@example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(h.copied).toEqual([stayLink]));
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Link emailed to s•••@example.test.');
    expect(resendCalls()).toEqual([{ kind: 'stay', id: STAY, check: true }, { kind: 'stay', id: STAY }]);
    expect(h.directWrites).toEqual([]);
  });

  it('a stay with no customer email has Email link off with the reason', async () => {
    api = (_url, body) => body.check
      ? json({ link: 'https://app.example.test/stays/0123456789abcdef0123456789abcdef', canEmail: false, reason: 'No customer email on file.', emailHint: null })
      : json({ error: 'should not be called' }, 500);
    render(<Bookings />);
    fireEvent.click((await screen.findByText('Sade Stayer')).closest('tr')!);
    expect(await screen.findByText('Email is off: No customer email on file.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email link' })).toBeDisabled();
    expect(resendCalls()).toHaveLength(1);
  });
});

describe('admin Orders: confirmation link', () => {
  const ORDER = '66666666-6666-4666-8666-666666666666';
  it('an order shows Email link and Copy link and checks the order link', async () => {
    const order = { id: ORDER, business_id: BIZ, business_name: 'Sunny', customer_name: 'Ola Orderer', items_count: 1, total_amount: 1000, currency: 'NGN', status: 'confirmed', created_at: '2026-11-03T00:00:00Z', updated_at: null, delivery_address: null, delivery_phone: null, notes: null, reference_code: 'BW-O1234' };
    api = (url, body) => {
      if (url.includes('/api/admin/orders?orderId=')) return json({ data: { ...order, items: [] } });
      if (url.endsWith('/api/admin/orders')) return json({ data: [order], truncated: false });
      return body.check
        ? json({ link: 'https://app.example.test/api/receipts/image?ref=BW-O1234', canEmail: true, reason: null, emailHint: 'o•••@example.test' })
        : json({ sent: true, sentTo: 'o•••@example.test', auditRecorded: true });
    };
    render(<Orders />);
    fireEvent.click((await screen.findByText('Ola Orderer')).closest('tr')!);
    expect(await screen.findByText('Sends to o•••@example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(h.copied).toEqual(['https://app.example.test/api/receipts/image?ref=BW-O1234']));
    expect(resendCalls()).toEqual([{ kind: 'order', id: ORDER, check: true }]);
  });
});
