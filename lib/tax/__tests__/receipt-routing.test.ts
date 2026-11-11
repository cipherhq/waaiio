import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { calculateTaxQuote } from '../calculation';
const h = vi.hoisted(() => ({ rows: {} as Record<string, unknown>, queries: [] as Array<{ table: string; columns: string; filters: unknown[] }>, pdf: vi.fn() }));
vi.mock('@/lib/pdf/receipt-generator', () => ({ generateReceiptPdf: (...args: unknown[]) => h.pdf(...args), generateHistoryPdf: vi.fn(), generateAnnualStatementPdf: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  from(table: string) {
    const q = { table, columns: '', filters: [] as unknown[] }; h.queries.push(q);
    const result = () => ({ data: typeof h.rows[table] === 'function' ? (h.rows[table] as (query: typeof q) => unknown)(q) : h.rows[table] ?? null, error: null });
    const chain = {
      select(columns: string) { q.columns = columns; return chain; },
      eq(column: string, value: unknown) { q.filters.push([column, value]); return chain; },
      in(column: string, value: unknown) { q.filters.push([column, value]); return chain; },
      or() { return chain; }, order() { return chain; }, limit() { return chain; },
      single: async () => result(), maybeSingle: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    }; return chain;
  },
  storage: { from: () => ({ upload: async () => ({ error: null }), createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null }) }) },
}) }));
import { generateDocumentDirect } from '@/lib/receipts/generate-direct';
import { POST } from '@/app/api/receipts/generate/route';
const snapshot = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', [{ id: 'item', description: 'Original item', quantity: 1, unitAmount: 1000 }]);
const allocation = { version: 1, currency: 'GBP', netAmount: 500, taxAmount: 50, grossAmount: 550, lines: [{ id: 'item', netAmount: 500, taxAmount: 50, grossAmount: 550 }] };
const business = { name: 'Shop', country_code: 'UK', subscription_tier: 'free' };
beforeEach(() => {
  h.rows = { profiles: { id: 'customer', first_name: 'Customer', phone: '+441234567890' } }; h.queries = [];
  h.pdf.mockReset().mockResolvedValue(Buffer.from('%PDF'));
  vi.stubEnv('INTERNAL_API_TOKEN', 'internal-test-token');
});
afterEach(() => vi.unstubAllEnvs());
const internalRequest = () => new NextRequest('http://localhost/api/receipts/generate', { method: 'POST', headers: { 'x-internal-token': 'internal-test-token' }, body: JSON.stringify({ userId: 'customer', phone: '+441234567890', type: 'receipt' }) });

it('direct order receipt keeps the original item and net collected tax after a finalized refund', async () => {
  h.rows.orders = { id: 'order', business_id: 'business', tax_snapshot: snapshot, reference_code: 'ORDER', total_amount: 11, status: 'delivered', created_at: '2026-11-11', businesses: business,
    order_items: [{ quantity: 1, unit_price: 999, products: { name: 'Changed catalog name' } }] };
  h.rows.payments = (q: { columns: string }) => q.columns === 'id, tax_allocation' ? [{ id: 'payment', tax_allocation: allocation }]
    : q.columns === 'amount, refund_amount' ? [{ amount: 5.5, refund_amount: 2.2 }] : null;
  h.rows.refunds = [{ tax_allocation: { ...allocation, netAmount: 200, taxAmount: 20, grossAmount: 220, lines: [{ id: 'item', netAmount: 200, taxAmount: 20, grossAmount: 220 }] } }];
  expect(await generateDocumentDirect('customer', 'receipt', '+441234567890')).not.toBeNull();
  expect(h.pdf.mock.calls[0][0]).toMatchObject({ amount: 3.3, totalDue: 11, balanceDue: 7.7,
    items: [{ name: 'Original item', lineTotal: 11 }], tax: { refundsApplied: true, allocations: [{ grossAmount: 330, taxAmount: 30 }] } });
  const refundQuery = h.queries.find(q => q.table === 'refunds')!;
  expect(refundQuery.filters).toContainEqual(['business_id', 'business']);
  expect(refundQuery.filters).toContainEqual(['status', 'success']);
});

it('internal payment receipt uses its saved deposit allocation and scopes the original sale by business', async () => {
  h.rows.payments = { id: 'payment', business_id: 'business', booking_id: 'booking', tax_allocation: allocation, currency: 'GBP', gateway_reference: 'PAY', amount: 5.5, status: 'success', created_at: '2026-11-11', businesses: business };
  h.rows.bookings = (q: { columns: string }) => q.columns === 'tax_snapshot' ? { tax_snapshot: snapshot } : q.columns === 'services(name)' ? { services: { name: 'Changed service name' } } : null;
  expect((await POST(internalRequest())).status).toBe(200);
  expect(h.pdf.mock.calls[0][0]).toMatchObject({ amount: 5.5, serviceName: 'Original item', currencyCode: 'GBP', tax: { allocations: [allocation] } });
  expect(h.queries.find(q => q.columns === 'tax_snapshot')?.filters).toContainEqual(['business_id', 'business']);
});

it('internal receipt refuses malformed tax rather than printing a legacy receipt', async () => {
  h.rows.invoices = { id: 'invoice', business_id: 'business', tax_snapshot: { ...snapshot, taxAmount: 999 }, total_amount: 11, status: 'paid', created_at: '2026-11-11', paid_at: '2026-11-11', businesses: business };
  expect((await POST(internalRequest())).status).toBe(500);
  expect(h.pdf).not.toHaveBeenCalled();
});

it('internal authentication still precedes every database query', async () => {
  expect((await POST(new NextRequest('http://localhost/api/receipts/generate', { method: 'POST', body: '{}' }))).status).toBe(401);
  expect(h.queries).toEqual([]);
});
