// @vitest-environment jsdom
/**
 * Customer ticket page is read-only (Owner decision 2026-11-18): it shows the
 * ticket but never offers check-in, and never sends a check-in request.
 * Check-in happens on the business's own scanner.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useParams: () => ({ code: 'TK-ABC123' }) }));
vi.mock('next/image', () => ({ default: (props: React.ImgHTMLAttributes<HTMLImageElement>) => <img {...props} /> }));
vi.mock('@/components/ReturnToWhatsApp', () => ({ ReturnToWhatsApp: () => null }));

import TicketPage from '@/app/tickets/[code]/page';

const calls: Array<{ url: string; method: string }> = [];

function mockTicket(status: string, extra: Record<string, unknown> = {}) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method || 'GET' });
    return new Response(JSON.stringify({
      valid: status === 'valid',
      ticket: {
        ticket_code: 'TK-ABC123', event_name: 'Launch Night', event_date: '2026-12-01', event_time: '18:00',
        venue: 'Hall A', guest_name: 'Ada', ticket_number: 1, total_tickets: 2, reference_code: 'BK-1',
        status, scanned_at: null, scanned_by: null, image_url: null, subscription_tier: 'free', ...extra,
      },
    }), { status: 200 });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/tickets/[code] customer page', () => {
  it('a valid ticket shows the ticket and no check-in button', async () => {
    mockTicket('valid', { self_checkin_enabled: true });
    render(<TicketPage />);
    expect(await screen.findByText('Valid ticket')).toBeTruthy();
    expect(screen.getByText('TK-ABC123')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/check in$/i)).toBeNull();
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('a used ticket shows that it was checked in', async () => {
    mockTicket('used', { scanned_at: '2026-12-01T18:05:00Z', scanned_by: 'Gate 1' });
    render(<TicketPage />);
    expect(await screen.findByText('Already Checked In')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
