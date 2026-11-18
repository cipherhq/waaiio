/**
 * Onboard Customer asks for the same required fields as Get Started
 * (Owner request 2026-11-18): WhatsApp Name, at least one feature and the full
 * business phone number, with the same messages the server route returns.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/lib/googlePlaces', () => ({ createGooglePlacesServices: provider.create }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: api.get, adminApiFetch: api.post }));

import CustomerOnboarding from '@/pages/CustomerOnboarding';

beforeEach(() => {
  vi.clearAllMocks();
  provider.create.mockReset().mockRejectedValue(new Error('Places unavailable'));
  vi.stubGlobal('crypto', { randomUUID: () => '9f96271c-6715-4e20-ab96-fce6409ed4cd' });
  api.get.mockImplementation(async () => new Response(JSON.stringify({ onboardings: [], options: {
    countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234', phone_digits: 10 }],
    categories: [{ key: 'restaurant', name: 'Restaurant' }],
  } }), { status: 200 }));
  api.post.mockImplementation(async () => new Response(JSON.stringify({ onboarding: { id: 'onboarding-1' } }), { status: 201 }));
});

async function openBusiness(business: Record<string, string> = {}) {
  render(<CustomerOnboarding />);
  await screen.findByLabelText('Owner email');
  for (const [label, value] of Object.entries({ 'Owner first name': 'Ada', 'Owner last name': 'Lovelace', 'Owner email': 'ada@example.test' })) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByLabelText('Address');
  const fields = { 'Business name': 'Required Business', 'Business phone': '+2348012345678', City: 'Lagos', Address: '1 Test Street', 'Your WhatsApp Name': 'REQUIRED-BIZ', ...business };
  for (const [label, value] of Object.entries(fields)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const continueButton = () => screen.getByRole('button', { name: 'Continue' });

describe('Onboard Customer: WhatsApp Name, as in Get Started', () => {
  it('is a required field with the Get Started explanation, cleaned up as it is typed', async () => {
    await openBusiness();
    const name = screen.getByLabelText('Your WhatsApp Name');
    expect(name).toBeRequired();
    expect(name).toHaveAccessibleDescription(/name people will text to the Waaiio WhatsApp number/);
    fireEvent.change(name, { target: { value: 'lolah beauty!' } });
    expect(name).toHaveValue('LOLAH-BEAUTY');
  });

  it('stops on a missing WhatsApp Name', async () => {
    await openBusiness({ 'Your WhatsApp Name': '' });
    // Like Get Started, the browser's required-field check stops the step.
    expect(screen.getByLabelText('Your WhatsApp Name')).toBeInvalid();
    fireEvent.click(continueButton());
    expect(screen.getByLabelText('Your WhatsApp Name')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Capabilities' })).not.toBeInTheDocument();
    // Without the browser check (e.g. novalidate), the page's own check still stops it.
    (screen.getByLabelText('Your WhatsApp Name').closest('form') as HTMLFormElement).noValidate = true;
    fireEvent.click(continueButton());
    expect(await screen.findByText('WhatsApp Name is required')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Capabilities' })).not.toBeInTheDocument();
  });

  it('stops on a WhatsApp Name shorter than 2 letters or numbers', async () => {
    await openBusiness({ 'Your WhatsApp Name': 'a' });
    fireEvent.click(continueButton());
    expect(await screen.findByText('WhatsApp Name must be at least 2 letters or numbers')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Capabilities' })).not.toBeInTheDocument();
  });
});

describe('Onboard Customer: full business phone number, as in Get Started', () => {
  it('shows the expected format for the selected country', async () => {
    await openBusiness();
    expect(screen.getByLabelText('Business phone')).toHaveAccessibleDescription('Full number: +234 followed by 10 digits');
  });

  it.each(['08012345678', '+234801234567', '+23480123456789'])('stops on %s', async phone => {
    await openBusiness({ 'Business phone': phone });
    fireEvent.click(continueButton());
    expect(await screen.findByText('Business phone must be the full number: +234 followed by 10 digits')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Capabilities' })).not.toBeInTheDocument();
  });

  it('uses the country phone length from the options', async () => {
    api.get.mockImplementationOnce(async () => new Response(JSON.stringify({ onboardings: [], options: {
      countries: [{ code: 'NG', name: 'Nigeria', dialing_code: '+234', phone_digits: 11 }],
      categories: [{ key: 'restaurant', name: 'Restaurant' }],
    } }), { status: 200 }));
    await openBusiness();
    fireEvent.click(continueButton());
    expect(await screen.findByText('Business phone must be the full number: +234 followed by 11 digits')).toBeInTheDocument();
  });
});

describe('Onboard Customer: at least one feature, as in Get Started', () => {
  it('stops on no selected feature and sends nothing', async () => {
    await openBusiness();
    fireEvent.click(continueButton());
    await screen.findByRole('group', { name: 'Capabilities' });
    expect(screen.getByText('Please select at least one feature to continue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    expect(screen.getByRole('status')).toHaveTextContent('Please select at least one feature to continue');
    expect(screen.queryByText('Review before creation')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Onboard Customer: complete request', () => {
  it('sends the WhatsApp Name, a feature and the cleaned full phone number', async () => {
    await openBusiness({ 'Business phone': '+234 801 234 5678', 'Your WhatsApp Name': 'my shop' });
    fireEvent.click(continueButton());
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Online Store' }));
    expect(screen.queryByText('Please select at least one feature to continue')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    expect(screen.getByText('MY-SHOP')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
    expect(api.post).toHaveBeenCalledWith('/api/admin/onboarding', expect.objectContaining({
      bot_code: 'MY-SHOP', business_phone: '+2348012345678', capabilities: ['ordering'],
    }));
  });

  it('shows the server message when the WhatsApp Name is taken', async () => {
    api.post.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Bot code is already taken. Please choose a different one.' }), { status: 400 }));
    await openBusiness();
    fireEvent.click(continueButton());
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Online Store' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review onboarding' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and send invite' }));
    expect(await screen.findByText('Bot code is already taken. Please choose a different one.')).toBeInTheDocument();
  });
});
