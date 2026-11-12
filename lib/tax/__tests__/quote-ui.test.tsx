// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { calculateTaxQuote } from '../calculation';
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'business', country_code: 'UK' }) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({ select() { return this; }, eq() { return this; }, order() { return this; },
 limit: async () => ({ data: [{ id: 'quote', status: 'pending', customer_name: 'Buyer', created_at: '2026-11-11', estimated_subtotal: 10,
 cart_snapshot: [{ product_id: 'p', name: 'Cake', quantity: 1, price: 10 }], addons_snapshot: [] }] }) }) }) }));
import QuotesPage from '@/app/dashboard/orders/quotes/page';
const snapshot = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', [{ id: 'item-0', description: 'Cake', quantity: 1, unitAmount: 1000 }]);
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ quoted_amount: 11, tax_snapshot: snapshot }) }); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('reviews server tax before sending and invalidates review when price changes', async () => {
 render(<QuotesPage />); fireEvent.click(await screen.findByText('Buyer'));
 fireEvent.click(screen.getByRole('button', { name: 'Review Price and Tax' }));
 await screen.findByRole('button', { name: 'Confirm and Send Price' });
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ preview: true, quoted_items: [{ unit_price: 10, product_id: 'p' }] });
 expect(screen.getByText(/Customer total:/).textContent).toContain('11');
 fireEvent.change(screen.getByLabelText('Unit price 1'), { target: { value: '20' } });
 await screen.findByRole('button', { name: 'Review Price and Tax' });
 fireEvent.click(screen.getByRole('button', { name: 'Review Price and Tax' }));
 fireEvent.click(await screen.findByRole('button', { name: 'Confirm and Send Price' }));
 await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
 expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ preview: false, expected_tax_snapshot: snapshot });
});
