// @vitest-environment jsdom
// Discovery Profile: the business Description can be filled in on the page, and
// items edited in Settings (Logo, Business Hours) link there.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DiscoveryPage from '@/app/dashboard/discovery/page';

const mocks = vi.hoisted(() => ({ client: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.client }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'biz-1', name: 'TestBiz', category: 'salon', country_code: 'NG' }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({ default: () => null }));

let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    discovery_enabled: true, discovery_description: 'We are the best', discovery_keywords: ['Hair'], price_band: 'mid',
    supports_delivery: false, delivery_radius_km: null, max_group_size: 10, latitude: 6.5, longitude: 3.4,
    address: '1 Main St', city: 'Lagos', description: null, operating_hours: null, logo_url: null,
  };
  mocks.update.mockReturnValue({ eq: () => Promise.resolve({ error: null }) });
  mocks.client.mockReturnValue({
    from: () => ({
      select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: [row], error: null }) }) }),
      update: mocks.update,
    }),
  });
});
afterEach(() => cleanup());

describe('Discovery Profile description', () => {
  it('shows a Description field and saves it to the business description', async () => {
    render(<DiscoveryPage />);
    const field = await screen.findByLabelText('Description');
    expect(screen.getByText('Missing items:')).toBeTruthy();
    expect(screen.getByText('Description', { selector: 'span' })).toBeTruthy();

    fireEvent.change(field, { target: { value: 'Braids, locs and cuts in Lagos' } });
    // The chip goes away as soon as the field has text.
    expect(screen.queryByText('Description', { selector: 'span' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    const payload = mocks.update.mock.calls[0][0];
    expect(payload.description).toBe('Braids, locs and cuts in Lagos');
    // The Short Listing Summary is still saved separately.
    expect(payload.discovery_description).toBe('We are the best');
    // Dashboard data is reloaded, so Settings → Business opens with the saved description.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it('does not reload dashboard data when the save fails', async () => {
    mocks.update.mockReturnValue({ eq: () => Promise.resolve({ error: { message: 'denied' } }) });
    render(<DiscoveryPage />);
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
    expect(await screen.findByText('Failed to save profile. Please try again.')).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('loads an existing description into the field', async () => {
    row.description = 'Family salon since 1999';
    render(<DiscoveryPage />);
    expect(((await screen.findByLabelText('Description')) as HTMLTextAreaElement).value).toBe('Family salon since 1999');
  });

  it('links Logo and Business Hours to where they are edited in Settings', async () => {
    render(<DiscoveryPage />);
    const logo = await screen.findByRole('link', { name: 'Logo (in Settings)' });
    expect(logo.getAttribute('href')).toBe('/dashboard/settings?tab=business');
    expect(screen.getByRole('link', { name: 'Business Hours (in Settings)' }).getAttribute('href'))
      .toBe('/dashboard/settings?tab=business&section=hours');
  });
});
