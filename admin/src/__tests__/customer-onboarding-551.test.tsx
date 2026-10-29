import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ create: vi.fn(), predict: vi.fn(), details: vi.fn() }));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: provider.create }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: api.get, adminApiFetch: api.post }));

import CustomerOnboarding from '@/pages/CustomerOnboarding';

describe('#551 Admin customer onboarding journey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider.create.mockReset().mockRejectedValue(new Error('Places unavailable'));
    provider.predict.mockReset(); provider.details.mockReset();
    vi.stubGlobal('crypto', { randomUUID: () => '9f96271c-6715-4e20-ab96-fce6409ed4cd' });
    api.get.mockImplementation(async () => new Response(JSON.stringify({
      onboardings: [],
      options: {
        countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }],
        categories: [{ key: 'restaurant', name: 'Restaurant' }],
      },
    }), { status: 200 }));
    api.post.mockImplementation(async () => new Response(JSON.stringify({ onboarding: { id: 'onboarding-1' } }), { status: 201 }));
  });

  it('reviews exact owner/business data before sending an idempotent server request', async () => {
    render(<CustomerOnboarding />);
    await screen.findByLabelText('Owner email');
    const ownerFields: Record<string, string> = {
      'Owner first name': 'Ada', 'Owner last name': 'Lovelace', 'Owner email': 'ada@example.test',
    };
    for (const [label, value] of Object.entries(ownerFields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('option', { name: 'Restaurant' });
    const businessFields: Record<string, string> = {
      'Business name': 'Exact Business', 'Business phone': '+2348012345678',
      'Country code': 'NG', 'Category key': 'restaurant', City: 'Lagos', Address: '1 Test Street',
    };
    for (const [label, value] of Object.entries(businessFields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    expect(screen.getByText('Review before creation')).toBeInTheDocument();
    expect(screen.getByText(/Exact Business/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      request_key: '9f96271c-6715-4e20-ab96-fce6409ed4cd', owner_email: 'ada@example.test', business_name: 'Exact Business',
      address: '1 Test Street', city: 'Lagos', country: 'NG',
    }));
    expect(await screen.findByText('Activation invitation sent. Customer action is now required.')).toBeInTheDocument();
  });

  it('fails closed when the authoritative country API is unavailable', async () => {
    api.get.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }));
    render(<CustomerOnboarding />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load supported countries');
    expect(screen.queryByLabelText('Country code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review onboarding' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('keeps the UI category name contract for categories sourced from database labels', async () => {
    // GET /api/admin/onboarding selects category_templates.label AS name.
    // The client must continue rendering the mapped name in its category selector.
    api.get.mockResolvedValueOnce(new Response(JSON.stringify({
      onboardings: [],
      options: { countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }],
        categories: [{ key: 'restaurant', name: 'Restaurant' }] },
    }), { status: 200 }));
    render(<CustomerOnboarding />);
    await screen.findByLabelText('Owner email');
    fireEvent.change(screen.getByLabelText('Owner first name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Owner last name'), { target: { value: 'Lovelace' } });
    fireEvent.change(screen.getByLabelText('Owner email'), { target: { value: 'ada@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('option', { name: 'Restaurant' })).toBeInTheDocument();
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
  function enablePlaces() {
    provider.create.mockResolvedValue({ predictions: { getPlacePredictions: provider.predict }, details: { getDetails: provider.details } });
    provider.predict.mockImplementation((_request, callback) => callback([{
      place_id: 'one', description: '10 Main Street, Lagos',
      structured_formatting: { main_text: '10 Main Street', secondary_text: 'Lagos' },
    }], 'OK'));
  }
  const selectedPlace = { formatted_address: '10 Main Street, Lagos', address_components: [
    { long_name: '10', types: ['street_number'] }, { long_name: 'Main Street', types: ['route'] },
    { long_name: 'Lagos', types: ['locality'] }, { long_name: 'Lagos State', types: ['administrative_area_level_1'] },
    { long_name: '100001', types: ['postal_code'] },
    // Provider data cannot replace the explicitly selected supported country.
    { long_name: 'United Kingdom', short_name: 'GB', types: ['country'] },
  ] };
  it('fills structured address, preserves country/back navigation and submits the existing payload', async () => {
    enablePlaces();
    provider.details.mockImplementation((_request, callback) => callback(selectedPlace, 'OK'));
    await openBusiness();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Main' } });
    await screen.findByRole('option', { name: /10 Main Street/ });
    fireEvent.keyDown(screen.getByLabelText('Address'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByLabelText('Address'), { key: 'Enter' });
    expect(screen.getByLabelText('Address')).toHaveValue('10 Main Street');
    expect(screen.getByLabelText('City')).toHaveValue('Lagos');
    expect(screen.getByLabelText('State')).toHaveValue('Lagos State');
    expect(screen.getByLabelText('Postcode')).toHaveValue('100001');
    expect(screen.getByLabelText('Country code')).toHaveValue('NG');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Address')).toHaveValue('10 Main Street');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      address: '10 Main Street', city: 'Lagos', state: 'Lagos State', postcode: '100001',
      country: 'NG', business_name: 'Address Business', category: 'restaurant', intended_plan: 'free',
      request_key: '9f96271c-6715-4e20-ab96-fce6409ed4cd',
    }));
    await screen.findByText('Activation invitation sent. Customer action is now required.');
  });
  it('rejects old selected details after a supported-country change and retains manual fields', async () => {
    enablePlaces();
    api.get.mockResolvedValueOnce(new Response(JSON.stringify({ onboardings: [], options: {
      countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234' }, { code: 'GB', name: 'United Kingdom', dialing_code: '+44' }],
      categories: [{ key: 'restaurant', name: 'Restaurant' }],
    } }), { status: 200 }));
    let finish: (place: unknown, status: string) => void = () => {};
    provider.details.mockImplementation((_request, callback) => { finish = callback; });
    await openBusiness();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Main' } });
    fireEvent.click(await screen.findByRole('option', { name: /10 Main Street/ }));
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: 'GB' } });
    act(() => finish(selectedPlace, 'OK'));
    expect(screen.getByLabelText('City')).toHaveValue('');
    expect(screen.getByLabelText('Country code')).toHaveValue('GB');
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Manual address' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'London' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({ address: 'Manual address', city: 'London', country: 'GB' }));
    await screen.findByText('Activation invitation sent. Customer action is now required.');
  });

});
