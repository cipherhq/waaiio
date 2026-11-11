/**
 * #889: shared receipt line-item lookups and the order case of the #381 balance rule.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadInvoiceLineItems, loadTicketLine, toOrderLineItems } from '@/lib/receipts/line-items';
import { getEntityBalance } from '@/lib/payments/entity-balance';

function fakeDb(byTable: Record<string, { data: unknown; error?: unknown }>) {
  const eqCalls: Array<[string, string, unknown]> = [];
  const db = {
    eqCalls,
    from: vi.fn((table: string) => {
      const res = byTable[table] ?? { data: null };
      const c: any = {};
      c.select = vi.fn(() => c);
      c.order = vi.fn(() => c);
      c.eq = vi.fn((col: string, val: unknown) => { eqCalls.push([table, col, val]); return c; });
      c.maybeSingle = vi.fn(async () => ({ data: res.data, error: res.error ?? null }));
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: res.data, error: res.error ?? null }).then(resolve);
      return c;
    }),
  };
  return db;
}

describe('toOrderLineItems', () => {
  it('names each product with its variant and multiplies the line total', () => {
    expect(toOrderLineItems([
      { variant_label: 'Red', quantity: 2, unit_price: 1500, products: { name: 'T-shirt' } },
      { quantity: 1, unit_price: 700, products: null },
      { quantity: 0, unit_price: 9, products: { name: 'Nothing' } },
    ])).toEqual([
      { name: 'T-shirt (Red)', quantity: 2, unitPrice: 1500, lineTotal: 3000 },
      { name: 'Item', quantity: 1, unitPrice: 700, lineTotal: 700 },
    ]);
  });

  it('anything that is not a list gives no items', () => {
    expect(toOrderLineItems(null)).toEqual([]);
    expect(toOrderLineItems({})).toEqual([]);
  });
});

describe('loadInvoiceLineItems', () => {
  it('reads the invoice lines in order, using the stored amount', async () => {
    const db = fakeDb({ invoice_items: { data: [{ description: 'Design', quantity: '2', unit_price: '100.50', amount: '201.00' }] } });
    expect(await loadInvoiceLineItems(db as any, 'inv-1')).toEqual([{ name: 'Design', quantity: 2, unitPrice: 100.5, lineTotal: 201 }]);
    expect(db.eqCalls).toContainEqual(['invoice_items', 'invoice_id', 'inv-1']);
  });

  it('a failed lookup gives no items, so the receipt still goes out', async () => {
    const db = fakeDb({ invoice_items: { data: null, error: { message: 'boom' } } });
    expect(await loadInvoiceLineItems(db as any, 'inv-1')).toEqual([]);
  });
});

describe('loadTicketLine', () => {
  it('uses the ticket type name when issuance state exists', async () => {
    const db = fakeDb({ events: { data: { name: 'Gala' } }, event_ticket_issuance_state: { data: { quantity: 3, event_ticket_types: { name: 'Regular' } } } });
    expect(await loadTicketLine(db as any, { id: 'bk', event_id: 'ev', quantity: 3, total_amount: 9000 })).toEqual({
      eventName: 'Gala', items: [{ name: 'Regular', quantity: 3, unitPrice: 3000, lineTotal: 9000 }],
    });
  });

  it('falls back to the event name; no event means no line', async () => {
    const db = fakeDb({ events: { data: { name: 'Gala' } }, event_ticket_issuance_state: { data: null } });
    expect((await loadTicketLine(db as any, { id: 'bk', event_id: 'ev', quantity: 1, total_amount: 500 })).items)
      .toEqual([{ name: 'Gala', quantity: 1, unitPrice: 500, lineTotal: 500 }]);
    expect(await loadTicketLine(db as any, { id: 'bk', event_id: null, quantity: 1, total_amount: 500 })).toEqual({ eventName: null, items: [] });
  });

  it('lookup errors give no line', async () => {
    const db = fakeDb({ events: { data: null, error: { message: 'x' } }, event_ticket_issuance_state: { data: null, error: { message: 'y' } } });
    expect(await loadTicketLine(db as any, { id: 'bk', event_id: 'ev', quantity: 2, total_amount: 500 })).toEqual({ eventName: null, items: [] });
  });
});

describe('getEntityBalance for orders (#889, same #381 rule)', () => {
  it('counts successful order payments minus refunds', async () => {
    const db = fakeDb({ payments: { data: [{ amount: 4000, refund_amount: 0 }, { amount: 1000, refund_amount: 500 }] } });
    expect(await getEntityBalance(db as any, { orderId: 'o1', totalAmount: 10000 })).toEqual({ totalAmount: 10000, netPaid: 4500, balanceDue: 5500 });
    expect(db.eqCalls).toContainEqual(['payments', 'order_id', 'o1']);
  });

  it('more than one entity is refused, as before', async () => {
    const db = fakeDb({});
    expect(await getEntityBalance(db as any, { orderId: 'o1', bookingId: 'b1', totalAmount: 1 })).toBeNull();
  });
});
