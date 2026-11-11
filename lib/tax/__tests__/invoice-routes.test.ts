import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { calculateTaxQuote } from '../calculation';
import { quoteAcceptButtonId } from '../quote-acceptance';
const h = vi.hoisted(() => ({ user: true, owned: true, allowed: true, fail: false, preview: false, filters: [] as unknown[], rpc: vi.fn(), send: vi.fn(), snapshot: {} as unknown }));
const db = vi.hoisted(() => ({
  auth: { getUser: async () => ({ data: { user: h.user ? { id: 'owner' } : null } }) },
  from: (table: string) => ({
    select() { return this; }, eq(key: string, value: unknown) { h.filters.push([table, key, value]); return this; },
    maybeSingle: async () => ({ data: h.owned ? { id: 'business', subscription_tier: 'pro' } : null }),
    single: async () => ({ data: table === 'quote_requests' ? { id: 'quote', business_id: 'business', status: 'pending', customer_phone: '+441234', customer_name: 'Buyer' } : table === 'invoices' ? { id: 'invoice', business_id: 'business', status: 'draft' } : { name: 'Shop', country_code: 'UK' } }),
  }),
  rpc: (...args: unknown[]) => h.rpc(...args),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));
vi.mock('@/lib/tier-limits', () => ({ checkTierLimit: async () => ({ allowed: h.allowed, limit: 10 }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'test' }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => h.owned ? { userId: 'owner' } : NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/bot/conversation-guard', () => ({ checkConversationLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ invoice_expiry_days: 30 }) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: h.send }));
vi.mock('@/lib/email/templates', () => ({ invoiceEmail: () => '' }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { async resolveByBusinessId() { return { sender: { sendText: h.send, sendButtons: h.send } }; } } }));
import { POST as createInvoice } from '@/app/api/invoices/route';
import { PUT as updateInvoice } from '@/app/api/invoices/[id]/route';
import { POST as sendInvoice } from '@/app/api/invoices/send/route';
import { POST as respondQuote } from '@/app/api/orders/quote-respond/route';
const req = (body: unknown) => new NextRequest('http://localhost/api/test', { method: 'POST', body: JSON.stringify(body) });
const body = { business_id: 'business', customer_name: 'Buyer', items: [{ description: 'Work', quantity: 1, unit_price: 10 }], tax_version: 1 };
beforeEach(() => {
  h.user = true; h.owned = true; h.allowed = true; h.filters = []; h.send.mockReset(); h.rpc.mockReset();
  h.snapshot = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', [{ id: 'i', description: 'Work', quantity: 1, unitAmount: 1000 }]);
  h.rpc.mockResolvedValue({ data: { id: 'invoice', quoted_amount: 11, tax_snapshot: h.snapshot }, error: null });
});
it('invoice authenticates and checks tenant and tier before atomic write', async () => {
  h.user = false; expect((await createInvoice(req(body))).status).toBe(401);
  h.user = true; h.owned = false; expect((await createInvoice(req(body))).status).toBe(403);
  h.owned = true; h.allowed = false; expect((await createInvoice(req(body))).status).toBe(429);
  expect(h.rpc).not.toHaveBeenCalled();
});
it('invoice delegates amount authority and line persistence to the atomic RPC', async () => {
  expect((await createInvoice(req({ ...body, total_amount: 0 }))).status).toBe(201);
  expect(h.rpc).toHaveBeenCalledWith('save_invoice_tax_980', { p_business_id: 'business', p_invoice_id: null, p_body: { ...body, total_amount: 0 } });
  expect((await updateInvoice(req(body), { params: Promise.resolve({ id: 'invoice' }) })).status).toBe(200);
  expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_business_id: 'business', p_invoice_id: 'invoice' });
});
it('failed quote authority never sends a notification', async () => {
  h.rpc.mockResolvedValue({ data: null, error: { message: 'quote_tax_terms_changed' } });
  expect((await respondQuote(req({ business_id: 'business', quote_id: 'quote', quoted_items: [{}] }))).status).toBe(400);
  expect(h.send).not.toHaveBeenCalled();
});
it('quote preview is read-only and confirmed send uses saved totals rather than injected gross', async () => {
  const q = { business_id: 'business', quote_id: 'quote', quoted_items: [{}], quoted_amount: 999, expected_tax_snapshot: h.snapshot };
  expect((await respondQuote(req({ ...q, preview: true }))).status).toBe(200);
  expect(h.send).not.toHaveBeenCalled();
  expect((await respondQuote(req(q))).status).toBe(200);
  expect(h.rpc.mock.calls[1][1]).toMatchObject({ p_expected_snapshot: h.snapshot, p_preview: false });
  expect(h.send.mock.calls[0][0].text).toContain('Before tax:');
  expect(h.send.mock.calls[0][0].text).not.toContain('999');
});
it('quote rejects tenant before privileged RPC', async () => {
  h.owned = false;
  expect((await respondQuote(req({ business_id: 'business', quote_id: 'quote', quoted_items: [{}] }))).status).toBe(403);
  expect(h.rpc).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
});

it('invoice send stops before provider dispatch when reviewed terms cannot be frozen', async () => {
 h.rpc.mockResolvedValue({ data: null, error: { message: 'invoice_tax_terms_changed' } });
 expect((await sendInvoice(req({ invoice_id: 'invoice', expected_tax_snapshot: h.snapshot }))).status).toBe(409);
 expect(h.rpc).toHaveBeenCalledWith('freeze_invoice_tax_terms_980', { p_business_id: 'business', p_invoice_id: 'invoice', p_expected_snapshot: h.snapshot });
 expect(h.send).not.toHaveBeenCalled();
});
it('invoice send still requires authenticated owner access, without an internal-token bypass', async () => {
 h.user = false;
 expect((await sendInvoice(req({ invoice_id: 'invoice' }))).status).toBe(401);
 expect(h.rpc).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
});

it.each(['GHS', 'EUR'])('forwards legacy %s single-rate create and update terms without dropping tax', async currency => {
 const legacy = { ...body, tax_version: undefined, currency, tax_rate: 20, discount_type: 'flat', discount_value: 2 };
 expect((await createInvoice(req(legacy))).status).toBe(201);
 expect(h.rpc.mock.calls[0][1].p_body).toMatchObject({ currency, tax_rate: 20, discount_value: 2 });
 expect(h.rpc.mock.calls[0][1].p_body).not.toHaveProperty('tax_config');
 expect((await updateInvoice(req(legacy), { params: Promise.resolve({ id: 'invoice' }) })).status).toBe(200);
 expect(h.rpc.mock.calls[1][1].p_body).toMatchObject({ currency, tax_rate: 20 });
});

it('customer accept button binds the exact committed quote snapshot, not the request preview', async () => {
 const quoteId = '00000000-0000-4000-8000-000000000980';
 expect((await respondQuote(req({ business_id: 'business', quote_id: quoteId, quoted_items: [{}], expected_tax_snapshot: { stale: true } }))).status).toBe(200);
 const buttons = h.send.mock.calls.find(([payload]) => payload.buttons)?.[0].buttons;
 expect(buttons).toEqual([
   { id: quoteAcceptButtonId(quoteId, h.snapshot), title: 'Accept' },
   { id: `reject_quote_${quoteId}`, title: 'Decline' },
 ]);
 expect(buttons[0].id.length).toBeLessThanOrEqual(200);
});
