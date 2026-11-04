// @vitest-environment jsdom
/**
 * #867 part 2: owners can see and correct City and State in Settings. Directory
 * location search reads these columns, and before this change State was never
 * editable and typing an address blanked City.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<{ table: string; payload: Record<string, unknown> }>);
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const key of ['select', 'eq', 'neq', 'order', 'limit']) chain[key] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      chain.update = (payload: Record<string, unknown>) => { writes.push({ table, payload }); return chain; };
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    },
  }),
}));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabel: 'guest', entityNamePlural: 'bookings' } }) }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
// Stand-in for the address autocomplete: typing calls onChange(text) with no place
// data; the button simulates picking a suggestion that carries city and state.
vi.mock('@/components/ui/PlacesAutocomplete', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string, p?: Record<string, unknown>) => void }) => (
    <div>
      <input aria-label="Address" value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onChange('Lekki Phase 1, Lekki 106104, Lagos, Nigeria', {
        address: 'Lekki Phase 1, Lekki 106104, Lagos, Nigeria', lat: 6.4, lng: 3.5, placeId: 'p1', city: 'Lekki', state: 'Lagos',
      })}>pick suggestion</button>
    </div>
  ),
}));

import { BusinessTab } from '@/app/dashboard/settings/tabs/BusinessTab';

function renderTab(business: Record<string, unknown>) {
  const props = {
    business: {
      id: 'business-1', name: 'TestBiz', slug: 'testbiz', bot_code: 'TESTBIZ', status: 'active',
      address: '', city: '', state: null, phone: '', email: '', description: '',
      subscription_tier: 'free', category: 'shop', metadata: {}, ...business,
    },
    capabilities: [], country: 'NG', curr: 'NGN', saving: false, saved: false,
    setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['profile'], toggleSection: vi.fn(),
  } as unknown as React.ComponentProps<typeof BusinessTab>;
  render(<BusinessTab {...props} />);
}

const lastBusinessWrite = () => writes.filter((w) => w.table === 'businesses').at(-1)?.payload;

beforeEach(() => { writes.length = 0; });
afterEach(cleanup);

describe('#867 Settings: City and State', () => {
  it('shows the saved city and state in editable fields', () => {
    renderTab({ city: 'Lekki', state: 'Maryland' });
    expect((screen.getByLabelText('City or area') as HTMLInputElement).value).toBe('Lekki');
    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('Maryland');
  });

  it('saves a corrected state and city', async () => {
    renderTab({ city: 'Lekki', state: 'Maryland', address: 'Lekki Phase 1, Lagos' });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Lagos' } });
    fireEvent.change(screen.getByLabelText('City or area'), { target: { value: ' Lekki Phase 1 ' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(lastBusinessWrite()).toBeTruthy());
    expect(lastBusinessWrite()).toMatchObject({ state: 'Lagos', city: 'Lekki Phase 1' });
  });

  it('typing an address keeps the existing city and state (no silent blanking)', async () => {
    renderTab({ city: 'Ikoyi', state: 'Lagos', address: '7 Example Drive' });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '8 Example Drive' } });
    expect((screen.getByLabelText('City or area') as HTMLInputElement).value).toBe('Ikoyi');
    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('Lagos');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(lastBusinessWrite()).toBeTruthy());
    expect(lastBusinessWrite()).toMatchObject({ address: '8 Example Drive', city: 'Ikoyi', state: 'Lagos' });
  });

  it('picking an address suggestion fills city and state from it', () => {
    renderTab({ city: '', state: null });
    fireEvent.click(screen.getByRole('button', { name: 'pick suggestion' }));
    expect((screen.getByLabelText('City or area') as HTMLInputElement).value).toBe('Lekki');
    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('Lagos');
  });

  it('empty city and state save as null, not empty strings', async () => {
    renderTab({ city: '', state: null, address: 'Somewhere' });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(lastBusinessWrite()).toBeTruthy());
    expect(lastBusinessWrite()).toMatchObject({ city: null, state: null });
  });
});
