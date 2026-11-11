// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductsPage from '@/app/dashboard/products/page';
const state = vi.hoisted(() => ({ writes: [] as Record<string, unknown>[], fail: false }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business-tax', country_code: 'NG', category: 'retail' }), useCapabilities: () => ({ capabilities: [] }) }));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabelPlural: 'Customers' } }) }));
vi.mock('@/lib/observability/product-events', () => ({ captureProductEvent: vi.fn() }));
vi.mock('@/app/dashboard/products/components/ProductList', async () => {
  const { EMPTY_PRODUCT } = await import('@/app/dashboard/products/components/types');
  return { default: ({ openEdit }: { openEdit: (product: unknown) => void }) => <button onClick={() => openEdit({ ...EMPTY_PRODUCT, id: 'product-tax', name: 'Test product', price: 100 })}>Edit product</button> };
});
vi.mock('next/image', () => ({ default: ({ fill: _fill, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean }) => <img {...props} /> }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({
  from: (table: string) => {
    let writing = false;
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
      delete: () => chain,
      update: (payload: Record<string, unknown>) => { writing = true; if (table === 'products') state.writes.push(payload); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], count: 0, error: writing && state.fail ? { message: 'tax settings rejected' } : null }).then(resolve),
    };
    return chain;
  },
}) }));
beforeEach(() => {
  state.writes = []; state.fail = false;
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function edit() {
  render(<ProductsPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit product' }));
  await screen.findByRole('heading', { name: 'Edit Product' });
}
it('preserves omitted tax on an ordinary product edit', async () => {
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(Object.keys(state.writes[0]).filter(key => key.startsWith('tax_'))).toEqual([]);
});
it('sends the selected item tax with the actual product update', async () => {
  await edit();
  fireEvent.change(screen.getByLabelText('Tax treatment'), { target: { value: 'override' } });
  fireEvent.change(screen.getByLabelText('Tax name'), { target: { value: 'VAT' } });
  fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '7.5' } });
  fireEvent.change(screen.getByLabelText('Listed price'), { target: { value: 'inclusive' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(state.writes).toHaveLength(1));
  expect(state.writes[0]).toMatchObject({ business_id: 'business-tax', tax_treatment: 'override', tax_label: 'VAT', tax_rate_bps: 750, tax_price_mode: 'inclusive' });
});
it('keeps the form open when the database rejects tax instead of pretending it saved', async () => {
  state.fail = true;
  await edit();
  fireEvent.change(screen.getByLabelText('Tax treatment'), { target: { value: 'exempt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(window.alert).toHaveBeenCalled());
  expect(screen.getByRole('heading', { name: 'Edit Product' })).toBeTruthy();
  expect((screen.getByLabelText('Tax treatment') as HTMLSelectElement).value).toBe('exempt');
});
