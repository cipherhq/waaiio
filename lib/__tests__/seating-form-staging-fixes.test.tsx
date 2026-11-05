// @vitest-environment jsdom
/**
 * Owner findings on staging, 2026-11-04, Seating (tables) form:
 *  1. Number fields could not be cleared: each change fell back to 1, 1, 90 or 0
 *     at once, so clearing snapped back and typing produced "015" / "315".
 *  2. A table window that ends at or before it starts (22:00 → 02:30) showed the
 *     raw seating_no_overnight database error. The rule stays (M476/M510); the
 *     merchant is pointed to the business opening hours instead.
 * Renders the real Seating page; only the Supabase client is replaced.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  writes: [] as Array<{ op: 'insert' | 'update'; payload: Record<string, unknown> }>,
  writeError: null as null | { message: string; code?: string },
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'business-1', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'seating_resources') throw new Error(`Unexpected table ${table}`);
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve, reject),
        insert: async (payload: Record<string, unknown>) => {
          state.writes.push({ op: 'insert', payload });
          return { error: state.writeError };
        },
      };
      return query;
    },
  }),
}));

import SeatingPage from '@/app/dashboard/seating/page';

const OVERNIGHT_TEXT = /A table's own hours can't run past midnight\. To take late-night bookings, leave Available From and Available Until empty so this table follows your business opening hours \(Settings → Business → Operating Hours\)\. Tables can't be booked outside your opening hours\./;
// The message has bold field names, so match the whole text of the error box.
const findOvernightMessage = () => screen.findByText((_, el) =>
  !!el && el.classList.contains('bg-red-50') && OVERNIGHT_TEXT.test(el.textContent || ''));

async function openAddForm() {
  const view = render(<SeatingPage />);
  fireEvent.click(await screen.findByRole('button', { name: '+ Add Seating' }));
  await screen.findByRole('heading', { name: 'Add Seating' });
  fireEvent.change(screen.getByPlaceholderText(/Table 1/), { target: { value: 'Table 9' } });
  const numbers = view.container.querySelectorAll<HTMLInputElement>('input[type="number"]');
  const times = view.container.querySelectorAll<HTMLInputElement>('input[type="time"]');
  return {
    capacity: numbers[0], minParty: numbers[1], duration: numbers[2], deposit: numbers[3],
    from: times[0], until: times[1],
    save: () => fireEvent.click(screen.getByRole('button', { name: 'Add Seating' })),
  };
}

beforeEach(() => {
  state.writes = [];
  state.writeError = null;
});
afterEach(cleanup);

describe('Seating form number fields', () => {
  it('a merchant can clear a field and retype it without it snapping back', async () => {
    const form = await openAddForm();
    fireEvent.change(form.capacity, { target: { value: '' } });
    expect(form.capacity.value).toBe('');
    fireEvent.change(form.capacity, { target: { value: '6' } });
    expect(form.capacity.value).toBe('6');

    fireEvent.change(form.minParty, { target: { value: '' } });
    expect(form.minParty.value).toBe('');
    fireEvent.change(form.minParty, { target: { value: '2' } });
    fireEvent.change(form.duration, { target: { value: '' } });
    expect(form.duration.value).toBe('');
    fireEvent.change(form.duration, { target: { value: '120' } });
    fireEvent.change(form.deposit, { target: { value: '' } });
    expect(form.deposit.value).toBe('');
    fireEvent.change(form.deposit, { target: { value: '5000' } });

    form.save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ capacity: 6, min_party_size: 2, reservation_duration_minutes: 120, deposit_amount: 5000 });
  });

  it('fields left empty save the same values they used to fall back to', async () => {
    const form = await openAddForm();
    for (const input of [form.capacity, form.minParty, form.duration, form.deposit]) fireEvent.change(input, { target: { value: '' } });
    form.save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ capacity: 1, min_party_size: 1, reservation_duration_minutes: 90, deposit_amount: 0 });
  });

  it.each([
    ['capacity', '0', 'Max capacity must be a whole number from 1 to 500'],
    ['capacity', '501', 'Max capacity must be a whole number from 1 to 500'],
    ['minParty', '0', 'Min party size must be a whole number of at least 1'],
    ['minParty', '9', 'Minimum party size cannot exceed capacity'],
    ['duration', '481', 'Duration must be a whole number of minutes from 1 to 480'],
    ['deposit', '-1', 'Deposit must be a whole number of 0 or more'],
  ] as const)('rejects %s = %s with a clear message and saves nothing', async (field, value, message) => {
    const form = await openAddForm();
    fireEvent.change(form[field], { target: { value } });
    form.save();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(state.writes).toHaveLength(0);
  });
});

describe('Seating form hours past midnight', () => {
  it('keeps the "Uses business hours" hint when Available From is empty', async () => {
    await openAddForm();
    expect(screen.getByText('Uses business hours')).toBeTruthy();
  });

  it.each([['22:00', '02:30'], ['18:00', '18:00']])('%s → %s is stopped before saving with the opening-hours guidance', async (from, until) => {
    const form = await openAddForm();
    fireEvent.change(form.from, { target: { value: from } });
    fireEvent.change(form.until, { target: { value: until } });
    form.save();
    expect(await findOvernightMessage()).toBeTruthy();
    expect(state.writes).toHaveLength(0);
  });

  it('a seating_no_overnight database error shows the same guidance, not the raw error', async () => {
    state.writeError = { code: '23514', message: 'new row for relation "seating_resources" violates check constraint "seating_no_overnight"' };
    const form = await openAddForm();
    fireEvent.change(form.from, { target: { value: '10:00' } });
    fireEvent.change(form.until, { target: { value: '14:00' } });
    form.save();
    expect(await findOvernightMessage()).toBeTruthy();
    expect(screen.queryByText(/violates check constraint/)).toBeNull();
    expect(state.writes).toHaveLength(1);
  });

  it('other database errors are still shown as they are', async () => {
    state.writeError = { message: 'Synthetic failure' };
    const form = await openAddForm();
    form.save();
    expect(await screen.findByText('Synthetic failure')).toBeTruthy();
  });
});
