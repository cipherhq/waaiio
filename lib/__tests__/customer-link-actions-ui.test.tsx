// @vitest-environment jsdom
/**
 * Merchant "Email link" / "Copy link" buttons (Owner decision 2026-11-18),
 * rendered with fetch and the clipboard mocked. Also renders the merchant
 * Tickets page to prove the buttons appear on a selected ticket and that
 * the click-to-sort headers (#1118) still work there.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  check: { status: 200, body: {} as Record<string, unknown> },
  send: { status: 200, body: {} as Record<string, unknown> },
  calls: [] as Array<{ url: string; body: Record<string, unknown> }>,
  copied: [] as string[],
  tickets: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'biz-1', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, order: () => Promise.resolve({ data: state.tickets, error: null }) };
      return q;
    },
  }),
}));

import { CustomerLinkActions } from '@/components/dashboard/CustomerLinkActions';
import TicketsPage from '@/app/dashboard/tickets/page';

const ID = '33333333-3333-4333-8333-000000000001';

beforeEach(() => {
  state.calls = [];
  state.copied = [];
  state.check = { status: 200, body: { link: 'https://app.example.test/tickets/TK-ABC123', canEmail: true, reason: null, emailHint: 'a•••@example.test' } };
  state.send = { status: 200, body: { sent: true, sentTo: 'a•••@example.test' } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    state.calls.push({ url, body });
    const r = body.check ? state.check : state.send;
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

describe('CustomerLinkActions (merchant)', () => {
  it('checks the link on open, shows who it sends to, and sends nothing yet', async () => {
    render(<CustomerLinkActions kind="ticket" id={ID} />);
    expect(await screen.findByText('Sends to a•••@example.test')).toBeTruthy();
    expect(state.calls).toEqual([{ url: '/api/customer-links/resend', body: { kind: 'ticket', id: ID, check: true } }]);
    expect((screen.getByRole('button', { name: 'Email link' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Email link sends once and shows the masked address', async () => {
    render(<CustomerLinkActions kind="ticket" id={ID} />);
    await screen.findByText('Sends to a•••@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Link emailed to a•••@example.test.');
    expect(state.calls[1]).toEqual({ url: '/api/customer-links/resend', body: { kind: 'ticket', id: ID } });
  });

  it('no customer email: Email link is disabled with the reason; Copy link still works', async () => {
    state.check = { status: 200, body: { link: 'https://app.example.test/tickets/TK-ABC123', canEmail: false, reason: 'No customer email on file.', emailHint: null } };
    render(<CustomerLinkActions kind="ticket" id={ID} />);
    expect(await screen.findByText('Email is off: No customer email on file.')).toBeTruthy();
    const emailBtn = screen.getByRole('button', { name: 'Email link' }) as HTMLButtonElement;
    expect(emailBtn.disabled).toBe(true);
    expect(emailBtn.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(state.copied).toEqual(['https://app.example.test/tickets/TK-ABC123']));
    expect(state.calls).toHaveLength(1);
  });

  it('a refused send shows the server reason', async () => {
    state.send = { status: 429, body: { error: 'This link was emailed several times in the last hour. Try again later.' } };
    render(<CustomerLinkActions kind="order" id={ID} />);
    await screen.findByText('Sends to a•••@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This link was emailed several times in the last hour. Try again later.');
  });

  it('a failed check keeps both buttons off', async () => {
    state.check = { status: 404, body: { error: 'Not found' } };
    render(<CustomerLinkActions kind="booking" id={ID} />);
    expect(await screen.findByText('Could not load the customer link.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Email link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });
});

describe('merchant Tickets page', () => {
  it('shows Email link and Copy link for the selected ticket, and sort headers still sort', async () => {
    state.tickets = [
      { id: ID, ticket_code: 'TK-BBB222', ticket_number: 2, guest_name: 'Bola', guest_phone: null, booking_id: null, status: 'valid', scanned_at: null, created_at: '2026-11-02T00:00:00Z', event_id: 'e1', business_id: 'biz-1', event: { name: 'Launch', date: '2026-12-01', venue: null } },
      { id: 'other', ticket_code: 'TK-AAA111', ticket_number: 1, guest_name: 'Ada', guest_phone: null, booking_id: null, status: 'valid', scanned_at: null, created_at: '2026-11-01T00:00:00Z', event_id: 'e1', business_id: 'biz-1', event: { name: 'Launch', date: '2026-12-01', venue: null } },
    ];
    render(<TicketsPage />);
    const table = await screen.findByRole('table');
    const codes = () => within(table).getAllByRole('row').slice(1).map(r => r.querySelector('td')?.textContent);
    expect(codes()).toEqual(['TK-BBB222', 'TK-AAA111']);
    fireEvent.click(within(table).getByRole('button', { name: /Code/ }));
    expect(codes()).toEqual(['TK-AAA111', 'TK-BBB222']);

    fireEvent.click(within(table).getByText('TK-BBB222'));
    expect(await screen.findByRole('button', { name: 'Email link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(state.calls[0].body).toEqual({ kind: 'ticket', id: ID, check: true });
  });
});
