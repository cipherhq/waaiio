// @vitest-environment jsdom
/**
 * Merchant Tickets "Mark as Used" and "Cancel Ticket" (Owner decision
 * 2026-11-18). Mark as Used checks the ticket in through
 * POST /api/tickets/verify/[code] (business owner or active team member,
 * double check-in guarded). Cancel Ticket goes through
 * POST /api/tickets/[id]/cancel (status only). Neither writes event_tickets
 * from the browser.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  directWrites: [] as string[],
  checkin: { status: 200, body: { success: true } as Record<string, unknown> },
  calls: [] as Array<{ url: string; method: string; body: Record<string, unknown> }>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'biz-1', name: 'Sunny Events', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/CustomerLinkActions', () => ({ CustomerLinkActions: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => Promise.resolve({ data: state.tickets.map(t => ({ ...t })), error: null }),
        update: () => { state.directWrites.push('update'); return q; },
      };
      return q;
    },
  }),
}));

import TicketsPage from '@/app/dashboard/tickets/page';

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', ticket_code: 'TK-ABC123', ticket_number: 1, guest_name: 'Ada', guest_phone: null, booking_id: null,
  status: 'valid', scanned_at: null, created_at: '2026-11-01T00:00:00Z', event_id: 'e1', business_id: 'biz-1',
  event: { name: 'Launch', date: '2026-12-01', venue: null }, ...overrides,
});

beforeEach(() => {
  state.tickets = [ticket()];
  state.directWrites = [];
  state.calls = [];
  state.checkin = { status: 200, body: { success: true } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    state.calls.push({ url, method: init?.method || 'GET', body: JSON.parse(String(init?.body || '{}')) });
    const isCancel = url.endsWith('/cancel');
    if (state.checkin.status === 200) {
      state.tickets = [ticket(isCancel ? { status: 'cancelled' } : { status: 'used', scanned_at: '2026-12-01T18:00:00Z' })];
    }
    return new Response(JSON.stringify(state.checkin.body), { status: state.checkin.status });
  }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
});

async function openTicket() {
  render(<TicketsPage />);
  fireEvent.click(within(await screen.findByRole('table')).getByText('TK-ABC123'));
  return screen.getByRole('button', { name: 'Mark as Used' });
}

describe('merchant Tickets: Mark as Used', () => {
  it('checks in through the staff-checked server route, not a browser write', async () => {
    fireEvent.click(await openTicket());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark as Used' })).toBeNull());
    expect(state.calls).toEqual([{
      url: '/api/tickets/verify/TK-ABC123', method: 'POST',
      body: { business_id: 'biz-1', scanned_by: 'Sunny Events' },
    }]);
    expect(state.directWrites).toEqual([]);
    expect(within(screen.getByRole('table')).getByText('used')).toBeTruthy();
  });

  it('a refusal (not staff of this business) is shown and the ticket stays valid', async () => {
    state.checkin = { status: 403, body: { success: false, error: 'Please sign in as staff of this business to check in tickets.' } };
    fireEvent.click(await openTicket());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Please sign in as staff of this business to check in tickets.');
    expect(screen.getByRole('button', { name: 'Mark as Used' })).toBeTruthy();
    expect(state.directWrites).toEqual([]);
  });

  it('an already checked-in ticket (409) shows why and is no longer offered for check-in', async () => {
    state.checkin = { status: 409, body: { success: false, error: 'This ticket was already checked in', scanned_at: '2026-12-01T18:00:00Z' } };
    fireEvent.click(await openTicket());
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This ticket was already checked in');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark as Used' })).toBeNull());
    expect(state.directWrites).toEqual([]);
  });
});

describe('merchant Tickets: Cancel Ticket', () => {
  it('cancels through the staff-checked server route, not a browser write', async () => {
    await openTicket();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Ticket' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel Ticket' })).toBeNull());
    expect(state.calls).toEqual([{ url: '/api/tickets/t1/cancel', method: 'POST', body: {} }]);
    expect(state.directWrites).toEqual([]);
    expect(within(screen.getByRole('table')).getByText('cancelled')).toBeTruthy();
  });

  it('a refused cancel shows the reason and keeps the ticket valid', async () => {
    state.checkin = { status: 409, body: { error: 'Ticket is used, so it was not cancelled.', status: 'used' } };
    await openTicket();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Ticket' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Ticket not cancelled: Ticket is used, so it was not cancelled.');
    expect(state.directWrites).toEqual([]);
  });
});
