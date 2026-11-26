// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Bookings page: the booking detail panel and the CSV export show the
// customer's pre-booking answers, labelled with the business's current
// questions; an answer to a since-deleted question keeps a neutral label.
const state = vi.hoisted(() => ({
  business: {
    id: 'biz', category: 'restaurant', country_code: 'NG', capabilities: ['scheduling'], flow_type: 'appointment',
    metadata: { pre_booking_questions: [{ id: 'q_diet', question: 'Any dietary needs or allergies?', required: false }] },
  },
  rows: {} as Record<string, any[]>,
  csv: [] as any[],
  selects: [] as string[],
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => state.business }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { hiddenStatuses: [], entityNamePlural: 'bookings', quantityLabel: 'Guests' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: ({ data }: { data: any[] }) => { state.csv = data; return null; } }));
vi.mock('@/components/dashboard/BookingIntakePanel', () => ({ BookingIntakePanel: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const result = () => ({ data: (state.rows[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value)), error: null });
    const query: any = {
      select: (cols: string) => { state.selects.push(`${table}:${cols}`); return query; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      neq: () => query, order: () => query, limit: () => query, gte: () => query, lte: () => query, in: () => query,
      maybeSingle: async () => result(), then: (resolve: any) => Promise.resolve(result()).then(resolve),
    };
    return query;
  },
  channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; }, removeChannel: vi.fn(),
}) }));
import BookingsPage from '../page';

const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().split('T')[0];
const booking = (id: string, metadata: unknown) => ({
  id, business_id: 'biz', reference_code: `REF-${id}`, guest_name: `Guest ${id}`, date: daysAhead(30), time: '19:00',
  status: 'confirmed', flow_type: 'appointment', party_size: 2, total_amount: 0, guest_phone: '2348000000000',
  created_at: '2026-11-01T00:00:00Z', deposit_status: 'pending', staff_id: null, special_requests: 'Quiet corner', metadata,
});

beforeEach(() => {
  state.rows = { bookings: [
    booking('one', { duration_minutes: 90, custom_answers: { q_diet: 'Nut allergy <script>x</script>', q_gone: 'Window seat' } }),
    booking('two', null),
  ] };
  state.csv = []; state.selects = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Bookings page — pre-booking answers', () => {
  it('loads booking metadata so the answers are available', async () => {
    render(<BookingsPage />);
    await screen.findByText('Guest one');
    expect(state.selects.some(s => s.startsWith('bookings:') && /\bmetadata\b/.test(s))).toBe(true);
  });

  it('detail panel lists labelled answers next to Special Requests, with a fallback label for a deleted question', async () => {
    render(<BookingsPage />);
    fireEvent.click(await screen.findByText('Guest one'));
    const panel = await screen.findByTestId('pre-booking-answers');
    const items = within(panel).getAllByRole('listitem').map(li => li.textContent);
    expect(items).toEqual([
      'Any dietary needs or allergies?: Nut allergy <script>x</script>',
      'Earlier question: Window seat',
    ]);
    // Rendered as text, never as markup
    expect(panel.querySelector('script')).toBeNull();
    expect(screen.getByText('Quiet corner')).toBeTruthy();
  });

  it('shows no answers block for a booking without answers', async () => {
    render(<BookingsPage />);
    fireEvent.click(await screen.findByText('Guest two'));
    await screen.findByText('Quiet corner');
    expect(screen.queryByTestId('pre-booking-answers')).toBeNull();
  });

  it('CSV export includes the answers beside Special Requests', async () => {
    render(<BookingsPage />);
    await screen.findByText('Guest one');
    const one = state.csv.find(r => r.Reference === 'REF-one');
    const two = state.csv.find(r => r.Reference === 'REF-two');
    expect(one['Special Requests']).toBe('Quiet corner');
    expect(one['Pre-booking Answers']).toBe('Any dietary needs or allergies?: Nut allergy <script>x</script>; Earlier question: Window seat');
    expect(two['Pre-booking Answers']).toBe('');
  });
});
