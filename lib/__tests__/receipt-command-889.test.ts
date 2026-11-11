/**
 * #889 Bug C: the on-demand "receipt" command (generateDocumentDirect → buildReceipt).
 * - a paid donation can be picked (campaigns has title, not name);
 * - a pending (unpaid) booking is never a receipt;
 * - the payment's or donation's own currency is used;
 * - payment receipts carry the business logo;
 * - order and ticket receipts list what was bought, and a part-paid booking shows the balance.
 * The fake database rejects columns that do not exist, as PostgREST rejects the whole select.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerate = vi.fn().mockResolvedValue(Buffer.from('%PDF'));
const mockGetEntityBalance = vi.fn();
let rows: Record<string, unknown> = {};
const queries: Array<{ table: string; cols: string; statusIn?: unknown[] }> = [];

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/pdf/receipt-generator', () => ({
  generateReceiptPdf: (...a: unknown[]) => mockGenerate(...a),
  generateHistoryPdf: vi.fn(), generateAnnualStatementPdf: vi.fn(),
}));
vi.mock('@/lib/payments/entity-balance', () => ({ getEntityBalance: (...a: unknown[]) => mockGetEntityBalance(...a) }));

const MISSING: Record<string, RegExp> = { campaign_donations: /campaigns:campaign_id\(name\b/ };

function from(table: string) {
  const q: { table: string; cols: string; statusIn?: unknown[] } = { table, cols: '' };
  queries.push(q);
  const c: Record<string, any> = {};
  const result = () => {
    if (MISSING[table]?.test(q.cols)) return { data: null, error: { message: 'column campaigns.name does not exist' } };
    const v = rows[table];
    const data = typeof v === 'function' ? (v as (q: unknown) => unknown)(q) : v ?? null;
    return { data, error: null };
  };
  ['eq', 'or', 'order', 'limit', 'gte', 'lte', 'lt'].forEach(m => { c[m] = vi.fn().mockReturnValue(c); });
  c.in = vi.fn((_col: string, vals: unknown[]) => { q.statusIn = vals; return c; });
  c.select = vi.fn((s: string) => { q.cols = s; return c; });
  c.single = vi.fn(async () => result());
  c.maybeSingle = vi.fn(async () => result());
  return c;
}

const supabase = {
  from: vi.fn(from),
  storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }), createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed' }, error: null }) }) },
};
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => supabase }));

const BIZ = { name: 'Mama Put', country_code: 'NG', subscription_tier: 'growth', logo_url: 'https://x/logo.png' };

/** A pending booking is filtered out by the status filter the caller sends. */
const bookingRow = (row: Record<string, unknown>) => (q: { statusIn?: string[] }) => (q.statusIn && !q.statusIn.includes(String(row.status)) ? null : row);

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  mockGetEntityBalance.mockResolvedValue(null);
  rows = { profiles: { id: 'u1', first_name: 'Ada', last_name: 'Eze', phone: '+234888' } };
});

async function run() {
  const { generateDocumentDirect } = await import('@/lib/receipts/generate-direct');
  const out = await generateDocumentDirect('u1', 'receipt', '+234888');
  return { out, data: mockGenerate.mock.calls[0]?.[0] };
}

describe('#889 "receipt" command', () => {
  it('a paid donation is found (campaign title) and printed in the donation currency', async () => {
    rows.campaign_donations = { id: 'd1', reference_code: 'DN-1', amount: 3000, currency: 'GHS', status: 'success', created_at: '2026-11-10T10:00:00Z', campaigns: { title: 'Roof Fund', businesses: BIZ } };
    const { out, data } = await run();
    expect(out).not.toBeNull();
    expect(data).toMatchObject({ serviceName: 'Roof Fund', amount: 3000, currencyCode: 'GHS', businessName: 'Mama Put' });
  });

  it('a pending booking is never the receipt (only completed/confirmed are asked for)', async () => {
    rows.bookings = bookingRow({ id: 'bk1', reference_code: 'WA-BK-1', status: 'pending', total_amount: 50000, created_at: '2026-11-10T10:00:00Z', services: { name: 'Haircut' }, businesses: BIZ });
    const { out } = await run();
    expect(out).toBeNull();
    for (const q of queries.filter(x => x.table === 'bookings')) expect(q.statusIn).not.toContain('pending');
  });

  it('a payment receipt carries the logo and the payment currency', async () => {
    rows.payments = { id: 'p1', gateway_reference: 'GW-1', amount: 1200, currency: 'USD', status: 'success', created_at: '2026-11-10T10:00:00Z', booking_id: null, businesses: BIZ };
    const { data } = await run();
    expect(data).toMatchObject({ amount: 1200, currencyCode: 'USD', logoUrl: 'https://x/logo.png' });
  });

  it('an order receipt lists its products', async () => {
    rows.orders = { id: 'o1', reference_code: 'WA-OR-1', status: 'delivered', total_amount: 5500, created_at: '2026-11-10T10:00:00Z', businesses: BIZ, order_items: [{ variant_label: 'Large', quantity: 2, unit_price: 2000, products: { name: 'Jollof Rice' } }, { quantity: 3, unit_price: 500, products: { name: 'Zobo' } }] };
    const { data } = await run();
    expect(data.items).toEqual([
      { name: 'Jollof Rice (Large)', quantity: 2, unitPrice: 2000, lineTotal: 4000 },
      { name: 'Zobo', quantity: 3, unitPrice: 500, lineTotal: 1500 },
    ]);
  });

  it('a part-paid confirmed booking shows what was paid and what is owed, not the full price as paid', async () => {
    rows.bookings = bookingRow({ id: 'bk2', reference_code: 'WA-BK-2', status: 'confirmed', total_amount: 50000, created_at: '2026-11-10T10:00:00Z', services: { name: 'Bridal Makeup' }, businesses: BIZ });
    mockGetEntityBalance.mockResolvedValue({ totalAmount: 50000, netPaid: 20000, balanceDue: 30000 });
    const { data } = await run();
    expect(mockGetEntityBalance).toHaveBeenCalledWith(expect.anything(), { bookingId: 'bk2', totalAmount: 50000 });
    expect(data).toMatchObject({ serviceName: 'Bridal Makeup', amount: 20000, totalDue: 50000, balanceDue: 30000 });
  });

  it('a ticket booking names the event and lists the tickets', async () => {
    rows.bookings = bookingRow({ id: 'bk3', reference_code: 'WA-TK-1', status: 'confirmed', total_amount: 20000, quantity: 2, event_id: 'ev1', created_at: '2026-11-10T10:00:00Z', services: null, businesses: BIZ });
    rows.events = { name: 'Lagos Jazz Night' };
    rows.event_ticket_issuance_state = null;
    const { data } = await run();
    expect(data.serviceName).toBe('Lagos Jazz Night');
    expect(data.items).toEqual([{ name: 'Lagos Jazz Night', quantity: 2, unitPrice: 10000, lineTotal: 20000 }]);
  });
});
