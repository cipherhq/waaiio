// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@/lib/capabilities/types';
const m = vi.hoisted(() => ({ business: { id: 'tenant-a', subscription_tier: 'business', capabilities: ['chat'], selectedCapabilities: ['chat'], capabilityOverrides: [], feature_trial_ends_at: null }, fetch: vi.fn() }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => m.business }));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
import CapabilitiesPage from '../page';
const definition = CAPABILITIES.find(c => c.id === 'custom_flow')!;
function card() { return screen.getByRole('heading', { name: definition.label }).parentElement!.parentElement!.parentElement!; }
beforeEach(() => {
  m.business.subscription_tier = 'business'; m.business.capabilities = ['chat']; m.business.selectedCapabilities = ['chat'];
  m.fetch.mockReset().mockResolvedValue({ ok: false, json: async () => ({ reason: 'capabilities_denied' }) });
  vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('shows every catalog capability exactly once, including Custom Flows in Operations', () => {
  render(<CapabilitiesPage />);
  for (const capability of CAPABILITIES) expect(screen.getAllByRole('heading', { name: capability.label, level: 3 })).toHaveLength(1);
  expect(within(card()).getByText(definition.description)).toBeTruthy();
  const group = screen.getByRole('heading', { name: 'Operations' }).parentElement!.parentElement!;
  expect(within(group).getByRole('heading', { name: definition.label })).toBeTruthy();
});
it('stages enable through the existing save payload and rolls back a server plan denial', async () => {
  render(<CapabilitiesPage />);
  fireEvent.click(within(card()).getByRole('button', { name: 'Enable' }));
  expect(within(card()).getByRole('button', { name: 'Enabled ✓' })).toBeTruthy();
  expect(m.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(within(card()).getByRole('button', { name: 'Enable' })).toBeTruthy());
  expect(m.fetch).toHaveBeenCalledExactlyOnceWith('/api/capabilities/configure', expect.objectContaining({ method: 'POST' }));
  expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual({ businessId: 'tenant-a', capabilities: ['chat', 'custom_flow'], order: ['chat', 'custom_flow'] });
  expect(within(card()).getByRole('button', { name: 'Enable' })).toBeTruthy();
});
it('stages disable without losing another selected capability', async () => {
  m.business.capabilities = ['chat', 'custom_flow']; m.business.selectedCapabilities = ['chat', 'custom_flow'];
  render(<CapabilitiesPage />);
  fireEvent.click(within(card()).getByRole('button', { name: 'Enabled ✓' }));
  expect(within(card()).getByRole('button', { name: 'Enable' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(m.fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual({ businessId: 'tenant-a', capabilities: ['chat'], order: ['chat'] });
});
it('retains the existing upgrade restriction on the free plan', () => {
  m.business.subscription_tier = 'free'; render(<CapabilitiesPage />);
  expect(within(card()).getByRole('link', { name: 'Upgrade' }).getAttribute('href')).toBe('/dashboard/settings');
  expect(within(card()).queryByRole('button')).toBeNull();
  expect(m.fetch).not.toHaveBeenCalled();
});
