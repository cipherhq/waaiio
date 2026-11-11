import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateTaxQuote } from '../calculation';
import { parseQuoteResponseButton, quoteAcceptButtonId, quoteAcceptanceDigest } from '../quote-acceptance';
const h = vi.hoisted(() => ({ payment: vi.fn() }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: h.payment }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return null; } } }));
import { handleQuoteResponse } from '@/lib/bot/handlers/quote-response';
const id = '00000000-0000-4000-8000-000000000980';
const from = '15550000001';
const snapshot = (enabled: boolean) => calculateTaxQuote({ enabled, label: 'Tax', rateBps: 750, priceMode: 'exclusive' }, 'USD', [{ id: 'work', description: 'Work', quantity: 1, unitAmount: 1000 }]);
function fixture(snap: unknown, options: { phone?: string; error?: string; result?: Record<string, unknown>; paid?: boolean } = {}) {
 const send = vi.fn(async (_to: string, _text: string) => {});
 const rpc = vi.fn(async () => ({ data: options.result ?? { accepted: true, order_id: 'order', reference_code: 'O980', total: 10.75, business_id: 'business', customer_phone: from }, error: options.error ? { message: options.error } : null }));
 const db = { rpc, from: (table: string) => {
   const row = table === 'quote_requests' ? { tax_snapshot: snap, customer_phone: options.phone ?? `+${from}` }
     : table === 'businesses' ? { id: 'business', name: 'Shop', country_code: 'US' }
     : table === 'payments' ? (options.paid ? { id: 'paid' } : null) : { id: 'customer' };
   const chain = { select: () => chain, eq: () => chain, limit: () => chain,
     single: async () => ({ data: row, error: null }), maybeSingle: async () => ({ data: row, error: null }) };
   return chain;
 } };
 return { db, rpc, send };
}
beforeEach(() => { h.payment.mockReset().mockResolvedValue({ url: 'https://pay.example/980' }); });
describe('actual quote response handler', () => {
 it.each([true, false])('accepts customer-confirmed itemized quote (tax enabled=%s)', async enabled => {
   const snap = snapshot(enabled), f = fixture(snap);
   const button = parseQuoteResponseButton(quoteAcceptButtonId(id, snap))!;
   await handleQuoteResponse(f.db as never, f.send, from, button.quoteId, button.action, button.digest);
   expect(f.rpc).toHaveBeenCalledWith('accept_order_quote_atomic', { p_quote_id: id, p_customer_phone: from, p_expected_tax_snapshot: snap });
   expect(h.payment).toHaveBeenCalledTimes(1);
   expect(f.send.mock.calls[0][1]).toContain('Price Accepted');
 });
 it('keeps legacy buttons valid only for quotes with no snapshot', async () => {
   const f = fixture(null);
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept');
   expect(f.rpc).toHaveBeenCalledWith('accept_order_quote_atomic', { p_quote_id: id, p_customer_phone: from, p_expected_tax_snapshot: null });
   expect(h.payment).toHaveBeenCalledTimes(1);
 });
 it.each(['missing', 'stale'])('requires new customer confirmation for %s snapshot binding', async kind => {
   const f = fixture(snapshot(true));
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', kind === 'missing' ? undefined : quoteAcceptanceDigest(id, snapshot(false)));
   expect(f.rpc).not.toHaveBeenCalled(); expect(h.payment).not.toHaveBeenCalled();
   expect(f.send.mock.calls[0][1]).toContain('review it before accepting');
 });
 it('does not substitute changed terms when the database detects a concurrent change', async () => {
   const snap = snapshot(true), f = fixture(snap, { error: 'tax_terms_changed' });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(f.rpc).toHaveBeenCalledTimes(1); expect(h.payment).not.toHaveBeenCalled();
   expect(f.send.mock.calls[0][1]).toContain('review it before accepting');
 });
 it('rejects a different customer before accepting or exposing quote details', async () => {
   const snap = snapshot(true), f = fixture(snap, { phone: '15550000002' });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(f.rpc).not.toHaveBeenCalled(); expect(h.payment).not.toHaveBeenCalled();
   expect(f.send.mock.calls[0][1]).toContain('different number');
 });
 it('honors the atomic identity check if identity changes after the read', async () => {
   const snap = snapshot(true), f = fixture(snap, { result: { accepted: false, reason: 'identity_mismatch' } });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(h.payment).not.toHaveBeenCalled(); expect(f.send.mock.calls[0][1]).toContain('different number');
 });
 it('replay of accepted paid quote does not initialize another payment', async () => {
   const snap = snapshot(true), f = fixture(snap, { paid: true, result: { accepted: true, already_accepted: true, order_id: 'order', business_id: 'business', reference_code: 'O980', customer_phone: from, total: 10.75 } });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(f.rpc).toHaveBeenCalledTimes(1); expect(h.payment).not.toHaveBeenCalled();
   expect(f.send.mock.calls[0][1]).toContain('already paid');
 });
 it('accepted unpaid replay recovers payment with the same committed order', async () => {
   const snap = snapshot(true), f = fixture(snap, { result: { accepted: true, already_accepted: true, order_id: 'order', business_id: 'business', reference_code: 'O980', customer_phone: from, total: 10.75 } });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(h.payment).toHaveBeenCalledTimes(1);
   expect(h.payment.mock.calls[0][1]).toMatchObject({ orderId: 'order', amount: 10.75 });
 });
 it('does not initialize payment for an expired quote', async () => {
   const snap = snapshot(true), f = fixture(snap, { result: { accepted: false, reason: 'expired' } });
   await handleQuoteResponse(f.db as never, f.send, from, id, 'accept', quoteAcceptanceDigest(id, snap));
   expect(h.payment).not.toHaveBeenCalled(); expect(f.send.mock.calls[0][1]).toContain('expired');
 });
 it('keeps rejection payload unchanged', async () => {
   const f = fixture(snapshot(true), { result: { rejected: false, reason: 'identity_mismatch' } });
   const button = parseQuoteResponseButton(`reject_quote_${id}`)!;
   await handleQuoteResponse(f.db as never, f.send, from, button.quoteId, button.action, button.digest);
   expect(f.rpc).toHaveBeenCalledWith('reject_order_quote_atomic', { p_quote_id: id, p_customer_phone: from });
   expect(h.payment).not.toHaveBeenCalled();
 });
});
it('canonical digest retains values/line order and ignores JSONB object-key order', () => {
 expect(quoteAcceptanceDigest(id, { a: 1, b: [{ x: 2, y: 3 }] })).toBe(quoteAcceptanceDigest(id, { b: [{ y: 3, x: 2 }], a: 1 }));
 expect(quoteAcceptanceDigest(id, [1, 2])).not.toBe(quoteAcceptanceDigest(id, [2, 1]));
 expect(quoteAcceptanceDigest(id, { a: 1 })).not.toBe(quoteAcceptanceDigest(id, { a: 2 }));
 expect(parseQuoteResponseButton(`accept_quote_${id}_bad`)).toBeNull();
 expect(parseQuoteResponseButton(`reject_quote_${id}_${'a'.repeat(64)}`)).toBeNull();
});
