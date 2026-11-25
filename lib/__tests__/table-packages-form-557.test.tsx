// @vitest-environment jsdom
/**
 * M557 (Owner decision 2026-11-23): minimum spend, bottle packages and
 * "what the customer pays now" on the Seating form. Renders the real Seating
 * page; only the Supabase client is replaced.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ op: 'insert' | 'update'; payload: Record<string, unknown>; id?: string }>,
  writeError: null as null | { message: string; code?: string },
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'business-1', country_code: 'NG' }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/seating/InternalHolds', () => ({ default: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== 'seating_resources') throw new Error(`Unexpected table ${table}`);
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve({ data: state.rows, error: null }).then(resolve, reject),
        insert: async (payload: Record<string, unknown>) => {
          state.writes.push({ op: 'insert', payload });
          return { error: state.writeError };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            state.writes.push({ op: 'update', payload, id });
            return { error: state.writeError };
          },
        }),
      };
      return query;
    },
  }),
}));

import SeatingPage from '@/app/dashboard/seating/page';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function openAddForm() {
  render(<SeatingPage />);
  fireEvent.click(await screen.findByRole('button', { name: '+ Add Seating' }));
  await screen.findByRole('heading', { name: 'Add Seating' });
  fireEvent.change(screen.getByPlaceholderText(/Table 1/), { target: { value: 'VIP Booth' } });
}
function addPackage(n: number, name: string, price: string, includes = '') {
  fireEvent.click(screen.getByRole('button', { name: '+ Add package' }));
  fireEvent.change(screen.getByLabelText(`Package ${n} name`), { target: { value: name } });
  fireEvent.change(screen.getByLabelText(`Package ${n} price`), { target: { value: price } });
  if (includes) fireEvent.change(screen.getByLabelText(`Package ${n} includes`), { target: { value: includes } });
}
const fullRadio = () => screen.getByLabelText(/Pay in full now/) as HTMLInputElement;
const depositRadio = () => screen.getByLabelText(/Deposit only/) as HTMLInputElement;
const save = (name = 'Add Seating') => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => { state.rows = []; state.writes = []; state.writeError = null; });
afterEach(cleanup);

describe('Seating form: tables without a minimum spend or packages', () => {
  it('saves no minimum spend, deposit only and no packages, and pay in full is unavailable', async () => {
    await openAddForm();
    expect(depositRadio().checked).toBe(true);
    expect(fullRadio().disabled).toBe(true);
    expect(screen.getByText('Add a minimum spend or a package to ask for payment in full.')).toBeTruthy();
    save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ minimum_spend: null, payment_mode: 'deposit', packages: [] });
  });
});

describe('Seating form: minimum spend and packages', () => {
  it('saves the minimum spend, trimmed packages with ids and pay in full now', async () => {
    await openAddForm();
    fireEvent.change(screen.getByLabelText('Minimum spend (NG)'), { target: { value: '500000' } });
    expect(screen.getByText(/minimum spend" on WhatsApp\./)).toBeTruthy();
    addPackage(1, '  Gold ', '650000', ' 2 Hennessy VS + 1 Moët ');
    addPackage(2, 'Silver', '400000');
    expect(fullRadio().disabled).toBe(false);
    expect(screen.getByRole('group', { name: 'What the customer pays now' })).toBeTruthy();
    expect(fullRadio().getAttribute('aria-describedby')).toBe('payment_mode_hint');
    fireEvent.click(fullRadio());
    save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
    const payload = state.writes[0].payload;
    expect(payload).toMatchObject({ minimum_spend: 500000, payment_mode: 'full' });
    const packages = payload.packages as Array<Record<string, unknown>>;
    expect(packages.map(({ id: _id, ...rest }) => rest)).toEqual([
      { name: 'Gold', includes: '2 Hennessy VS + 1 Moët', price: 650000 },
      { name: 'Silver', includes: '', price: 400000 },
    ]);
    for (const p of packages) expect(p.id).toMatch(UUID);
    expect(new Set(packages.map(p => p.id)).size).toBe(2);
  });

  it('warns, without blocking, when a package costs less than the minimum spend', async () => {
    await openAddForm();
    fireEvent.change(screen.getByLabelText('Minimum spend (NG)'), { target: { value: '500000' } });
    addPackage(1, 'Silver', '400000');
    expect(screen.getByText('This package costs less than the minimum spend.')).toBeTruthy();
    save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
  });

  it('stops at 9 packages', async () => {
    await openAddForm();
    for (let i = 1; i <= 9; i += 1) addPackage(i, `P${i}`, '1000');
    expect(screen.queryByRole('button', { name: '+ Add package' })).toBeNull();
    expect(screen.getAllByTestId('package-row')).toHaveLength(9);
  });

  it.each([
    ['no name', '', '1000', 'Each package needs a name of up to 60 characters.'],
    ['no price', 'Gold', '', 'Package "Gold" needs a whole-number price of at least 1.'],
    ['a decimal price', 'Gold', '650000.5', 'Package "Gold" needs a whole-number price of at least 1.'],
  ])('refuses a package with %s and saves nothing', async (_label, name, price, message) => {
    await openAddForm();
    addPackage(1, name, price);
    save();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(state.writes).toHaveLength(0);
  });

  it.each(['0', '500.5'])('refuses a minimum spend of %s', async (value) => {
    await openAddForm();
    fireEvent.change(screen.getByLabelText('Minimum spend (NG)'), { target: { value } });
    save();
    expect(await screen.findByText('Minimum spend must be a whole number of at least 1, or left empty.')).toBeTruthy();
    expect(state.writes).toHaveLength(0);
  });

  it('removing the last package and the minimum spend saves deposit only', async () => {
    await openAddForm();
    addPackage(1, 'Gold', '650000');
    fireEvent.click(fullRadio());
    fireEvent.click(screen.getByRole('button', { name: 'Remove package 1' }));
    expect(depositRadio().checked).toBe(true);
    // Adding a package again does not switch back to pay in full by itself.
    addPackage(1, 'Silver', '400000');
    expect(depositRadio().checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove package 1' }));
    save();
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ minimum_spend: null, payment_mode: 'deposit', packages: [] });
  });

  it('a database package error shows plain guidance, not the raw error', async () => {
    state.writeError = { code: '23514', message: 'seating_packages_too_many:A table can have at most 9 packages' };
    await openAddForm();
    addPackage(1, 'Gold', '650000');
    save();
    expect(await screen.findByText('A table can have at most 9 packages.')).toBeTruthy();
  });
});

describe('Seating form: editing a table with packages', () => {
  const gold = { id: '11111111-1111-4111-8111-111111111111', name: 'Gold', includes: '2 Hennessy VS + 1 Moët', price: 650000 };
  beforeEach(() => {
    state.rows = [{
      id: 'table-1', name: 'VIP Booth', resource_type: 'vip_area', capacity: 8, min_party_size: 2, section: null,
      reservation_duration_minutes: 180, deposit_amount: 50000, is_active: true, sort_order: 0, description: null,
      available_days: null, available_from: null, available_to: null, gallery_urls: [],
      minimum_spend: 500000, payment_mode: 'full', packages: [gold],
    }];
  });

  it('shows the minimum spend and packages on the card', async () => {
    render(<SeatingPage />);
    expect(await screen.findByText('Minimum spend: ₦500,000')).toBeTruthy();
    expect(screen.getByText('1 package · paid in full when booking')).toBeTruthy();
  });

  it('loads them into the form and saves them back unchanged, keeping the package id', async () => {
    render(<SeatingPage />);
    fireEvent.click(await screen.findByTitle('Edit'));
    await screen.findByRole('heading', { name: 'Edit Seating' });
    expect((screen.getByLabelText('Minimum spend (NG)') as HTMLInputElement).value).toBe('500000');
    expect((screen.getByLabelText('Package 1 name') as HTMLInputElement).value).toBe('Gold');
    expect(fullRadio().checked).toBe(true);
    save('Save Changes');
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ op: 'update', id: 'table-1', payload: { minimum_spend: 500000, payment_mode: 'full', packages: [gold] } });
  });
});
