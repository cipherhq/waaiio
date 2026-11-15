// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), query: {} as Record<string, unknown>, business: { id: 'tenant-a', name: 'Demo', category: 'salon', country_code: 'NG' } }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => mocks.business }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => mocks.query }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { quantityLabel: 'people', personLabel: 'Customer', personLabelPlural: 'Customers' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
import CustomersPage from '../page';
beforeEach(() => {
  for (const method of ['select', 'eq', 'order', 'in']) mocks.query[method] = () => mocks.query;
  mocks.query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [] }).then(resolve);
  mocks.fetch.mockReset().mockResolvedValue({ json: async () => ({ imported: 1, skipped: 0 }) });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('renders rejected phone rows and submits only valid canonical international numbers', async () => {
  render(<CustomersPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
  fireEvent.change(screen.getByPlaceholderText(/Jane Doe/), { target: { value: 'name,phone,email\nBad,+234801234567890123,\nLocal,08012345678,\nAda,+1 (415) 555-2671,ada@example.com' } });
  expect(screen.getByText('Preview: 1 valid of 3 rows')).toBeTruthy();
  expect(screen.getAllByTitle('Invalid phone number')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Import 1 Contacts' }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ businessId: 'tenant-a', contacts: [{ name: 'Ada', phone: '+14155552671', email: 'ada@example.com' }] });
});
it('disables import when every phone is invalid', () => {
  render(<CustomersPage />);
  fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
  fireEvent.change(screen.getByPlaceholderText(/Jane Doe/), { target: { value: 'Bad,2.348012345678E+12,\nBad,+12001234567,' } });
  expect((screen.getByRole('button', { name: 'Import 0 Contacts' }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
