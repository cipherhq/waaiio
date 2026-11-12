// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const h = vi.hoisted(() => ({ currency: 'GBP', country: 'UK', id: 'business' }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: h.id, country_code: h.country }) }));
vi.mock('@/lib/constants', async original => ({ ...await original<typeof import('@/lib/constants')>(), getCurrencyCode: () => h.currency }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => {} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/components/ui/PlacesAutocomplete', () => ({ default: () => null }));
vi.mock('@/components/auth/PhoneInput', () => ({ PhoneInput: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: () => null }));
import InvoicesPage from '@/app/dashboard/invoices/page';
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
 h.currency = 'GBP'; h.country = 'UK'; h.id = 'business';
 fetcher = vi.fn(async (url: string, options?: { method?: string }) => ({ ok: true, json: async () => url.includes('tax-settings')
  ? { settings: { enabled: true, label: 'VAT', rate_bps: 887.5, price_mode: 'exclusive' } }
  : options?.method === 'POST' ? { id: 'invoice', total_amount: 16.33 } : { invoices: [] } }));
 vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses the merchant default and persists per-line exemption with fractional hours', async () => {
 render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'New Invoice' }));
 await screen.findByText('Business default: VAT 8.875% (exclusive)');
 fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), { target: { value: 'Buyer' } });
 fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Consulting' } });
 fireEvent.change(screen.getByPlaceholderText('Qty'), { target: { value: '1.5' } });
 fireEvent.change(screen.getByPlaceholderText('Price'), { target: { value: '10' } });
 fireEvent.change(screen.getAllByLabelText('Tax treatment')[0], { target: { value: 'exempt' } });
 fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
 await waitFor(() => expect(fetcher.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(true));
 const call = fetcher.mock.calls.find(([,options]) => options?.method === 'POST')!;
 const payload = JSON.parse((call[1] as { body: string }).body);
 expect(payload).toMatchObject({ tax_version: 1, currency: 'GBP', items: [{ quantity: 1.5, unit_price: 10, tax_treatment: 'exempt' }] });
 expect(payload).not.toHaveProperty('tax_rate'); expect(payload).not.toHaveProperty('tax_config');
});

it.each(['GHS', 'EUR'])('keeps legacy %s invoice single-rate UI and tax payload', async currency => {
 h.currency=currency; h.country=currency==='GHS' ? 'GH' : 'FR';
 render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'New Invoice' }));
 const rate = await screen.findByLabelText('Invoice tax rate (%)');
 fireEvent.change(rate, { target: { value: '20' } });
 fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), { target: { value: 'Buyer' } });
 fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Work' } });
 fireEvent.change(screen.getByPlaceholderText('Price'), { target: { value: '10' } });
 expect(screen.queryByLabelText('Tax treatment')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
 await waitFor(() => expect(fetcher.mock.calls.some(([,options]) => options?.method === 'POST')).toBe(true));
 const call = fetcher.mock.calls.find(([,options]) => options?.method === 'POST')!;
 const payload = JSON.parse((call[1] as { body: string }).body);
 expect(payload).toMatchObject({ currency, tax_rate: 20 });
 expect(payload).not.toHaveProperty('tax_version'); expect(payload).not.toHaveProperty('tax_config');
});

it('blocks inherited-tax preview and save when settings fail, without blocking legacy currencies', async () => {
 fetcher.mockImplementation(async (url: string) => ({ ok: !url.includes('tax-settings'), json: async () => ({ invoices: [] }) }));
 render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'New Invoice' }));
 await screen.findByRole('alert');
 fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), { target: { value: 'Buyer' } });
 fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Work' } });
 expect((screen.getByRole('button', { name: 'Create Invoice' }) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByText('Before tax (after discounts)')).toBeNull();
});
it('ignores an old business response after switching and waits for the current default', async () => {
 const resolvers = new Map<string, (value: unknown) => void>();
 fetcher.mockImplementation((url: string) => url.includes('tax-settings')
   ? new Promise(resolve => resolvers.set(url, resolve))
   : Promise.resolve({ ok: true, json: async () => ({ invoices: [] }) }));
 const view = render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'New Invoice' }));
 h.id='business-b'; view.rerender(<InvoicesPage />);
 await act(async () => { resolvers.get('/api/businesses/business/tax-settings')!({ ok: true, json: async () => ({ settings: { enabled: true, label: 'Old tax', rate_bps: 500, price_mode: 'exclusive' } }) }); });
 expect(screen.getByText('Loading business tax settings…')).toBeTruthy();
 expect(screen.queryByText(/Business default: Old tax/)).toBeNull();
 await act(async () => { resolvers.get('/api/businesses/business-b/tax-settings')!({ ok: true, json: async () => ({ settings: { enabled: true, label: 'Current tax', rate_bps: 1200, price_mode: 'exclusive' } }) }); });
 await screen.findByText('Business default: Current tax 12% (exclusive)');
});
it('legacy currency remains usable when new merchant tax settings cannot load', async () => {
 h.currency='EUR'; h.country='FR';
 fetcher.mockImplementation(async (url: string) => ({ ok: !url.includes('tax-settings'), json: async () => ({ invoices: [] }) }));
 render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'New Invoice' }));
 await screen.findByLabelText('Invoice tax rate (%)');
 fireEvent.change(screen.getByPlaceholderText('e.g. John Doe'), { target: { value: 'Buyer' } });
 fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Work' } });
 expect((screen.getByRole('button', { name: 'Create Invoice' }) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByRole('alert')).toBeNull();
});
it('edits an existing EUR invoice using its own legacy rate while UK merchant tax is enabled', async () => {
 const invoice = { id: 'eur-invoice', reference_code: 'EUR-1', customer_name: 'Buyer', status: 'draft', currency: 'EUR', tax_rate: 20,
   tax_amount: 2, total_amount: 12, amount_paid: 0, subtotal: 10, discount_type: null, discount_value: 0, discount_amount: 0,
   created_at: '2026-11-11', issue_date: '2026-11-11', tax_snapshot: null,
   invoice_items: [{ description: 'Work', quantity: 1, unit_price: 10, amount: 10, sort_order: 0 }] };
 fetcher.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('tax-settings')
   ? { settings: { enabled: true, label: 'UK tax', rate_bps: 887.5, price_mode: 'exclusive' } }
   : { invoices: [invoice] } }));
 render(<InvoicesPage />); fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
 expect((await screen.findByLabelText('Invoice tax rate (%)') as HTMLInputElement).value).toBe('20');
 fireEvent.change(screen.getByPlaceholderText('Qty'), { target: { value: '2' } });
 fireEvent.click(screen.getByRole('button', { name: 'Update Invoice' }));
 await waitFor(() => expect(fetcher.mock.calls.some(([,options]) => options?.method === 'PUT')).toBe(true));
 const call = fetcher.mock.calls.find(([,options]) => options?.method === 'PUT')!;
 const payload = JSON.parse((call[1] as { body: string }).body);
 expect(payload).toMatchObject({ currency: 'EUR', tax_rate: 20 });
 expect(payload).not.toHaveProperty('tax_config'); expect(payload).not.toHaveProperty('tax_version');
});
