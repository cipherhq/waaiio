// @vitest-environment jsdom

/**
 * #1131 — merchant SMS campaigns on the rendered Broadcasts page: the Send-by
 * choice (Nigeria/Ghana only), the cost estimate before sending, the confirm
 * step, the send body (request id), and "send again" reusing the same request
 * id so nobody is texted or charged twice.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  business: { id: 'biz-test-001', name: 'Test Business', subscription_tier: 'growth', country_code: 'NG', capabilities: ['broadcast'] } as Record<string, unknown>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useRequireCapability: () => true,
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'lte', 'contains']) q[k] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    },
  }),
}));

import BroadcastsPage from '../page';

const PEOPLE = [
  { phone: '+2348031111111', name: 'Ada', tags: [], total_spent: 0, last_seen_at: new Date().toISOString() },
  { phone: '+2348032222222', name: 'Bola', tags: [], total_spent: 0, last_seen_at: new Date().toISOString() },
];
const ESTIMATE = {
  available: true, problem: null, pages: 1, unicode: false, characters: 10, perPage: 160, tooLong: false,
  currency: 'NGN', pricePerPageMinor: 838, recipients: 2, notSmsNumbers: 0, totalMinor: 1676, quietHoursNow: false,
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let estimate: Record<string, unknown>;
let sendReply: Record<string, unknown>;
const sends = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === '/api/broadcasts/send' && i?.method === 'POST').map(([, i]) => JSON.parse(String(i!.body)));

beforeEach(() => {
  state.business = { ...state.business, country_code: 'NG' };
  estimate = ESTIMATE;
  sendReply = { channel: 'sms', sent: 2, total: 2, chargedMinor: 1676, currency: 'NGN', failed: 0, unknown: 0, alreadySent: 0, unconfirmed: 0, skipped: {} };
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/broadcasts/usage')) return json(200, { broadcast_count: 0, recipient_count: 0, limits: { maxBroadcasts: 100, maxRecipients: 1000 }, tier: 'growth' });
    if (url.startsWith('/api/broadcasts/recipients')) return json(200, { recipients: PEOPLE, truncated: false });
    if (url.startsWith('/api/broadcasts/schedule')) return json(200, { broadcasts: [] });
    if (url === '/api/broadcasts/sms-estimate') return json(200, { estimate });
    if (url === '/api/broadcasts/send' && init?.method === 'POST') return json(200, sendReply);
    return json(404, {});
  });
  global.fetch = fetchMock;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function composeSms(text = 'Sale today') {
  render(<BroadcastsPage />);
  await waitFor(() => screen.getByText('Sending to 2 recipients'));
  fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
  fireEvent.change(screen.getByPlaceholderText(/Type your broadcast message here/), { target: { value: text } });
  await screen.findByText(/taken from your messaging credit/);
}

describe('Broadcasts page: SMS campaigns (#1131)', () => {
  it('offers SMS only to Nigeria and Ghana businesses', async () => {
    state.business = { ...state.business, country_code: 'US' };
    render(<BroadcastsPage />);
    await waitFor(() => screen.getByText('Sending to 2 recipients'));
    expect(screen.queryByRole('button', { name: 'SMS' })).toBeNull();
  });

  it('shows pages, price and total before sending, then sends once with a request id after confirmation', async () => {
    await composeSms();
    expect(screen.getByRole('button', { name: 'SMS' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('status').textContent).toMatch(/1 SMS page per person/);
    expect(screen.getByRole('status').textContent).toMatch(/8\.38 per page × 1 × 2 people = up to .*16\.76/);
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS to 2 contacts' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/Up to .*16\.76 will be taken from your messaging credit/));
    expect(sends()[0]).toMatchObject({ business_id: 'biz-test-001', channel: 'sms', message: 'Sale today', phones: PEOPLE.map(p => p.phone) });
    expect(sends()[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    await screen.findByText(/2 of 2 SMS sent/);
  });

  it('does not send when the merchant cancels the confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await composeSms();
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS to 2 contacts' }));
    expect(sends()).toHaveLength(0);
  });

  it('after credit runs out, Send again reuses the same request id and explains why', async () => {
    sendReply = { channel: 'sms', sent: 1, total: 2, chargedMinor: 838, currency: 'NGN', failed: 0, unknown: 0, alreadySent: 0, unconfirmed: 0, skipped: { insufficient_credit: 1 } };
    await composeSms();
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS to 2 contacts' }));
    await screen.findByText(/Your messaging credit ran out\. Top up, then press Send again/);
    sendReply = { channel: 'sms', sent: 1, total: 2, chargedMinor: 838, currency: 'NGN', failed: 0, unknown: 0, alreadySent: 1, unconfirmed: 0, skipped: {} };
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS to 2 contacts' }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1].request_id).toBe(sends()[0].request_id);
    await screen.findByText(/1 already got this SMS and were not charged again/);
  });

  it('a new message is a new campaign with a new request id', { timeout: 10000 }, async () => {
    await composeSms('First');
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS to 2 contacts' }));
    await screen.findByText(/2 of 2 SMS sent/);
    fireEvent.change(screen.getByPlaceholderText(/Type your broadcast message here/), { target: { value: 'Second' } });
    await screen.findByText(/taken from your messaging credit/);
    // The "Sent!" label shows for 3 seconds after a send.
    fireEvent.click(await screen.findByRole('button', { name: 'Send SMS to 2 contacts' }, { timeout: 4000 }));
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1].request_id).not.toBe(sends()[0].request_id);
  });

  it('cannot send during quiet hours', async () => {
    estimate = { ...ESTIMATE, quietHoursNow: true };
    render(<BroadcastsPage />);
    await waitFor(() => screen.getByText('Sending to 2 recipients'));
    fireEvent.click(screen.getByRole('button', { name: 'SMS' }));
    fireEvent.change(screen.getByPlaceholderText(/Type your broadcast message here/), { target: { value: 'Late sale' } });
    await screen.findByText(/not sent between 8pm and 8am/);
    expect((screen.getByRole('button', { name: 'Send SMS to 2 contacts' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
