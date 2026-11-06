// @vitest-environment jsdom

/**
 * #591 Part B — Broadcasts page shows only people who opted in.
 *
 * Renders the real page. The audience must come from GET /api/broadcasts/recipients
 * (the server's send rule), never from customer_profiles.notification_opt_in.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  business: { id: 'biz-test-001', name: 'Test Business', subscription_tier: 'growth', country_code: 'NG', capabilities: ['broadcast'] } as Record<string, unknown>,
  tablesRead: [] as string[],
  searchParams: new URLSearchParams(),
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => state.business,
  useRequireCapability: () => true,
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('next/navigation', () => ({ useSearchParams: () => state.searchParams }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      state.tablesRead.push(table);
      const q: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'order', 'limit', 'in', 'gte', 'lte', 'contains']) q[k] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    },
  }),
}));

import BroadcastsPage from '../page';

const ADA = { phone: '+2348031111111', name: 'Ada Obi', tags: ['vip'], total_spent: 5000, last_seen_at: new Date().toISOString() };
const BOLA = { phone: '+2348032222222', name: 'Bola', tags: ['new'], total_spent: 100, last_seen_at: new Date().toISOString() };
const CHI = { phone: '+2348033333333', name: null, tags: [], total_spent: null, last_seen_at: null };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let recipientsResponse: () => Response;
let campaignResponse: () => Response;

beforeEach(() => {
  state.tablesRead = [];
  state.searchParams = new URLSearchParams();
  recipientsResponse = () => json(200, { recipients: [ADA, BOLA, CHI], truncated: false });
  campaignResponse = () => json(404, {});
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/broadcasts/usage')) return json(200, { broadcast_count: 0, recipient_count: 0, limits: { maxBroadcasts: 100, maxRecipients: 1000 }, tier: 'growth' });
    if (url.startsWith('/api/broadcasts/recipients')) return recipientsResponse();
    if (url.startsWith('/api/broadcasts/schedule')) return json(200, { broadcasts: [] });
    if (url.startsWith('/api/keyword-campaigns/')) return campaignResponse();
    if (url === '/api/broadcasts/send' && init?.method === 'POST') {
      const phones = JSON.parse(String(init.body)).phones as string[];
      return json(200, { sent: phones.length, total: phones.length, not_sent: 0 });
    }
    return json(404, {});
  });
  global.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Broadcasts page audience (#591 Part B)', () => {
  it('counts exactly the opted-in list from the server and never reads notification_opt_in profiles', async () => {
    render(<BroadcastsPage />);
    await waitFor(() => expect(screen.getByText('Sending to 3 recipients')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/broadcasts/recipients?businessId=biz-test-001');
    expect(state.tablesRead).not.toContain('customer_profiles');
    expect(screen.getByText('Everyone who opted in')).toBeTruthy();
  });

  it('sends to exactly the listed people', async () => {
    render(<BroadcastsPage />);
    await waitFor(() => screen.getByText('Sending to 3 recipients'));
    fireEvent.change(screen.getByPlaceholderText(/Type your broadcast message here/), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send to 3 contacts'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/broadcasts/send')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/broadcasts/send')!;
    expect(JSON.parse(String(init!.body)).phones).toEqual([ADA.phone, BOLA.phone, CHI.phone]);
  });

  it('shows the opt-in explanation instead of a count when nobody has opted in', async () => {
    recipientsResponse = () => json(200, { recipients: [], truncated: false });
    render(<BroadcastsPage />);
    await waitFor(() => expect(screen.getByText('No one has opted in yet')).toBeTruthy());
    expect(screen.getByText("No one has opted in yet. Customers can opt in from your forms or by tapping 'Get updates' in WhatsApp.")).toBeTruthy();
    expect(screen.queryByText(/Sending to \d+ recipient/)).toBeNull();
    expect((screen.getByText('Send to 0 contacts').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers nobody when the opted-in list cannot be loaded', async () => {
    recipientsResponse = () => json(503, { error: 'Could not load who has opted in' });
    render(<BroadcastsPage />);
    await waitFor(() => expect(screen.getByText(/We couldn't check who has opted in/)).toBeTruthy());
    expect(screen.getByText('Sending to 0 recipients')).toBeTruthy();
    expect(state.tablesRead).not.toContain('customer_profiles');
  });

  it('tag filters only offer tags of opted-in people and narrow the opted-in list', async () => {
    render(<BroadcastsPage />);
    await waitFor(() => screen.getByText('Sending to 3 recipients'));
    fireEvent.click(screen.getByText('By Tag'));
    expect(screen.getByText('vip')).toBeTruthy();
    expect(screen.getByText('new')).toBeTruthy();
    fireEvent.click(screen.getByText('vip'));
    fireEvent.click(screen.getByText('Preview Recipients'));
    await waitFor(() => expect(screen.getByText('Sending to 1 recipient')).toBeTruthy());
    expect(screen.getByText('Preview (1 recipients)')).toBeTruthy();
    fireEvent.click(screen.getByText('Show recipients'));
    expect(screen.getByText(ADA.phone)).toBeTruthy();
    expect(screen.queryByText(BOLA.phone)).toBeNull();
  });

  it('pasted numbers join only if they opted in; the rest are reported as skipped', async () => {
    recipientsResponse = () => json(200, { recipients: [ADA, BOLA], truncated: false });
    render(<BroadcastsPage />);
    await waitFor(() => screen.getByText('Sending to 2 recipients'));
    fireEvent.click(screen.getByText('High Spenders'));
    await waitFor(() => screen.getByText('Sending to 1 recipient'));
    fireEvent.click(screen.getByText('Import'));
    fireEvent.change(screen.getByPlaceholderText(/Enter phone numbers/), { target: { value: '2348032222222\n+2348039999999' } });
    fireEvent.click(screen.getByText('Add to Recipients'));
    await waitFor(() => expect(screen.getByText('Sending to 2 recipients')).toBeTruthy());
    expect(screen.getByText('Added 1 contact')).toBeTruthy();
    expect(screen.getByText('Skipped 1 number that has not opted in.')).toBeTruthy();
  });

  it('keyword campaign respondents are limited to people who opted in', async () => {
    state.searchParams = new URLSearchParams('campaign_id=camp-1');
    campaignResponse = () => json(200, { campaign_name: 'Promo', responses: [{ phone: ADA.phone, customer_name: 'Ada' }, { phone: '+2348039999999', customer_name: 'Not opted in' }] });
    render(<BroadcastsPage />);
    await waitFor(() => expect(screen.getByText('Sending to 1 recipient')).toBeTruthy());
    expect(screen.getByText('Promo')).toBeTruthy();
  });
});
