import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/adminApi', () => ({ adminApiGet: f.get }));
import Orders from '@/pages/Orders';
const order = { id: '11111111-1111-4111-8111-111111111111', business_id: 'business', user_id: 'customer', business_name: 'Test store', customer_name: 'Test Customer', customer_email: 'test@example.invalid', status: 'confirmed', total_amount: 125, shipping_cost: 25, delivery_phone: '+12025550123', currency: 'USD', items_count: 1, created_at: '2026-11-11T12:00:00Z' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { f.get.mockReset(); f.get.mockImplementation(async (url: string) => reply(url.includes('?') ? { data: { ...order, items: [{ id: 'line', product_name: 'Widget', quantity: 2, unit_price: 50, variant_label: 'Blue', addons: [{ name: 'Wrap', price: 2, quantity: 3 }] }] } } : { data: [order], truncated: false })); });
afterEach(cleanup);
it('shows canonical amounts and full detail without adding delivery twice', async () => {
 render(<Orders />); fireEvent.click(await screen.findByRole('cell', { name: 'Test store' }));
 await screen.findByText('1. Widget');
 expect(screen.getByText('test@example.invalid')).toBeInTheDocument();
 expect(screen.getAllByText('$125')).toHaveLength(2);
 expect(screen.queryByText('$150')).not.toBeInTheDocument();
 expect(screen.getByText('Shipping / delivery (included)')).toBeInTheDocument();
 expect(screen.getByText('Base line: $100')).toBeInTheDocument();
 expect(screen.getByText('Blue')).toBeInTheDocument();
 expect(screen.getByText('+12025550123')).toBeInTheDocument();
 expect(screen.getByText('Add-on: Wrap × 3 · $2')).toBeInTheDocument();
 expect(f.get).toHaveBeenCalledWith(`/api/admin/orders?orderId=${order.id}`);
});
it('does not show a failed list as no orders and retries', async () => {
 f.get.mockResolvedValueOnce(reply({ error: 'Unavailable' }, 503)); render(<Orders />);
 await screen.findByRole('alert'); expect(screen.queryByText('No orders found')).not.toBeInTheDocument();
 fireEvent.click(screen.getByText('Retry loading orders')); await screen.findByRole('cell', { name: 'Test store' });
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('reports detail errors rather than zero items', async () => {
 render(<Orders />); await screen.findByRole('cell', { name: 'Test store' });
 f.get.mockResolvedValueOnce(reply({ error: 'Read failed' }, 503)); fireEvent.click(screen.getByRole('cell', { name: 'Test store' }));
 await screen.findByText('Read failed'); expect(screen.queryByText('No items found')).not.toBeInTheDocument();
});
it('discloses capped data and unknown currency without NGN guessing', async () => {
 f.get.mockResolvedValue(reply({ data: [{ ...order, currency: null }], truncated: true })); render(<Orders />);
 await screen.findByText(/Showing the latest 500 orders/);
 expect(screen.getByText('125 (currency unavailable)')).toBeInTheDocument();
});
it('ignores a detail response after closing the modal', async () => {
 render(<Orders />); await screen.findByRole('cell', { name: 'Test store' });
 let resolve!: (response: Response) => void; f.get.mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }));
 fireEvent.click(screen.getByRole('cell', { name: 'Test store' })); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
 resolve(reply({ data: { ...order, items: [] } }));
 await waitFor(() => expect(screen.queryByText('Order Details')).not.toBeInTheDocument());
});
