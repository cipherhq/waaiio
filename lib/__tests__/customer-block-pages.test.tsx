// @vitest-environment jsdom
/**
 * #1166 r7 F10 / F13: the website pages show the server's neutral refusal
 * exactly where they show errors today, and do not move on to payment.
 * Rendered and clicked through with the network stubbed: the booking page
 * (email-code step, review step, Book Now), the event page (email-code step,
 * purchase), the donation form, the pay-link page and the recurring page.
 * The server side of each refusal is proved in customer-block-web-routes.test.ts.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEXT = "This service isn't available. If you think this is a mistake, contact support@waaiio.com";
const REFUSAL = { error: TEXT, code: 'customer_unavailable' };

const nav = vi.hoisted(() => ({ params: {} as Record<string, string>, search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/image', () => ({ default: (p: { alt: string }) => <span>{p.alt}</span> }));
vi.mock('@/components/auth/PhoneInput', () => ({
  PhoneInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="Phone number" value={value} onChange={e => onChange(e.target.value)} />
  ),
}));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const q: any = {};
    for (const m of ['select', 'eq', 'order']) q[m] = () => q;
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [{ id: 'svc-1', name: 'Monthly box' }], error: null }).then(r);
    return { from: () => q };
  },
}));
vi.mock('@/lib/supabase/safe-view-query', () => ({
  queryBusinessesPublic: async () => ({ data: { id: 'biz-1', name: 'Box Co', slug: 'box', category: 'retail', country_code: 'US', recurring_enabled: true } }),
}));

import BookingForm from '@/app/b/[slug]/BookingForm';
import EventPurchaseForm from '@/app/e/[slug]/EventPurchaseForm';
import DonationForm from '@/app/donate/[campaignId]/DonationForm';
import ScanToPayPage from '@/app/pay/[token]/page';
import RecurringSetupPage from '@/app/recurring/[slug]/page';

const assigned: string[] = [];
beforeEach(() => {
  assigned.length = 0;
  Object.defineProperty(window, 'location', { configurable: true, value: { set href(v: string) { assigned.push(v); }, get href() { return 'https://app.test/'; } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Route = (url: string, body: any) => { status: number; body: unknown } | undefined;
function stub(route: Route) {
  const calls: Array<{ url: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const r = route(url, body) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
  return calls;
}
const ok = (body: unknown) => ({ status: 200, body });
const refused = { status: 403, body: REFUSAL };

// ── booking page ──
const HOURS = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { open: '08:00', close: '18:00' }]));
const BUSINESS = { id: 'biz-1', name: 'Healing Labs', slug: 'healing', logo_url: null, description: null, address: null, operating_hours: HOURS, country_code: 'NG' };
const SERVICE = { id: 'svc-1', name: 'Assessment', description: null, price: 5000, deposit_amount: 1000, duration_minutes: 30, image_url: null, is_dropoff: false, is_appointment: false, has_form: false };

async function bookingToDetails() {
  render(<BookingForm business={BUSINESS} services={[SERVICE]} />);
  fireEvent.click(screen.getByText('Assessment'));
  const day = screen.getAllByRole('button').find(b => !(b as HTMLButtonElement).disabled && /\d/.test(b.textContent || ''))!;
  fireEvent.click(day);
  await waitFor(() => expect(screen.getByText('10:00')).toBeTruthy());
  fireEvent.click(screen.getByText('10:00'));
  fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Ada Obi' } });
  fireEvent.change(screen.getByPlaceholderText('john@example.com'), { target: { value: 'ada@example.com' } });
}
const slotsAnd = (rest: Route): Route => (url, body) =>
  url.startsWith('/api/bookings/public/slots') ? ok({ slots: [{ time: '10:00', available: 1 }] }) : rest(url, body);

describe('booking page (app/b/[slug])', () => {
  it('shows the refusal at the email-code step and asks for no code', async () => {
    stub(slotsAnd(url => (url === '/api/auth/email-otp' ? refused : undefined)));
    await bookingToDetails();
    fireEvent.click(screen.getByText('Verify'));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(screen.queryByPlaceholderText('6-digit code')).toBeNull();
  });

  async function verified(create: (body: any) => { status: number; body: unknown }) {
    const calls = stub(slotsAnd((url, body) => {
      if (url === '/api/auth/email-otp') return ok({ challengeId: 'c1' });
      if (url.startsWith('/api/auth/email-otp?action=verify')) return ok({ verified: true, otpToken: 'otp' });
      if (url === '/api/bookings/public/create') return create(body);
      return undefined;
    }));
    await bookingToDetails();
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByPlaceholderText('6-digit code')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByText('Verify'));
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeTruthy());
    return calls;
  }

  it('shows the refusal where errors show when the total is checked, and offers no Book Now', async () => {
    await verified(() => refused);
    fireEvent.click(screen.getByText('Continue'));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(screen.queryByText('Book Now')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Pay / })).toBeNull();
    expect(assigned).toEqual([]);
  });

  it('shows the refusal on Book Now and does not go to payment', async () => {
    await verified(body => (body?.preview ? ok({ total: 5000, deposit: 1000, tax_snapshot: null }) : refused));
    fireEvent.click(screen.getByText('Continue'));
    // With a deposit the button reads "Pay <deposit>".
    const pay = await screen.findByRole('button', { name: /^Pay / });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(pay);
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(screen.queryByText('Booking Confirmed!')).toBeNull();
    expect(assigned).toEqual([]);
  });
});

// ── event page ──
const EVENT = { id: 'evt-1', name: 'Concert', description: null, date: '2099-01-01', time: '18:00', end_date: null, end_time: null,
  venue: 'Hall', price: 2000, image_url: null, max_per_order: 5, slug: 'concert', available: 50 };
const EVENT_BIZ = { id: 'biz-1', name: 'Hall Co', slug: 'hall', logo_url: null, country_code: 'NG', payment_gateway: null };

describe('event page (app/e/[slug])', () => {
  function renderEvent() {
    render(<EventPurchaseForm event={EVENT as any} business={EVENT_BIZ as any} ticketTypes={[]} {...({} as any)} />);
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Ada Obi' } });
    fireEvent.change(screen.getByPlaceholderText('john@example.com'), { target: { value: 'ada@example.com' } });
  }

  it('shows the refusal at the email-code step', async () => {
    stub(url => (url === '/api/auth/email-otp' ? refused : undefined));
    renderEvent();
    fireEvent.click(screen.getAllByText('Verify')[0]);
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(screen.queryByPlaceholderText('6-digit code')).toBeNull();
  });

  it('shows the refusal on purchase and does not go to payment', async () => {
    stub(url => {
      if (url === '/api/auth/email-otp') return ok({ challengeId: 'c1' });
      if (url.startsWith('/api/auth/email-otp?action=verify')) return ok({ verified: true, otpToken: 'otp' });
      if (url === '/api/events/purchase') return refused;
      return undefined;
    });
    renderEvent();
    fireEvent.click(screen.getAllByText('Verify')[0]);
    await waitFor(() => expect(screen.getByPlaceholderText('6-digit code')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('6-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getAllByText('Verify')[0]);
    await waitFor(() => expect(screen.queryByPlaceholderText('6-digit code')).toBeNull());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Buy Tickets/ }));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(assigned).toEqual([]);
  });
});

// ── donation form ──
describe('donation form (app/donate/[campaignId])', () => {
  it('shows the refusal and does not go to payment', async () => {
    stub(() => refused);
    render(<DonationForm campaignId="campaign" currency="USD" minimum={5} maximum={50} />);
    fireEvent.change(screen.getByLabelText('Donation amount (USD)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+12025550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect((await screen.findByRole('alert')).textContent).toContain(TEXT);
    expect(assigned).toEqual([]);
  });
});

// ── pay-link page ──
describe('pay-link page (app/pay/[token])', () => {
  it('shows the refusal where errors show and does not go to payment', async () => {
    nav.params = { token: 'tok' };
    stub(url => {
      if (url === '/api/pay-link/tok') return ok({ id: 'pl-1', title: 'Haircut', amount: 500, currency: 'USD', description: null, business_name: 'Barber', logo_url: null, country_code: 'US', requires_phone: false });
      if (url === '/api/pay-link/pay') return refused;
      return undefined;
    });
    render(<ScanToPayPage />);
    fireEvent.change(await screen.findByPlaceholderText('Full name'), { target: { value: 'Ada Obi' } });
    fireEvent.click(screen.getByRole('button', { name: /^Pay/ }));
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(assigned).toEqual([]);
  });
});

// ── recurring page ──
describe('recurring page (app/recurring/[slug])', () => {
  it('shows the refusal where errors show and does not go to checkout', async () => {
    nav.params = { slug: 'box' };
    nav.search = new URLSearchParams('service=svc-1&amount=50');
    stub(url => (url === '/api/recurring/setup' ? refused : undefined));
    render(<RecurringSetupPage />);
    fireEvent.change(await screen.findByPlaceholderText('John Doe'), { target: { value: 'Ada Obi' } });
    fireEvent.change(screen.getByPlaceholderText('john@example.com'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+12025550123' } });
    fireEvent.submit(screen.getByPlaceholderText('John Doe').closest('form')!);
    expect(await screen.findByText(TEXT)).toBeTruthy();
    expect(assigned).toEqual([]);
  });
});
