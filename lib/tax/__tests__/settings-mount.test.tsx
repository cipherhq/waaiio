// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
const h = vi.hoisted(() => ({ country: 'UK', currency: 'GBP' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('tab=payments') }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'b', country_code: h.country }), useCapabilities: () => ({ capabilities: [] }) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: () => '£0', getCurrencyCode: () => h.currency }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {} }));
vi.mock('@/components/dashboard/settings/MerchantTaxSettings', () => ({ MerchantTaxSettings: () => <div>Merchant tax controls</div> }));
vi.mock('@/components/dashboard/settings/IntegrationsTab', () => ({ IntegrationsTab: () => null }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/app/dashboard/settings/tabs/BusinessTab', () => ({ BusinessTab: () => null }));
vi.mock('@/app/dashboard/settings/tabs/PaymentsTab', () => ({ PaymentsTab: () => <div>Payments</div> }));
vi.mock('@/app/dashboard/settings/tabs/FeaturesTab', () => ({ FeaturesTab: () => null }));
vi.mock('@/app/dashboard/settings/tabs/NotificationsTab', () => ({ NotificationsTab: () => null }));
vi.mock('@/app/dashboard/settings/tabs/AccountTab', () => ({ AccountTab: () => null }));
import SettingsPage from '@/app/dashboard/settings/page';
afterEach(cleanup);
it('mounts the existing tax settings controls for a supported resolved currency', async () => {
 h.country='UK'; h.currency='GBP'; render(<SettingsPage />); await screen.findByText('Merchant tax controls');
});
it('does not enable tax settings for a mismatched authoritative currency', async () => {
 h.country='UK'; h.currency='EUR'; render(<SettingsPage />); await waitFor(() => expect(screen.getByText('Payments')).toBeTruthy());
 expect(screen.queryByText('Merchant tax controls')).toBeNull();
});
