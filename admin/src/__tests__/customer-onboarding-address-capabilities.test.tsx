import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@shared/capabilities';

const provider = vi.hoisted(() => ({ create: vi.fn(), predict: vi.fn(), details: vi.fn() }));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: provider.create }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: api.get, adminApiFetch: api.post }));

import CustomerOnboarding from '@/pages/CustomerOnboarding';

const selectedPlace = { formatted_address: '10 Main Street, Lagos', address_components: [
  { long_name: '10', types: ['street_number'] }, { long_name: 'Main Street', types: ['route'] },
  { long_name: 'Lagos', types: ['locality'] }, { long_name: 'Lagos State', types: ['administrative_area_level_1'] },
  { long_name: '100001', types: ['postal_code'] },
] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => '9f96271c-6715-4e20-ab96-fce6409ed4cd' });
  provider.create.mockResolvedValue({ predictions: { getPlacePredictions: provider.predict }, details: { getDetails: provider.details }, reset: vi.fn() });
  provider.predict.mockImplementation((_request, callback) => callback([{
    place_id: 'one', description: '10 Main Street, Lagos',
    structured_formatting: { main_text: '10 Main Street', secondary_text: 'Lagos' },
  }], 'OK'));
  provider.details.mockImplementation((_request, callback) => callback(selectedPlace, 'OK'));
  api.get.mockImplementation(async () => new Response(JSON.stringify({ onboardings: [], options: {
    countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }],
    categories: [{ key: 'restaurant', name: 'Restaurant' }],
  } }), { status: 200 }));
  api.post.mockImplementation(async () => new Response(JSON.stringify({ onboarding: { id: 'onboarding-1' } }), { status: 201 }));
});

async function openBusiness() {
  render(<CustomerOnboarding />);
  await screen.findByLabelText('Owner email');
  for (const [label, value] of Object.entries({ 'Owner first name': 'Ada', 'Owner last name': 'Lovelace', 'Owner email': 'ada@example.test' })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Address');
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'Address Business' } });
  fireEvent.change(screen.getByLabelText('Business phone'), { target: { value: '+2348012345678' } });
}

const follows = (earlier: HTMLElement, later: HTMLElement) =>
  Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Onboard Customer: address directly under Country', () => {
  it('renders Address as the next field after Country, before Category, City, State and Postcode', async () => {
    await openBusiness();
    const fields = Array.from(document.querySelectorAll('form input, form select')) as HTMLElement[];
    const country = screen.getByLabelText('Country code');
    const address = screen.getByLabelText('Address');
    expect(fields.indexOf(address)).toBe(fields.indexOf(country) + 1);
    for (const label of ['Category key', 'City', 'State', 'Postcode']) {
      expect(follows(address, screen.getByLabelText(label))).toBe(true);
    }
    // Both span the full row so Address sits under Country on wide screens too.
    expect(country.closest('label')).toHaveClass('md:col-span-2');
    expect(address.closest('label')).toHaveClass('md:col-span-2');
  });

  it('picking an address fills City, State and Postcode, which stay editable', async () => {
    await openBusiness();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Main' } });
    await screen.findByRole('option', { name: /10 Main Street/ });
    fireEvent.keyDown(screen.getByLabelText('Address'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('Address'), { key: 'Enter' });
    expect(screen.getByLabelText('City')).toHaveValue('Lagos');
    expect(screen.getByLabelText('State')).toHaveValue('Lagos State');
    expect(screen.getByLabelText('Postcode')).toHaveValue('100001');
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Ikeja' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'Lagos' } });
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '100271' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      address: '10 Main Street', city: 'Ikeja', state: 'Lagos', postcode: '100271',
    }));
  });
});

describe('Onboard Customer: every capability on every plan', () => {
  async function openSetup() {
    await openBusiness();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Lagos' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '1 Test Street' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('group', { name: 'Capabilities' });
  }

  it('shows all capabilities on Free with the real plan tag, and keeps them ticked across plan changes', async () => {
    await openSetup();
    expect(screen.getAllByRole('checkbox')).toHaveLength(CAPABILITIES.length);
    const broadcast = screen.getByRole('checkbox', { name: /^Broadcasts/ });
    const documents = screen.getByRole('checkbox', { name: /^Documents/ });
    expect(broadcast).toHaveAccessibleName('Broadcasts Pro — included in 14-day trial');
    expect(documents).toHaveAccessibleName('Documents Premium — included in 14-day trial');
    expect(screen.getByRole('checkbox', { name: 'Online Store' })).toBeEnabled();
    fireEvent.click(broadcast);
    fireEvent.click(documents);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Online Store' }));

    const plan = screen.getByRole('combobox', { name: /Starting plan/ });
    fireEvent.change(plan, { target: { value: 'growth' } });
    expect(screen.getByRole('checkbox', { name: 'Broadcasts' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Documents Premium — included in 14-day trial' })).toBeChecked();
    fireEvent.change(plan, { target: { value: 'business' } });
    expect(screen.getByRole('checkbox', { name: 'Documents' })).toBeChecked();
    fireEvent.change(plan, { target: { value: 'free' } });
    expect(screen.getByRole('checkbox', { name: /^Broadcasts/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Documents/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      intended_plan: 'free', capabilities: ['broadcast', 'reports', 'ordering'],
    }));
  });
});
