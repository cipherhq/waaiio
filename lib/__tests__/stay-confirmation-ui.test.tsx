// @vitest-environment jsdom
/**
 * Property stay confirmation link (follow-up to #1121; Owner decision 2026-11-18), rendered:
 *   - the customer page /stays/[code] shows the stay read-only, with no guest
 *     contact details and no check-in button, and a clear message for a bad link;
 *   - the merchant property detail drawer shows Email link / Copy link for the
 *     stay and checks it as kind 'stay';
 *   - Email link is off with the reason when there is no customer email.
 * fetch, the clipboard and the Supabase browser client are mocked.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  code: '0123456789abcdef0123456789abcdef',
  pageResponse: { status: 200, body: {} as Record<string, unknown> },
  check: { status: 200, body: {} as Record<string, unknown> },
  send: { status: 200, body: {} as Record<string, unknown> },
  calls: [] as Array<{ url: string; body: Record<string, unknown> }>,
  copied: [] as string[],
  stays: [] as Array<Record<string, unknown>>,
  mutation: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ code: state.code, id: 'property-a' }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: () => null }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business-a', country_code: 'NG', category: 'hotel' }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (table: string) => {
  const result = { data: table === 'properties'
    ? { id: 'property-a', name: 'Lagoon Flat', property_type: 'apartment', price: 25000, max_guests: 2, photos: [], amenities: [], is_active: true }
    : table === 'reservations' ? state.stays : [] };
  const q: Record<string, unknown> = { single: async () => result, then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve), insert: state.mutation, update: state.mutation, delete: state.mutation };
  for (const method of ['select', 'eq', 'order', 'in', 'gte', 'lte', 'neq']) q[method] = () => q;
  return q;
} }) }));

import StayConfirmationPage from '@/app/stays/[code]/page';
import PropertyDetailPage from '@/app/dashboard/properties/[id]/page';

const STAY_ID = '55555555-5555-4555-8555-555555555555';
const LINK = `https://app.example.test/stays/${'0123456789abcdef0123456789abcdef'}`;

beforeEach(() => {
  state.calls = [];
  state.copied = [];
  state.mutation.mockReset();
  state.pageResponse = { status: 200, body: { stay: {
    reference_code: 'WA-RS-1234', business_name: 'Sunny Stays', property_name: 'Lagoon Flat',
    property_address: '12 Marina Road', check_in: '2026-12-01', check_out: '2026-12-04',
    nights: 3, guests: 2, nightly_rate: '₦25,000', total: '₦75,000', deposit: '₦10,000',
    status: 'confirmed', subscription_tier: 'free',
  } } };
  state.check = { status: 200, body: { link: LINK, canEmail: true, reason: null, emailHint: 's•••@example.test' } };
  state.send = { status: 200, body: { sent: true, sentTo: 's•••@example.test' } };
  state.stays = [{
    id: STAY_ID, reference_code: 'WA-RS-1234', check_in: '2026-12-01', check_out: '2026-12-04', nights: 3, guests: 2,
    status: 'confirmed', guest_name: 'Sade Stayer', guest_phone: '+2348012345678', guest_email: 'sade@example.test',
    special_requests: null, deposit_amount: 0, deposit_status: 'none', total_amount: 75000, nightly_rate: 25000,
    created_at: '2026-11-01T00:00:00Z', confirmed_at: null, checked_in_at: null, checked_out_at: null, cancelled_at: null,
    payment_id: null, channel: 'whatsapp', notes: null,
  }];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    state.calls.push({ url, body });
    const r = url.startsWith('/api/stays/') ? state.pageResponse : body.check ? state.check : state.send;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async (text: string) => { state.copied.push(text); }) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('customer stay confirmation page /stays/[code]', () => {
  it('loads by the code and shows the stay read-only', async () => {
    render(<StayConfirmationPage />);
    expect(await screen.findByText('WA-RS-1234')).toBeTruthy();
    expect(state.calls).toEqual([{ url: `/api/stays/${state.code}`, body: {} }]);
    for (const text of ['Sunny Stays', 'Lagoon Flat', '12 Marina Road', 'Confirmed', '₦75,000', '₦10,000', '3 × ₦25,000/night', 'Powered by Waaiio']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText(/Tue, December 1, 2026/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Sade|\+234|@example/);
  });

  it('a bad link shows Stay Not Found and the reason', async () => {
    state.pageResponse = { status: 404, body: { error: 'Stay not found. Please check the link.' } };
    render(<StayConfirmationPage />);
    expect(await screen.findByText('Stay Not Found')).toBeTruthy();
    expect(screen.getByText('Stay not found. Please check the link.')).toBeTruthy();
  });

  it('a cancelled stay says so', async () => {
    (state.pageResponse.body.stay as Record<string, unknown>).status = 'cancelled';
    render(<StayConfirmationPage />);
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByText('Confirmed')).toBeNull();
  });
});

describe('merchant property detail: stay confirmation link', () => {
  async function openStay() {
    render(<PropertyDetailPage />);
    fireEvent.click((await screen.findByText('Sade Stayer')).closest('tr')!);
  }

  it('the stay drawer checks kind stay, copies the /stays link and emails it', async () => {
    await openStay();
    expect(await screen.findByText('Sends to s•••@example.test')).toBeTruthy();
    expect(state.calls).toEqual([{ url: '/api/customer-links/resend', body: { kind: 'stay', id: STAY_ID, check: true } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(state.copied).toEqual([LINK]));
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByText('Link emailed to s•••@example.test.')).toBeTruthy();
    expect(state.calls[1]).toEqual({ url: '/api/customer-links/resend', body: { kind: 'stay', id: STAY_ID } });
    expect(state.mutation).not.toHaveBeenCalled();
  });

  it('no customer email: Email link is off with the reason, Copy link still works', async () => {
    state.check = { status: 200, body: { link: LINK, canEmail: false, reason: 'No customer email on file.', emailHint: null } };
    await openStay();
    expect(await screen.findByText('Email is off: No customer email on file.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Email link' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(state.copied).toEqual([LINK]));
    expect(state.calls).toHaveLength(1);
  });
});
