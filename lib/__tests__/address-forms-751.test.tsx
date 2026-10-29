// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[], writes: [] as Array<{ table: string; payload: unknown }>,
  createEvent: vi.fn(), fetch: vi.fn(),
}));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'business-1', name: 'Fixture', country_code: 'NG', currency: 'NGN', capabilities: ['ticketing'], subscription_tier: 'business' }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain: Record<string, any> = {};
      for (const key of ['select', 'eq', 'order', 'limit']) chain[key] = () => chain;
      chain.update = (payload: unknown) => { state.writes.push({ table, payload }); return chain; };
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'events' ? state.rows : [], error: null }).then(resolve);
      return chain;
    },
  }),
}));
vi.mock('@/lib/actions/event-persistence', () => ({ createEvent: state.createEvent }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabel: 'guest', entityNamePlural: 'bookings' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: () => null }));
vi.mock('@/components/dashboard/EmptyState', () => ({ default: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: any) => <span>{children}</span> }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));
// Real form handlers/persistence, controlled selection seam. Provider mechanics are
// exercised separately by places-autocomplete-751, not by network calls here.
vi.mock('@/components/ui/PlacesAutocomplete', () => ({
  default: ({ value, onChange, placeholder }: any) => <div>
    <input aria-label="Physical address" value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
    <button type="button" onClick={() => onChange('10 Main Street, Lagos', { address: '10 Main Street, Lagos', lat: 6.5, lng: 3.4, placeId: 'place-1', city: 'Lagos' })}>Choose address</button>
  </div>,
}));
vi.mock('@/components/ui/AddressAutocomplete', () => ({
  default: ({ onSelect, onManualChange, defaultValue }: any) => <div>
    <input aria-label="Physical address" defaultValue={defaultValue} onChange={event => onManualChange(event.target.value)} />
    <button type="button" onClick={() => onSelect({ address: '10 Main Street', city: 'Lagos', state: 'Lagos State', zipCode: '100001', country: 'NG', latitude: 6.5, longitude: 3.4 })}>Choose address</button>
  </div>,
}));
import { BusinessTab } from '@/app/dashboard/settings/tabs/BusinessTab';
import DiscoveryPage from '@/app/dashboard/discovery/page';
import EventsPage from '@/app/dashboard/events/page';
import LocationsPage from '@/app/dashboard/locations/page';
import InvoicesPage from '@/app/dashboard/invoices/page';
import { StepDetails } from '@/app/get-started/steps/StepDetails';
import type { StepDetailsProps } from '@/app/get-started/steps/types';

