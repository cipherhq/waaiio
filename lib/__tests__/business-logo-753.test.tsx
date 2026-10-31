// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  fetch: vi.fn(),
  alert: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/hooks/useCategoryConfig', () => ({
  useCategoryConfig: () => ({ labels: { personLabel: 'guest', entityNamePlural: 'bookings' } }),
}));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/app/dashboard/settings/tabs/NotificationsTab', () => ({
  NotificationsTab: () => <p>Notifications fixture</p>,
}));
vi.mock('@/app/dashboard/settings/tabs/PaymentsTab', () => ({ PaymentsTab: () => null }));
vi.mock('@/app/dashboard/settings/tabs/FeaturesTab', () => ({ FeaturesTab: () => null }));
vi.mock('@/app/dashboard/settings/tabs/AccountTab', () => ({ AccountTab: () => null }));
vi.mock('@/components/dashboard/settings/IntegrationsTab', () => ({ IntegrationsTab: () => null }));
// Keep the real logo handler and Settings mount lifecycle; isolate only Places/network boundaries.
vi.mock('@/components/ui/PlacesAutocomplete', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    <input aria-label="Physical address" value={value} onChange={event => onChange(event.target.value)} />,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => { throw new Error('Unexpected database call in logo lifecycle test'); },
}));

import SettingsPage from '@/app/dashboard/settings/page';
import { DashboardProvider, type Business } from '@/components/dashboard/DashboardProvider';

const OLD_LOGO = 'https://example.test/old-logo.png';
const NEW_LOGO = 'https://example.test/new-logo.png';

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: 'business-1', owner_id: 'owner-1', name: 'Fixture business',
    description: 'Saved description', address: 'Saved address', city: 'Saved city',
    phone: '', email: '', category: 'other', subscription_tier: 'free',
    country_code: 'NG', metadata: {}, operating_hours: null, deposit_per_guest: 0,
    logo_url: OLD_LOGO, capabilities: [], selectedCapabilities: [],
    pausedCapabilities: [], disabledCapabilities: [], capabilityOverrides: [],
    ...overrides,
  } as Business;
}

function tree(value: Business) {
  return <DashboardProvider business={value} userId="owner-1"><SettingsPage /></DashboardProvider>;
}

function upload(container: HTMLElement) {
  const file = new File(['synthetic image bytes'], 'logo.png', { type: 'image/png' });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [file] } });
  return file;
}

function logo() {
  return screen.getByRole('img', { name: 'Business logo' }).getAttribute('src');
}

function leaveAndReturn() {
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(screen.queryByRole('img', { name: 'Business logo' })).toBeNull();
  expect(screen.getByText('Notifications fixture')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Business' }));
}

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.alert.mockReset();
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true, url: NEW_LOGO }) });
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('alert', mocks.alert);
  window.history.replaceState({}, '', '/dashboard/settings');
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('#753 business logo refresh lifecycle', () => {
  it('updates the immediate preview and refreshes after a successful upload for the selected business', async () => {
    const view = render(tree(business()));
    expect(logo()).toBe(OLD_LOGO);
    const file = upload(view.container);
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('/api/business/upload-logo');
    expect(init.method).toBe('POST');
    expect(init.body.get('business_id')).toBe('business-1');
    expect(init.body.get('file')).toBe(file);
  });

  it('repairs a remounted preview when delayed refreshed props arrive and retains it on subsequent tab return', async () => {
    const initial = business();
    const view = render(tree(initial));
    upload(view.container);
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    // The server refresh has not returned yet: actual Settings tabs unmount/remount BusinessTab.
    leaveAndReturn();
    expect(logo()).toBe(OLD_LOGO);
    view.rerender(tree({ ...initial, logo_url: NEW_LOGO }));
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));
    leaveAndReturn();
    expect(logo()).toBe(NEW_LOGO);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('synchronizes only the logo and preserves unsaved profile and manual address edits', async () => {
    const initial = business();
    const view = render(tree(initial));
    fireEvent.change(screen.getByDisplayValue('Fixture business'), { target: { value: 'Unsaved name' } });
    fireEvent.change(screen.getByDisplayValue('Saved description'), { target: { value: 'Unsaved description' } });
    fireEvent.change(screen.getByLabelText('Physical address'), { target: { value: 'Unsaved address' } });

    view.rerender(tree({ ...initial, logo_url: NEW_LOGO }));
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));
    expect(screen.getByDisplayValue('Unsaved name')).toBeTruthy();
    expect(screen.getByDisplayValue('Unsaved description')).toBeTruthy();
    expect((screen.getByLabelText('Physical address') as HTMLInputElement).value).toBe('Unsaved address');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['rejected response', 'network error'])('preserves the logo without success refresh on %s', async (failure) => {
    if (failure === 'network error') mocks.fetch.mockRejectedValueOnce(new Error('network unavailable'));
    else mocks.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Upload rejected' }) });
    const view = render(tree(business()));
    upload(view.container);
    await waitFor(() => expect(mocks.alert).toHaveBeenCalledTimes(1));
    expect(logo()).toBe(OLD_LOGO);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(false);
  });

  it('resets an optimistic logo on business identity change even when the persisted logo value is unchanged', async () => {
    const initial = business();
    const view = render(tree(initial));
    upload(view.container);
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));

    // Both businesses still have OLD_LOGO in their server props; identity must trigger the sync.
    view.rerender(tree(business({ id: 'business-2' })));
    await waitFor(() => expect(logo()).toBe(OLD_LOGO));
    upload(view.container);
    await waitFor(() => expect(logo()).toBe(NEW_LOGO));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.fetch.mock.calls[1][1].body.get('business_id')).toBe('business-2');
  });
});
