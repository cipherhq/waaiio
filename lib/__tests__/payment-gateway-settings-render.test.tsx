/** @vitest-environment jsdom */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PaymentsTab } from '@/app/dashboard/settings/tabs/PaymentsTab';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) }) }) }));
const request = vi.fn();
const fixture = (capabilities: SettingsTabProps['capabilities']): SettingsTabProps => ({
  business: { id: 'test-business', name: 'Test merchant', country_code: 'NG', subscription_tier: 'free', metadata: {} } as SettingsTabProps['business'],
  capabilities, country: 'NG', curr: 'NGN', saving: false, saved: false,
  setSaving: vi.fn(), setSaved: vi.fn(), openSections: ['gateway'], toggleSection: vi.fn(),
});
beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ ok: true, json: async () => ({ credentials: [], zones: [] }) });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('payment gateway settings rendering', () => {
  it.each([['payment'], ['ordering'], ['ticketing'], ['crowdfunding'], ['payment', 'ordering', 'ticketing']] as SettingsTabProps['capabilities'][])('shows gateway controls for %j', async (...capabilities) => {
    render(<PaymentsTab {...fixture(capabilities as SettingsTabProps['capabilities'])} />);
    expect(screen.getByRole('button', { name: 'Payment Gateway' })).toBeTruthy();
    expect(screen.getByText('Use Paystack API keys')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect with Paystack/ })).toBeTruthy();
    await waitFor(() => expect(request).toHaveBeenCalled());
  });
  it('hides gateway controls without an eligible capability', async () => {
    render(<PaymentsTab {...fixture([])} />);
    expect(screen.queryByRole('button', { name: 'Payment Gateway' })).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalled());
  });
  it('submits Paystack keys to the existing owner-scoped endpoint and clears them on success', async () => {
    request.mockImplementation(async (_url, options) => options?.method === 'POST'
      ? { ok: true, json: async () => ({ credential: { id: 'credential', gateway: 'paystack', connection_type: 'byo' }, webhookUrl: 'https://staging.example/api/payments/byo-webhook/test-business' }) }
      : { ok: true, json: async () => ({ credentials: [], zones: [] }) });
    render(<PaymentsTab {...fixture(['payment'])} />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Use Paystack API keys'));
    const secret = screen.getByLabelText('Paystack secret key') as HTMLInputElement;
    const publicKey = screen.getByLabelText('Paystack public key (optional)') as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(secret, { target: { value: 'dummy-secret-fixture' } });
    fireEvent.change(publicKey, { target: { value: 'dummy-public-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Connect Paystack' }));
    await screen.findByText('Paystack connected');
    const post = request.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post?.[0]).toBe('/api/settings/payment-credentials');
    expect(JSON.parse(post?.[1].body)).toEqual({ business_id: 'test-business', gateway: 'paystack', secret_key: 'dummy-secret-fixture', public_key: 'dummy-public-fixture' });
    expect(screen.getByText('https://staging.example/api/payments/byo-webhook/test-business')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('dummy-secret-fixture');
    expect(screen.queryByLabelText('Paystack secret key')).toBeNull();
  });
  it('shows a failed connection without claiming success', async () => {
    request.mockImplementation(async (_url, options) => options?.method === 'POST'
      ? { ok: false, json: async () => ({ error: 'Could not verify payment account' }) }
      : { ok: true, json: async () => ({ credentials: [], zones: [] }) });
    render(<PaymentsTab {...fixture(['ticketing'])} />);
    await waitFor(() => expect(request).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Use Paystack API keys'));
    fireEvent.change(screen.getByLabelText('Paystack secret key'), { target: { value: 'dummy-secret-fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & Connect Paystack' }));
    expect(await screen.findByText('Could not verify payment account')).toBeTruthy();
    expect(screen.queryByText('Paystack connected')).toBeNull();
  });
});