beforeEach(() => {
  state.rows = []; state.writes = [];
  state.createEvent.mockReset().mockResolvedValue({ success: true, eventId: 'new-event' });
  state.fetch.mockReset().mockImplementation(async () => ({ ok: true, json: async () => ({ locations: [], invoices: [] }) }));
  vi.stubGlobal('fetch', state.fetch);
  vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('#751 address form contracts', () => {
  it('onboarding selection updates existing address/city/state/postcode setters and preserves manual entry', () => {
    const setAddress = vi.fn(), setCity = vi.fn(), setState = vi.fn(), setZipCode = vi.fn();
    const props = {
      firstName: '', lastName: '', name: '', nameCheckStatus: 'idle', customBotCode: '', botCodeStatus: 'idle',
      suggestedBotCode: '', address: '', city: '', state: '', zipCode: '', businessPhone: '',
      selectedCountry: 'NG', selectedPlan: 'free', waMethod: 'shared', ownPhone: '',
      fbConnecting: false, fbConnected: false, fbSdkReady: false, fbConnectionData: null, discoveredWabas: [],
      agreedToTerms: false, agreedToDataProcessing: false, loading: false, error: '', category: '', categoryInfo: null,
      localTiers: {}, setAddress, setCity, setState, setZipCode,
    } as unknown as StepDetailsProps;
    render(<StepDetails {...props} />);
    fireEvent.click(screen.getByText('Choose address'));
    expect(setAddress).toHaveBeenCalledWith('10 Main Street');
    expect(setCity).toHaveBeenCalledWith('Lagos');
    expect(setState).toHaveBeenCalledWith('Lagos State');
    expect(setZipCode).toHaveBeenCalledWith('100001');
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Manual street' } });
    expect(setAddress).toHaveBeenLastCalledWith('Manual street');
  });

  it('event creation saves the selected venue through the existing action', async () => {
    const view = render(<EventsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New Event' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Gospel Concert 2024'), { target: { value: 'Fixture event' } });
    fireEvent.change(view.container.querySelector('input[type="date"]')!, { target: { value: '2099-11-01' } });
    fireEvent.change(view.container.querySelector('input[type="time"]')!, { target: { value: '10:00' } });
    fireEvent.click(screen.getByText('Choose address'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Event' }));
    await waitFor(() => expect(state.createEvent).toHaveBeenCalled());
    expect(state.createEvent.mock.calls[0][1]).toMatchObject({ venue: '10 Main Street, Lagos', business_id: 'business-1' });
  });

  it('event editing restores a saved venue and persists a manual correction', async () => {
    state.rows = [{ id: 'event-1', name: 'Saved event', date: '2099-11-01', time: '10:00', venue: 'Old venue', status: 'published', price: 0, total_tickets: 100, tickets_sold: 0 }];
    render(<EventsPage />);
    fireEvent.click(await screen.findByText('Saved event'));
    expect((screen.getByLabelText('Physical address') as HTMLInputElement).value).toBe('Old venue');
    fireEvent.click(screen.getByText('Choose address'));
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Manual venue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0]).toMatchObject({ table: 'events', payload: { venue: 'Manual venue' } });
  });

  it('location creation saves selected address and city through POST', async () => {
    render(<LocationsPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: '+ Add Location' }))[0]);
    fireEvent.change(screen.getByPlaceholderText('e.g. Main Branch'), { target: { value: 'Branch' } });
    fireEvent.click(screen.getByText('Choose address'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Location' }));
    await waitFor(() => expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = state.fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(init.body)).toMatchObject({ address: '10 Main Street, Lagos', city: 'Lagos', businessId: 'business-1' });
  });

  it('location editing preserves manual address/city and existing PUT contract', async () => {
    state.fetch.mockResolvedValue({ ok: true, json: async () => ({ locations: [{ id: 'loc-1', name: 'Saved branch', address: 'Old street', city: 'Old city', is_active: true, operating_hours: {} }] }) });
    render(<LocationsPage />);
    fireEvent.click(await screen.findByText('Saved branch'));
    expect((screen.getByLabelText('Physical address') as HTMLInputElement).value).toBe('Old street');
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Manual street' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Lagos'), { target: { value: 'Manual city' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const [, init] = state.fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(init.body)).toMatchObject({ id: 'loc-1', address: 'Manual street', city: 'Manual city' });
  });

  it('invoice creation saves selected customer address without changing payment behavior', async () => {
    const view = render(<InvoicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /New Invoice/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), { target: { value: 'Fixture customer' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Service' } });
    fireEvent.click(screen.getByText('Choose address'));
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(state.fetch.mock.calls.some(([url, init]) => url === '/api/invoices' && init?.method === 'POST')).toBe(true));
    const [, init] = state.fetch.mock.calls.find(([url, init]) => url === '/api/invoices' && init?.method === 'POST')!;
    expect(JSON.parse(init.body)).toMatchObject({ customer_address: '10 Main Street, Lagos', customer_name: 'Fixture customer', business_id: 'business-1' });
    expect(state.fetch.mock.calls.some(([url]) => String(url).includes('/send'))).toBe(false);
  });
});

describe('#751 preserves #485 coordinate contracts', () => {
  it('business settings save selected coordinates and invalidate them after a manual edit', async () => {
    const props = {
      business: { id: 'business-1', name: 'Fixture', address: 'Old street', city: 'Old city', phone: '', subscription_tier: 'free', category: 'other', metadata: {} },
      capabilities: [], country: 'NG', curr: 'NGN', saving: false, saved: false,
      setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['profile'], toggleSection: vi.fn(),
    } as unknown as React.ComponentProps<typeof BusinessTab>;
    render(<BusinessTab {...props} />);
    fireEvent.click(screen.getByText('Choose address'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ address: '10 Main Street, Lagos', city: 'Lagos', latitude: 6.5, longitude: 3.4 });
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Manual street' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1].payload).toMatchObject({ address: 'Manual street', city: null, latitude: null, longitude: null });
  });

  it('discovery selection persists coordinates and manual edits clear them', async () => {
    const view = render(<DiscoveryPage />);
    fireEvent.click(await screen.findByText('Choose address'));
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].payload).toMatchObject({ address: '10 Main Street', city: 'Lagos', latitude: 6.5, longitude: 3.4 });
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Manual street' } });
    fireEvent.submit(view.container.querySelector('form')!);
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1].payload).toMatchObject({ address: 'Manual street', latitude: null, longitude: null });
  });
});
